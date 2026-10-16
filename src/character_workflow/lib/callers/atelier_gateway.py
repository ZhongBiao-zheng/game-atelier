"""局域网 Atelier（ADR-0025）：把出图交给网关，提交 → 轮询 → 下载。

错误的报法决定接入端会不会换自家 KEY（`model_routes.failover_reason`）：
- 网关连不上：原样抛 requests 异常（连接前失败 → 换）。
- 401 / 429 / 404 / 全部成员都拒绝：`gateway api <状态码>`（→ 换）。
- 提交或轮询结果不确定、网关重启：文案带「未确认」（→ 不换，网关那边可能已经在出图）。
网关任务 id 一拿到就写进 `provider_task_ids`，服务重启后只查询这个任务，不重新提交。
"""
from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys

PROTOCOL = "atelier_gateway"
PROTOCOL_VERSION = 1
SUBMIT_ATTEMPTS = 3
POLL_INTERVAL_SECONDS = 2.0
POLL_GIVE_UP_SECONDS = 600.0
_TIMEOUT = (5.0, 60.0)
_TERMINAL = {"done", "failed", "canceled"}
_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


class GatewayError(RuntimeError):
    pass


def _session() -> requests.Session:
    # 网关在局域网里：不走系统代理（本机 Clash / VPN 会把 192.168.x.x 的请求拖死）。
    session = requests.Session()
    session.trust_env = False
    return session


def _raise_for_status(response: requests.Response) -> None:
    if response.status_code < 400:
        return
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    raise GatewayError(f"gateway api {response.status_code}: {detail or response.reason}")


def check_gateway(base_url: str, token: str) -> dict[str, Any]:
    """测试连接：返回网关信息与模型列表；协议版本不一致直接报错。"""
    base = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}
    with _session() as session:
        info = session.get(f"{base}/gateway/v1/info", headers=headers, timeout=_TIMEOUT)
        _raise_for_status(info)
        body = info.json()
        if body.get("protocol") != PROTOCOL_VERSION:
            raise GatewayError("网关版本不一致，请两边更新到同一版本")
        models = session.get(f"{base}/gateway/v1/models", headers=headers, timeout=_TIMEOUT)
        _raise_for_status(models)
        return {"info": body, "models": models.json().get("models", [])}


def gateway_models(routes: list[dict[str, Any]]) -> list[_keys.ModelSpec]:
    """网关的路由组 → 接入端的模型（id 用路由 id，via 存网关成员快照）。"""
    return [
        _keys.ModelSpec(
            id=route["id"], name=route["name"], modality=route["modality"],
            via=[_keys.ViaMember(**member) for member in route["members"]],
        )
        for route in routes if route.get("members")
    ]


def sync_gateway_key(alias: str) -> list[_keys.ModelSpec]:
    """重新拉取网关的模型列表，整体替换这条 KEY 的模型；新出现的模型也排到第一位。"""
    from character_workflow.lib import model_routes

    key = _keys.find_by_alias(alias)
    if key is None or key.provider != "atelier" or not key.base_url:
        raise GatewayError(f"{alias} 不是局域网 Atelier 供应商")
    models = gateway_models(check_gateway(key.base_url, key.access_key)["models"])
    _keys.patch_key(alias, {"models": models})
    model_routes.put_alias_first(alias, only_unordered=True)
    return models


def sync_all_gateway_keys() -> None:
    """服务启动时尽力同步一次；网关连不上就保留旧快照。"""
    import logging

    for key in _keys.read_keys_db().keys:
        if key.provider != "atelier":
            continue
        try:
            sync_gateway_key(key.alias)
        except (requests.RequestException, GatewayError, ValueError) as error:
            logging.getLogger(__name__).info("gateway sync skipped for %s: %s", key.alias, error)


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    n: int = 1,
    params: dict[str, Any] | None = None,
    on_phase: Callable[[str], None] | None = None,
    on_params_changed: Callable[[], None] | None = None,
    on_cost_usd: Callable[[float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib.gateway_tasks import ALLOWED_PARAMS
    from character_workflow.lib.job_runner import USD_TO_CNY, JobCanceled

    key = _keys.find_by_alias(alias)
    if key is None or key.provider != "atelier" or not key.base_url:
        raise GatewayError(f"{alias} 不是局域网 Atelier 供应商")
    params = params if params is not None else {}
    if any(params.get(field) for field in ("mj_sref", "mj_cref", "mj_oref", "mask_image", "image_edit")):
        raise GatewayError("网关暂不支持 MJ 参考图、局部修改与扩图，请改选本机供应商")
    base = key.base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {key.access_key}"}
    phase = on_phase or (lambda _phase: None)
    cancelled = should_cancel or (lambda: False)

    with _session() as session:
        existing = params.get("provider_task_ids") or []
        if params.get("provider_task_protocol") == PROTOCOL and existing:
            task_id = str(existing[0])
        else:
            task_id = _submit(session, base, headers, model=model, prompt=prompt, n=n,
                              params={k: v for k, v in params.items()
                                      if k in ALLOWED_PARAMS and v is not None},
                              references=params.get("reference_images") or [])
            params["provider_task_protocol"] = PROTOCOL
            params["provider_task_ids"] = [task_id]
            if on_params_changed:
                on_params_changed()
        phase("sent")
        status = _poll(session, base, headers, task_id, phase, cancelled)
        if status["status"] == "canceled" or cancelled():
            raise JobCanceled("已按请求停止")
        if status["status"] == "failed":
            raise _task_error(status)

        member = status.get("member_alias")
        warnings = [f"网关：{item}" for item in status.get("warnings") or []]
        if member:
            params["gateway_member"] = member
        if warnings:
            params["warnings"] = [*(params.get("warnings") or []), *warnings]
        if on_params_changed and (member or warnings):
            on_params_changed()
        if status.get("actual_cost_cny") is not None and on_cost_usd:
            on_cost_usd(float(status["actual_cost_cny"]) / USD_TO_CNY)

        phase("downloading")
        out_dir = Path(output_dir)
        paths = []
        for index in range(int(status.get("outputs") or 0)):
            response = session.get(f"{base}/gateway/v1/tasks/{task_id}/outputs/{index}",
                                   headers=headers, timeout=_TIMEOUT)
            _raise_for_status(response)
            suffix = _SUFFIX.get(response.headers.get("content-type", "").split(";")[0], ".png")
            target = out_dir / f"gateway-{index}{suffix}"
            target.write_bytes(response.content)
            paths.append(str(target))
        return paths


def _submit(session, base, headers, *, model, prompt, n, params, references) -> str:
    from character_workflow.lib.callers.openai_image import _is_pre_flight_failure

    files = [(f"ref_{index}", (Path(path).name, Path(path).read_bytes()))
             for index, path in enumerate(references)]
    body = {"request": json.dumps({"model": model, "prompt": prompt, "n": n,
                                   "size": params.get("size"), "params": params})}
    # 同一次提交的重试用同一个 Idempotency-Key：网关只会建一个任务。
    request_headers = {**headers, "Idempotency-Key": uuid.uuid4().hex}
    last_error: requests.RequestException | None = None
    for attempt in range(SUBMIT_ATTEMPTS):
        try:
            response = session.post(f"{base}/gateway/v1/tasks", data=body, files=files or None,
                                    headers=request_headers, timeout=_TIMEOUT)
        except (requests.ConnectionError, requests.Timeout) as error:
            if attempt == 0 and _is_pre_flight_failure(error):
                raise  # 连接都没建立：网关没收到，接入端可以换家
            last_error = error
            continue
        _raise_for_status(response)
        return str(response.json()["task_id"])
    raise GatewayError("网关提交结果未确认，未自动重新提交") from last_error


def _poll(session, base, headers, task_id, phase, cancelled) -> dict[str, Any]:
    last_ok = time.monotonic()
    last_phase = None
    cancel_sent = False
    while True:
        if cancelled() and not cancel_sent:
            try:
                session.post(f"{base}/gateway/v1/tasks/{task_id}/cancel", headers=headers,
                             timeout=_TIMEOUT)
                cancel_sent = True
            except requests.RequestException:
                pass
        try:
            response = session.get(f"{base}/gateway/v1/tasks/{task_id}", headers=headers,
                                   timeout=_TIMEOUT)
            _raise_for_status(response)
            status = response.json()
            last_ok = time.monotonic()
        except (requests.RequestException, GatewayError) as error:
            if time.monotonic() - last_ok > POLL_GIVE_UP_SECONDS:
                raise GatewayError(f"网关任务 {task_id} 结果未确认（查询失败）") from error
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        if status.get("status") in _TERMINAL:
            return status
        if status.get("phase") and status["phase"] != last_phase:
            last_phase = status["phase"]
            if last_phase not in {"queued", "sent"}:
                phase(last_phase)
        time.sleep(POLL_INTERVAL_SECONDS)


def _task_error(status: dict[str, Any]) -> GatewayError:
    message = status.get("error") or "网关任务失败"
    if status.get("error_kind") == "unavailable":
        return GatewayError(f"gateway api 503: gateway_unavailable — {message}")
    return GatewayError(message)
