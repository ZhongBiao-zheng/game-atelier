"""局域网共享的本机管理接口（ADR-0025）：开关、网关密钥、用量。只给本机页面（管理权限）。

路由写成同步 `def`：每个处理器都读写 gateway.json 并抢它的文件锁，交给线程池执行。
"""
from __future__ import annotations

import re
import socket
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import atelier_gateway
from viewer_server.gateway_app import gateway_server

gateway_router = APIRouter(prefix="/api/gateway")


class GatewaySettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    port: int | None = Field(default=None, ge=1024, le=65535)
    name: str | None = Field(default=None, max_length=40)


class GatewayKeyCreate(gateway_keys.GatewayPolicy):
    name: Annotated[str, Field(min_length=1, max_length=40)]


class GatewayKeyPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=40)
    limits: list[gateway_keys.GatewayLimit] | None = Field(default=None, max_length=3)
    allowed_models: list[str] | None = None
    allowed_aliases: list[str] | None = None


def _key_view(record: gateway_keys.GatewayKeyRecord) -> dict:
    with gateway_tasks._lock:
        return {
            **record.model_dump(mode="json", exclude={"token_sha256"}),
            "limits_status": gateway_quota.usage_summary(record),
            **gateway_quota.month_summary(record),
            "last_used_at": gateway_tasks.last_used_at(record.id),
        }


def _view() -> dict:
    config = gateway_keys.read_config()
    return {
        "enabled": config.enabled, "port": config.port,
        "name": config.name, "default_name": socket.gethostname(),
        "keys": [_key_view(record) for record in config.keys],
        "status": gateway_server.status(),
    }


@gateway_router.get("")
def get_gateway() -> dict:
    return _view()


@gateway_router.put("")
def update_gateway(body: GatewaySettingsPatch) -> dict:
    config = gateway_keys.update_settings(enabled=body.enabled, port=body.port, name=body.name)
    gateway_server.apply(config)
    return _view()


@gateway_router.post("/keys", status_code=201)
def create_gateway_key(body: GatewayKeyCreate) -> dict:
    try:
        record, token = gateway_keys.create_key(**body.model_dump())
    except ValidationError as error:
        raise HTTPException(422, "网关密钥配置不合法") from error
    return {"key": _key_view(record), "token": token}


@gateway_router.patch("/keys/{key_id}")
def update_gateway_key(key_id: str, body: GatewayKeyPatch) -> dict:
    try:
        return _key_view(gateway_keys.update_key(key_id, **body.model_dump(exclude_unset=True)))
    except gateway_keys.NoSuchGatewayKeyError as error:
        raise HTTPException(404, "网关密钥不存在") from error
    except ValidationError as error:
        raise HTTPException(422, "网关密钥配置不合法（限额窗口不能重复）") from error


@gateway_router.post("/keys/{key_id}/revoke")
def revoke_gateway_key(key_id: str) -> dict:
    try:
        return _key_view(gateway_keys.revoke_key(key_id))
    except gateway_keys.NoSuchGatewayKeyError as error:
        raise HTTPException(404, "网关密钥不存在") from error


_MONTH = re.compile(r"^\d{4}-\d{2}$")


@gateway_router.get("/usage")
def gateway_usage(month: str | None = Query(default=None)) -> dict:
    month = month or datetime.now().astimezone().strftime("%Y-%m")
    if not _MONTH.fullmatch(month):
        raise HTTPException(422, "month 格式应为 YYYY-MM")
    return {"month": month, "rows": gateway_tasks.read_usage(month)}


@gateway_router.get("/options")
def gateway_options() -> dict:
    return {
        "models": [{"id": route.id, "name": route.name, "modality": route.modality}
                   for route in model_routes.list_routes()],
        "aliases": [{"alias": key.alias, "provider": key.provider, "name": key.alias}
                    for key in keys.read_keys_db().keys if key.provider != "atelier"],
    }


# ---- 接入端：局域网 Atelier 供应商 ----

class GatewayCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: Annotated[str, Field(min_length=1, max_length=300)]
    access_key: str | None = Field(default=None, max_length=300)
    # 编辑已存的网关供应商时前端只有掩码：按别名取存储的密钥，地址必须和存储的一致。
    alias: str | None = Field(default=None, max_length=120)


def _gateway_failure(error: Exception) -> HTTPException:
    if isinstance(error, requests.RequestException):
        return HTTPException(502, "连不上网关：请确认地址、端口，以及网关机器已开启局域网共享")
    return HTTPException(502, str(error))


@gateway_router.post("/check")
def check_gateway(body: GatewayCheck) -> dict:
    base_url, token = body.base_url.strip().rstrip("/"), (body.access_key or "").strip()
    if not re.fullmatch(r"https?://[^/\s]+", base_url):
        raise HTTPException(422, "网关地址格式应为 http://IP:端口")
    if not token and body.alias:
        stored = keys.find_by_alias(body.alias)
        if stored is None or stored.provider != "atelier":
            raise HTTPException(404, "找不到这个网关供应商")
        if (stored.base_url or "").rstrip("/") != base_url:
            raise HTTPException(400, "网关地址改了，请重新填写网关密钥")
        token = stored.access_key
    if not token:
        raise HTTPException(422, "缺少网关密钥")
    try:
        result = atelier_gateway.check_gateway(base_url, token)
    except (requests.RequestException, atelier_gateway.GatewayError) as error:
        raise _gateway_failure(error) from error
    models = atelier_gateway.gateway_models(result["models"])
    return {"info": result["info"], "models": [model.model_dump(mode="json") for model in models]}


@gateway_router.post("/providers/{alias}/sync")
def sync_gateway_provider(alias: str) -> dict:
    try:
        models = atelier_gateway.sync_gateway_key(alias)
    except (requests.RequestException, atelier_gateway.GatewayError) as error:
        raise _gateway_failure(error) from error
    return {"models": [model.model_dump(mode="json") for model in models]}


@gateway_router.get("/tasks")
def gateway_task_list(scope: Literal["active", "recent"] = "active") -> dict:
    from character_workflow.lib import gateway_live
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    with gateway_tasks._lock:
        tasks = [t for t in gateway_tasks._all_tasks()
                 if (t.status not in gateway_tasks.TERMINAL if scope == "active"
                     else t.status in gateway_tasks.TERMINAL and datetime.fromisoformat(t.updated_at) >= cutoff)]
        rows = {t.task_id: gateway_tasks.task_snapshot(t) for t in tasks}
    if scope == "active":
        rows.update({c["call_id"]: gateway_live.text_snapshot(c) for c in gateway_live.active()})
    ordered = sorted(rows.values(), key=lambda row: row["updated_at"], reverse=True)
    return {"tasks": ordered[:200] if scope == "recent" else ordered}


@gateway_router.get("/tasks/{task_id}/outputs/{index}")
def gateway_task_output(task_id: str, index: int) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{32}", task_id):
        raise HTTPException(404, "任务不存在")
    task = gateway_tasks._read(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    try:
        path = gateway_tasks.output_file(task.key_id, task_id, index)
    except gateway_tasks.GatewayRequestError as error:
        raise HTTPException(error.status, error.message) from error
    return FileResponse(path, media_type=task.output_types[index])


_me_cache: dict[str, tuple[tuple, float, dict | None]] = {}
_me_lock = threading.Lock()


@gateway_router.get("/providers/{alias}/me")
def gateway_provider_me(alias: str) -> dict | None:
    key = keys.find_by_alias(alias)
    if key is None or key.provider != "atelier" or not key.base_url:
        return None
    identity = (key.base_url, key.access_key)
    with _me_lock:
        cached = _me_cache.get(alias)
        if cached and cached[0] == identity and cached[1] > time.monotonic():
            return cached[2]
    result = None
    try:
        with atelier_gateway._session() as session:
            response = session.get(key.base_url.rstrip("/") + "/gateway/v1/me",
                headers={"Authorization": f"Bearer {key.access_key}"}, timeout=(3, 5))
            response.raise_for_status()
            body = response.json()
            if isinstance(body, dict) and isinstance(body.get("limits"), list):
                result = body
    except (requests.RequestException, ValueError):
        pass
    with _me_lock:
        _me_cache[alias] = (identity, time.monotonic() + 30, result)
    return result
