"""成员端：停止请求补发（第 5 批 5-3）。

用户停止经局域网网关的任务时，网关连不上（或停止发生在任务正在等网关、没有线程在跑时），停止请求送不到主机。
这里把它记在任务上（`JobParams.gateway_cancel_pending`），连上主机后按幂等键补发：

- 主机没发上游的任务取消、扣 0；已发上游的照常跑完并计费（飙哥定 Q3-1=B）。任务文案按主机答复改。
- 标记只在主机答复后清（取消 / 继续执行 / 已结束 / 旧主机不支持）；连不上就保留，下一轮再试。
- 幂等键签发超过 20 小时不再补发：主机那边的任务已过保留期，补发没有意义。

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
            if job.status == JobStatus.CANCELED and job.params.gateway_cancel_pending
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


def _apply(job_id: str, body: dict) -> None:
    """按主机答复更新任务：清掉补发标记；已发上游（会跑完）或已出完的保留「结局未知」标记，便于再次生成接回。"""
    from character_workflow.lib.job_runner import GATEWAY_CANCEL_CONTINUING
    from character_workflow.lib.jobs import job_lock, read_job, write_job_under_lock

    outcome = body.get("cancel_outcome")
    keep_result = outcome == "continuing" or (outcome == "finished" and body.get("status") == "done")
    with job_lock(job_id):
        job = read_job(job_id)
        params = job.params.model_copy(update={
            "gateway_cancel_pending": None,
            "gateway_unconfirmed": True if keep_result else None,
        })
        error = (GATEWAY_CANCEL_CONTINUING if keep_result
                 else job.error if outcome == "unsupported" else "已停止")
        write_job_under_lock(job.model_copy(update={"params": params, "error": error}))
    logger.info("停止请求已送达主机 job=%s outcome=%s", job_id, outcome)


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
