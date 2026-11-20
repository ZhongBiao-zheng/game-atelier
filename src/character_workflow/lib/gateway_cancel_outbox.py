"""成员端：停止请求补发（第 5 批 5-3）。

用户停止经局域网网关的任务时，网关连不上（或停止发生在任务正在等网关、没有线程在跑时），停止请求送不到主机。
这里把它记在任务上（`JobParams.gateway_cancel_pending`），连上主机后按幂等键补发：

- 主机没发上游的任务取消、扣 0；已发上游的照常跑完并计费（飙哥定 Q3-1=B）。任务文案按主机答复改。
- 标记只在主机答复后清（取消 / 继续执行 / 已结束 / 旧主机不支持）；连不上就保留，下一轮再试。
- 幂等键签发超过 20 小时不再补发：主机那边的任务已过保留期，补发没有意义。
- 结算（第 6 批 6-2a）：主机答「已发上游、会跑完」时任务记 `gateway_settlement=pending`，每轮按幂等键再问，
  主机到终态时把扣费回写到这条任务（同一把幂等键只记一次，见 `gateway_charges`），文案附「已扣 ¥x」。

后台线程只在有待补发的任务时运行，等待用 `threading.Event().wait`，没事可做就退出，关停时 `stop()` 立即结束。
"""
from __future__ import annotations

import logging
import threading

import requests

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 30.0

_guard = threading.Lock()
_thread: threading.Thread | None = None
_wake = threading.Event()
_stop = threading.Event()


def pending_job_ids() -> list[str]:
    from character_workflow.lib.jobs import gateway_key_expired, list_jobs
    from character_workflow.lib.schemas import JobStatus

    return [job.job_id for job in list_jobs()
            if job.status == JobStatus.CANCELED
            and (job.params.gateway_cancel_pending or job.params.gateway_settlement == "pending")
            and not gateway_key_expired(job.params.gateway_idempotency_key)]


def deliver_once(should_stop=lambda: False) -> bool:
    """把所有待补发的停止请求各发一次；返回之后是否还有待补发的。后台循环传入关停判断，关停时提前结束这一轮。"""
    for job_id in pending_job_ids():
        if should_stop():
            break
        try:
            _deliver(job_id)
        except Exception:  # noqa: BLE001 — 一条出错不影响其他，下一轮再试
            logger.warning("补发停止请求出错 job=%s", job_id, exc_info=True)
    return bool(pending_job_ids())


def _deliver(job_id: str) -> None:
    from character_workflow.lib import keys
    from character_workflow.lib.callers import atelier_gateway
    from character_workflow.lib.jobs import read_job

    job = read_job(job_id)
    key = keys.find_by_alias(job.alias or "")
    if key is None or key.provider != "atelier" or not key.base_url:
        _apply(job_id, {"cancel_outcome": "unsupported"})  # 供应商已删或改了：没法再送
        return
    try:
        body = atelier_gateway.cancel_by_key(key, job.params.gateway_idempotency_key or "",
                                             task_ids=job.params.provider_task_ids)
    except (requests.RequestException, atelier_gateway.GatewayError) as error:
        logger.info("停止请求暂时送不到主机 job=%s：%s", job_id, type(error).__name__)
        return
    _apply(job_id, body)


TERMINAL = frozenset({"done", "failed", "canceled"})


def _apply(job_id: str, body: dict) -> None:
    """按主机答复更新任务（持任务锁）。

    - 主机取消了（没发上游）：「已停止」，清所有标记。
    - 主机答「已发上游、会跑完」且还没终态：等结算（gateway_settlement=pending），下一轮再问。
    - 主机已到终态：结算——扣费 > 0 时按幂等键登记（gateway_charges，同一笔只记一次），登记到自己就记金额、
      文案附「已扣 ¥x」；被「再次生成」接回的那条先记了，就只指明记在哪条。成功出图的保留「结局未知」标记
      （再次生成仍可接回取图），失败 / 取消的清掉。
    - 旧主机不支持按键取消（unsupported）：清补发标记，文案不变。
    """
    from character_workflow.lib import gateway_charges
    from character_workflow.lib.job_runner import GATEWAY_CANCEL_CONTINUING
    from character_workflow.lib.jobs import job_lock, read_job, write_job_under_lock

    outcome = body.get("cancel_outcome")
    status = body.get("status")
    with job_lock(job_id):
        job = read_job(job_id)
        update: dict = {"gateway_cancel_pending": None}
        error = job.error
        if outcome == "canceled":
            update.update(gateway_unconfirmed=None, gateway_settlement=None)
            error = "已停止"
        elif outcome == "unsupported":
            update.update(gateway_settlement=None)
        elif status not in TERMINAL:
            update.update(gateway_unconfirmed=True, gateway_settlement="pending")
            error = GATEWAY_CANCEL_CONTINUING
        else:
            update.update(gateway_unconfirmed=True if status == "done" else None,
                          gateway_settlement="settled")
            base = GATEWAY_CANCEL_CONTINUING if status == "done" else "已停止"
            error = base
            charged = body.get("charged_cny")
            key = job.params.gateway_idempotency_key or ""
            if isinstance(charged, int | float) and charged > 0:
                holder = gateway_charges.claim(key, job_id)
                if holder == job_id:
                    update["actual_cost_cny"] = round(float(charged), 6)
                    error = f"{base}（已扣 ¥{charged:g}）"
                else:
                    update["gateway_charged_on"] = holder
                    error = f"{base}（费用记在再次生成的任务上）"
        write_job_under_lock(job.model_copy(update={
            "params": job.params.model_copy(update=update), "error": error}))
    logger.info("停止补发 / 结算已收到主机答复 job=%s outcome=%s status=%s", job_id, outcome, status)


def _loop() -> None:
    while not _stop.is_set():
        if not deliver_once(_stop.is_set):
            return  # 没有待补发的：退出，下次有人停止时再起
        _wake.wait(INTERVAL_SECONDS)
        _wake.clear()


def wake() -> None:
    """有新的待补发停止请求（或服务刚启动）：立即发一轮；线程没在跑就起一个。"""
    global _thread
    with _guard:
        _stop.clear()
        _wake.set()
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_loop, name="gateway-cancel-outbox", daemon=True)
            _thread.start()


def stop() -> None:
    """本机服务关停：线程立即结束（未送达的标记保留在任务上，下次启动再发）。"""
    _stop.set()
    _wake.set()
