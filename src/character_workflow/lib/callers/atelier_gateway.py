"""局域网 Atelier（ADR-0025）：把出图交给网关，提交 → 轮询 → 下载。

错误的报法决定接入端会不会换自家 KEY（`model_routes.failover_reason`）：
- 网关连不上：原样抛 requests 异常（连接前失败 → 换）。
- 401 / 429 / 404 / 全部成员都拒绝：`gateway api <状态码>`（→ 换）。
- 提交或轮询结果不确定、网关重启：文案带「未确认」（→ 不换，网关那边可能已经在出图）。
网关任务 id 一拿到就写进 `provider_task_ids`，服务重启后只查询这个任务，不重新提交。
"""
from __future__ import annotations

import hashlib
import json
import math
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys

PROTOCOL = "atelier_gateway"
PROTOCOL_VERSION = 2
SUBMIT_ATTEMPTS = 3
POLL_INTERVAL_SECONDS = 2.0
POLL_GIVE_UP_SECONDS = 600.0
# 主机确定没收下提交时，画布在线程里重发的间隔（秒）。
SUBMIT_RETRY_SECONDS = 10.0
# 主机更新排空时 503 响应里的结构化标记（vs/update_routes.UPDATING_CODE）。
HOST_UPDATING_CODE = "updating"
# 产物下载失败后的退避（秒）：共 4 次请求。
DOWNLOAD_RETRY_DELAYS = (2.0, 5.0, 10.0)
_TIMEOUT = (5.0, 60.0)
_TERMINAL = {"done", "failed", "canceled"}
_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
           "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
           "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
           "audio/flac": ".flac", "audio/ogg": ".opus", "audio/aac": ".aac",
           "audio/pcm": ".pcm"}


class GatewayError(RuntimeError):
    def __init__(self, message: str, *, retry_after: float | None = None, detail: str | None = None):
        super().__init__(message)
        self.retry_after = retry_after
        self.detail = detail


class GatewayTaskGone(GatewayError):
    """主机明确答复没有这个任务（已过保留期被清理，或不属于这把密钥）：不再等，按失败处理。"""


class GatewayUnconfirmed(GatewayError):
    """接入端没从网关拿到这次任务的结果：提交未确认、查询放弃、产物下载失败。

    网关那边可能已经在出图或已经出完；不能换自家 KEY 重出，「再次生成」凭幂等键接回。
    按类型判断，不靠报错文案。
    """


class GatewayNotAccepted(GatewayError):
    """主机确定没收下这次提交：更新排空时回了带 `code: "updating"` 的 503，或连接都没建立。

    主机上没有建任务，用同一把幂等键原样重发不会重复下单。`reason` 是换家时的原因
    （`model_routes.FailoverReason`）。
    """

    def __init__(self, message: str, *, reason: str):
        super().__init__(message)
        self.reason = reason



# 文本 / Agent 这类不走 _session() 的请求也要直连网关：把环境代理逐个置空（requests 合并时删除）。
DIRECT_PROXIES = {"http": None, "https": None}


def _session() -> requests.Session:
    # 网关在局域网里：不走系统代理（本机 Clash / VPN 会把 192.168.x.x 的请求拖死）。
    session = requests.Session()
    session.trust_env = False
    return session


def _raise_for_status(response: requests.Response) -> None:
    if response.status_code < 400:
        return
    code = None
    try:
        body = response.json()
        detail = body.get("detail") or (body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else None)
        code = body.get("code") if isinstance(body, dict) else None
    except ValueError:
        detail = None
    if response.status_code == 503 and code == HOST_UPDATING_CODE:
        raise GatewayNotAccepted(f"gateway api 503: {detail or '正在更新'}", reason="updating")
    retry_after = None
    if response.status_code == 429:
        try:
            value = float(response.headers.get("Retry-After", ""))
            retry_after = max(0, value) if math.isfinite(value) else None
        except ValueError:
            pass
    raise GatewayError(f"gateway api {response.status_code}: {detail or response.reason}",
                       retry_after=retry_after, detail=detail if response.status_code == 429 else None)


# 测试连接时按状态码给出能照着做的提示；生成请求仍走 _raise_for_status 的「gateway api <码>」供路由判断切换。
_CHECK_HEALTH_ERRORS = {404: "网关机器的 Atelier 版本过旧，请先把网关机器更新到最新版"}
_CHECK_AUTH_ERRORS = {401: "网关密钥无效或已被撤销，请向网关管理员重新获取",
                      403: "这把网关密钥没有使用权限，请联系网关管理员"}


def _raise_check_status(response: requests.Response, messages: dict[int, str]) -> None:
    if response.status_code in messages:
        raise GatewayError(messages[response.status_code])
    _raise_for_status(response)


def check_gateway(base_url: str, token: str) -> dict[str, Any]:
    """测试连接：返回网关信息与模型列表；协议版本不一致直接报错。"""
    base = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}
    with _session() as session:
        health = session.get(f"{base}/gateway/v1/health", timeout=(3, 3))
        _raise_check_status(health, _CHECK_HEALTH_ERRORS)
        if health.json().get("ok") is not True:
            raise GatewayError("中转服务健康检查未通过")
        info = session.get(f"{base}/gateway/v1/info", headers=headers, timeout=_TIMEOUT)
        _raise_check_status(info, _CHECK_AUTH_ERRORS)
        body = info.json()
        if body.get("protocol") != PROTOCOL_VERSION:
            raise GatewayError("网关版本不一致，请两边更新到同一版本")
        models = session.get(f"{base}/gateway/v1/models", headers=headers, timeout=_TIMEOUT)
        _raise_check_status(models, _CHECK_AUTH_ERRORS)
        return {"info": body, "models": models.json().get("models", [])}


def gateway_models(routes: list[dict[str, Any]]) -> list[_keys.ModelSpec]:
    """网关的路由组 → 接入端的模型（id 用路由 id，via 存网关成员快照）。"""
    return [
        _keys.ModelSpec(
            id=route["id"], name=route["name"], modality=route["modality"],
            protocol=(route["members"][0].get("protocol") if route["modality"] in {"text", "video"} else None),
            via=[_keys.ViaMember(**member) for member in route["members"]],
            workflow_inputs=route.get("workflow_inputs"),
            declared_snapshot=route.get("declared"),
        )
        for route in routes if route.get("members")
    ]


def sync_gateway_key(alias: str) -> list[_keys.ModelSpec]:
    """重新拉取网关的模型列表，整体替换这条 KEY 的模型；新出现的模型也排到第一位。"""
    from character_workflow.lib import model_routes

    key = _keys.find_by_alias(alias)
    if key is None or key.provider != "atelier" or not key.base_url:
        raise GatewayError(f"{alias} 不是 Remote Atelier 供应商")
    models = gateway_models(check_gateway(key.base_url, key.access_key)["models"])
    _keys.patch_key(alias, {"models": models})
    model_routes.put_alias_first(alias, only_unordered=True)
    return models


def sync_all_gateway_keys() -> None:
    """服务启动时尽力同步一次；网关连不上就保留旧快照。"""
    import logging

    for key in _keys.read_keys_db().keys:
        if not key.enabled or key.provider != "atelier":
            continue
        try:
            sync_gateway_key(key.alias)
        except (requests.RequestException, GatewayError, ValueError) as error:
            logging.getLogger(__name__).info("gateway sync skipped for %s: %s", key.alias, error)


def render(**kwargs) -> list[str]:
    kind = "layer_split" if (kwargs.get("params") or {}).get("layer_decomposition") else "image"
    return _run_task(kind=kind, **kwargs)


def render_edit(**kwargs) -> list[str]:
    return _run_task(kind="image_edit", **kwargs)


def render_video(**kwargs) -> list[str]:
    kwargs.setdefault("n", (kwargs.get("params") or {}).get("n") or 1)
    return _run_task(kind="video", **kwargs)


def render_audio(**kwargs) -> list[str]:
    return _run_task(kind="audio", **kwargs)


def _run_task(
    *,
    kind: str,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    n: int = 1,
    params: dict[str, Any] | None = None,
    on_phase: Callable[[str], None] | None = None,
    on_params_changed: Callable[[], None] | None = None,
    on_task_id: Callable[[str], None] | None = None,
    on_cost_usd: Callable[[float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib.gateway_tasks import ALLOWED_PARAMS_BY_KIND, FILE_PARAMS, FILES_BY_KIND
    from character_workflow.lib.job_runner import USD_TO_CNY, JobCanceled

    key = _keys.find_by_alias(alias)
    if key is None or key.provider != "atelier" or not key.base_url:
        raise GatewayError(f"{alias} 不是 Remote Atelier 供应商")
    if not key.enabled:
        raise GatewayError("供应商已停用")
    params = params if params is not None else {}
    base = key.base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {key.access_key}"}
    cancellation_observed = False
    # 画布任务在线程里等得更久（30 分钟，它没有创作台那样的等待网关后台接回）；其余用默认。
    give_up = float(_kwargs.get("gateway_poll_give_up") or POLL_GIVE_UP_SECONDS)
    # 本机服务关停（不是用户停止）：停下轮询、不向主机发取消，任务留着下次启动接回。
    should_stop = _kwargs.get("gateway_should_stop") or (lambda: False)
    # 主机确定没收下提交时在线程里重发多久（秒）；只有画布明确选了网关时由 job_runner 传入。
    submit_wait = float(_kwargs.get("gateway_submit_wait") or 0)
    from character_workflow.lib.jobs import gateway_key_expired

    if params.get("gateway_unconfirmed") and gateway_key_expired(params.get("gateway_idempotency_key")):
        # 主机终态任务只留 24 小时：再等或再用这把键重发，可能被主机当成新单。
        raise GatewayError("网关任务结果未确认：已超过 20 小时，不再等待")

    def phase(value):
        nonlocal cancellation_observed
        try:
            if on_phase:
                on_phase(value)
        except JobCanceled:
            # Keep polling until the host receives cancellation and settles the task.
            cancellation_observed = True

    def cancelled():
        return cancellation_observed or bool(should_cancel and should_cancel())

    def unconfirmed(error: BaseException) -> BaseException:
        # 没从主机拿到这次任务的终态：「再次生成」可以凭幂等键接回主机上的原任务。
        params["gateway_unconfirmed"] = True
        if on_params_changed:
            on_params_changed()
        return error

    with _session() as session:
        wire_params = {k: v for k, v in params.items()
                       if k in ALLOWED_PARAMS_BY_KIND[kind] and v is not None}
        if kind == "image_edit":
            wire_params["image_edit"] = {k: v for k, v in params.get("image_edit", {}).items()
                                         if k in {"mode", "x", "y", "width", "height"}}
        uploads = {group: ([params[FILE_PARAMS[group]]] if group == "mask"
                           else params[FILE_PARAMS[group]])
                   for group in FILES_BY_KIND[kind] if params.get(FILE_PARAMS[group])}
        fingerprint = _fingerprint(alias=alias, kind=kind, model=model, prompt=prompt, n=n,
                                   params=wire_params, uploads=uploads)

        def submit(*, new_key: bool) -> str:
            # gateway_unconfirmed = 「这把幂等键在主机上的结局还不知道」。新键第一次发送前主机肯定没有；
            # 沿用旧键（接回、本任务上次提交未确认后重发）时，主机可能已经在出图，标记保持到主机对这把键
            # 给出终态为止，中途连不上也不清。
            if new_key:
                params["gateway_idempotency_key"] = new_idempotency_key()
                params["gateway_request_fingerprint"] = fingerprint
                params["provider_task_protocol"] = None
                params["provider_task_ids"] = None
            params["gateway_unconfirmed"] = None if new_key else True
            # 幂等键先落盘再发：提交结果不确定时，下一次用同一个键只会拿回主机上的原任务。
            if on_params_changed:
                on_params_changed()
            deadline = time.monotonic() + submit_wait
            while True:
                try:
                    task_id = _submit(session, base, headers, alias=alias, kind=kind, model=model,
                                      prompt=prompt, n=n, params=wire_params, uploads=uploads,
                                      idempotency_key=params["gateway_idempotency_key"])
                    break
                except GatewayUnconfirmed as error:
                    raise unconfirmed(error) from error.__cause__
                except GatewayNotAccepted as error:
                    if not new_key:
                        # 旧键：这次没收下，但之前用这把键发过的那次可能在出图，不能换家重出。
                        raise unconfirmed(GatewayUnconfirmed(
                            "网关暂不可用，原任务结果未确认")) from error
                    if cancelled():
                        raise JobCanceled("已按请求停止") from error
                    if should_stop() or time.monotonic() >= deadline:
                        raise
                    # 画布明确选了网关：主机没收下，在线程里等一会儿用同一把键重发。
                    phase("waiting_gateway")
                    time.sleep(SUBMIT_RETRY_SECONDS)
            params["provider_task_protocol"] = PROTOCOL
            params["provider_task_ids"] = [task_id]
            params["gateway_unconfirmed"] = True  # 主机已受理，结局要等它给出终态
            if on_params_changed:
                on_params_changed()
            if on_task_id:
                on_task_id(task_id)
            return task_id

        def poll(task_id: str) -> dict[str, Any]:
            try:
                return _poll(session, base, headers, task_id, phase, cancelled, give_up=give_up,
                             should_stop=should_stop)
            except GatewayUnconfirmed as error:
                raise unconfirmed(error) from error.__cause__

        existing = params.get("provider_task_ids") or []
        reattach_of = params.get("gateway_reattach_of")
        if params.get("provider_task_protocol") == PROTOCOL and existing and not reattach_of:
            task_id = str(existing[0])  # 本机服务重启后续查：只查询这个任务，不重新提交
            reattached = False
        else:
            # 「再次生成」只在这次要发的请求与原任务完全相同时接回（同一幂等键，主机返回原任务）；
            # 改过提示词、模型、参数或素材就是新单，换新键。
            reattached = bool(reattach_of and params.get("gateway_idempotency_key")
                              and params.get("gateway_request_fingerprint") == fingerprint)
            if reattach_of and not reattached:
                params["gateway_reattach_of"] = None
            # 已有幂等键而不是「再次生成」：本任务上次提交没确认，用原键重发拿回原任务。
            task_id = submit(new_key=not reattached and (
                bool(reattach_of) or not params.get("gateway_idempotency_key")))
        phase("sent")
        status = poll(task_id)
        if reattached and status["status"] in ("failed", "canceled") and not cancelled():
            # 接回的原任务主机已判失败：同一次运行里换新键重新下单，不让用户再点一次。
            params["gateway_reattach_of"] = None
            task_id = submit(new_key=True)
            status = poll(task_id)
        if status["status"] in ("failed", "canceled"):
            params["gateway_unconfirmed"] = None  # 主机对这把键给了明确终态
            if on_params_changed:
                on_params_changed()
        if status["status"] == "canceled" or cancelled():
            raise JobCanceled("已按请求停止")
        if status["status"] == "failed":
            # 主机只对能确认上游已收费的失败扣额度；扣了多少就记在这次任务上，两边账对得上。
            charged = status.get("charged_cny")
            error = _task_error(status)
            if isinstance(charged, int | float) and charged > 0:
                if on_cost_usd:
                    on_cost_usd(float(charged) / USD_TO_CNY)
                # 成员最容易来问的情况：任务失败却扣了钱。一句话说清扣了多少、为什么。
                # 不写「额度 / 余额」：job_runner._friendly_error 见到这两个词会把整条失败
                # 改判成「厂商余额不足」。
                error = GatewayError(f"{error}（已扣 ¥{charged:g}：上游已对完成的部分收费）")
            raise error

        member = status.get("member_alias")
        warnings = [f"网关：{item}" for item in status.get("warnings") or []]
        if member:
            params["gateway_member"] = member
        if warnings:
            params["warnings"] = [*(params.get("warnings") or []), *warnings]
        if on_params_changed and (member or warnings):
            on_params_changed()
        cost = status.get("charged_cny")
        if cost is None:
            cost = status.get("actual_cost_cny")
        if cost is not None and on_cost_usd:
            on_cost_usd(float(cost) / USD_TO_CNY)

        phase("downloading")

        def download(url: str) -> requests.Response:
            for delay in (*DOWNLOAD_RETRY_DELAYS, None):
                try:
                    response = session.get(url, headers=headers, timeout=_TIMEOUT)
                    _raise_for_status(response)
                    return response
                except (requests.RequestException, GatewayError) as error:
                    if delay is None:
                        raise unconfirmed(GatewayUnconfirmed(
                            f"网关任务 {task_id} 已完成，结果下载失败（未确认是否取回）")) from error
                    time.sleep(delay)
            raise AssertionError("unreachable")
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        paths = []
        for index in range(int(status.get("outputs") or 0)):
            response = download(f"{base}/gateway/v1/tasks/{task_id}/outputs/{index}")
            suffix = _SUFFIX.get(response.headers.get("content-type", "").split(";")[0], ".png")
            target = out_dir / f"gateway-{index}{suffix}"
            target.write_bytes(response.content)
            paths.append(str(target))
        if status.get("layer_result") is not None:
            params["layer_decomposition_result"] = status["layer_result"]
        if status.get("extras"):
            inputs = []
            folder = out_dir / "edit-inputs"
            folder.mkdir(parents=True, exist_ok=True)
            for item in status["extras"]:
                index = int(item["index"])
                response = download(f"{base}/gateway/v1/tasks/{task_id}/extras/{index}")
                target = folder / f"{index}.png"
                target.write_bytes(response.content)
                inputs.append({"role": item["role"], "path": str(target)})
            params["edit_inputs"] = inputs
        params["gateway_unconfirmed"] = None  # 结果已取回
        if on_params_changed:
            on_params_changed()
        return paths


def gateway_reachable(alias: str | None) -> bool:
    """创作台等待网关时的轻量探测（只打不鉴权的健康检查，3 秒超时）；连上了才值得重跑任务。"""
    key = _keys.find_by_alias(alias or "")
    if key is None or key.provider != "atelier" or not key.base_url or not key.enabled:
        return False
    try:
        with _session() as session:
            response = session.get(f"{key.base_url.rstrip('/')}/gateway/v1/health", timeout=(3, 3))
            return response.ok and response.json().get("ok") is True
    except (requests.RequestException, ValueError):
        return False


def new_idempotency_key() -> str:
    """幂等键里带上它第一次发出的时间（秒），「再次生成」的接回窗口从这里算，不另外落盘。"""
    return f"{int(time.time())}-{uuid.uuid4().hex}"


def idempotency_key_issued_at(key: str | None) -> float | None:
    """`new_idempotency_key` 生成的键的签发时间；不是这种格式就返回 None（不接回）。"""
    stamp, separator, rest = (key or "").partition("-")
    if not separator or not stamp.isdigit() or len(rest) != 32:
        return None
    return float(stamp)


def _fingerprint(*, alias, kind, model, prompt, n, params, uploads) -> str:
    """这次实际发给主机的请求指纹：素材按字节算，路径不同但内容相同算同一请求。"""
    files = {group: [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in paths]
             for group, paths in uploads.items()}
    body = json.dumps({"alias": alias, "kind": kind, "model": model, "prompt": prompt, "n": n,
                       "params": params, "files": files},
                      sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _submit(session, base, headers, *, alias, kind, model, prompt, n, params, uploads,
            idempotency_key: str | None = None) -> str:
    from character_workflow.lib.callers.openai_image import _is_pre_flight_failure

    files = [("mask" if group == "mask" else f"{group}_{index}",
              (Path(path).name, Path(path).read_bytes()))
             for group, paths in uploads.items() for index, path in enumerate(paths)]
    body = {"request": json.dumps({"kind": kind, "model": model, "prompt": prompt, "n": n,
                                   "size": params.get("size"), "params": params})}
    # 同一个 Idempotency-Key 的重发（本次重试、日后「再次生成」接回）网关只会建一个任务。
    request_headers = {**headers, "Idempotency-Key": idempotency_key or uuid.uuid4().hex}
    last_error: requests.RequestException | None = None
    for attempt in range(SUBMIT_ATTEMPTS):
        try:
            response = session.post(f"{base}/gateway/v1/tasks", data=body, files=files or None,
                                    headers=request_headers, timeout=_TIMEOUT)
        except (requests.ConnectionError, requests.Timeout) as error:
            if attempt == 0 and _is_pre_flight_failure(error):
                # 连接都没建立：网关没收到，接入端可以换家或原样重发。
                raise GatewayNotAccepted("网关连不上，任务未提交", reason="unreachable") from error
            last_error = error
            continue
        try:
            _raise_for_status(response)
        except GatewayError as error:
            if response.status_code == 429:
                from character_workflow.lib import model_routes
                from character_workflow.lib.gateway_tasks import modality_for
                model_routes.cool_down(modality_for(kind), alias, "rate_limited", seconds=error.retry_after)
            raise
        return str(response.json()["task_id"])
    raise GatewayUnconfirmed("网关提交结果未确认，未自动重新提交") from last_error


def _poll(session, base, headers, task_id, phase, cancelled,
          give_up: float = POLL_GIVE_UP_SECONDS,
          should_stop: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    last_ok = time.monotonic()
    last_phase = None
    cancel_sent = False
    waiting = False
    while True:
        if should_stop():
            raise GatewayUnconfirmed(f"本机服务关停，网关任务 {task_id} 结果未确认")
        if cancelled() and not cancel_sent:
            try:
                response = session.post(f"{base}/gateway/v1/tasks/{task_id}/cancel", headers=headers,
                                        timeout=_TIMEOUT)
                _raise_for_status(response)
                cancel_sent = True
            except (requests.RequestException, GatewayError):
                pass
        try:
            response = session.get(f"{base}/gateway/v1/tasks/{task_id}", headers=headers,
                                   timeout=_TIMEOUT)
            if response.status_code == 404:
                # 主机明确答复：没有这个任务（已过保留期被清理，或不属于这把密钥）。
                raise GatewayTaskGone(f"网关已找不到任务 {task_id}（可能已超过保留期）")
            _raise_for_status(response)
            status = response.json()
            last_ok = time.monotonic()
        except (requests.RequestException, GatewayError) as error:
            if isinstance(error, GatewayTaskGone):
                raise
            if cancelled():
                # 用户要停、网关又连不上：停止请求送不到主机，只能本机先停；主机上的任务可能仍会完成。
                return {"status": "canceled"}
            if time.monotonic() - last_ok > give_up:
                raise GatewayUnconfirmed(f"网关任务 {task_id} 结果未确认（查询失败）") from error
            if not waiting:
                waiting = True
                phase("waiting_gateway")
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        if waiting:
            waiting = False
            phase(last_phase or "sent")
        if status.get("status") in _TERMINAL:
            return status
        if status.get("phase") and status["phase"] != last_phase:
            last_phase = status["phase"]
            if last_phase != "queued":
                phase(last_phase)
        time.sleep(POLL_INTERVAL_SECONDS)


def _task_error(status: dict[str, Any]) -> GatewayError:
    message = status.get("error") or "网关任务失败"
    if status.get("error_kind") == "unavailable":
        return GatewayError(f"gateway api 503: gateway_unavailable — {message}")
    return GatewayError(message)
