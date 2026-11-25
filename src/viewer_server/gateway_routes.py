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
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from character_workflow.lib import (
    gateway_keys, gateway_quota, gateway_tasks, keys,
)
from character_workflow.lib.callers import atelier_gateway
from viewer_server.gateway_app import gateway_server

gateway_router = APIRouter(prefix="/api/gateway")


class GatewaySettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    port: int | None = Field(default=None, ge=1024, le=65535)
    name: str | None = Field(default=None, max_length=40)


class ScopeEntryInput(BaseModel):
    """接口写入的范围条目：长度与条数上限只在这里查（持久化模型不查，见 gateway_keys.ScopeEntry）。"""
    model_config = ConfigDict(extra="forbid")
    alias: str = Field(min_length=1, max_length=120)
    models: list[Annotated[str, Field(min_length=1, max_length=200)]] | None = Field(default=None, max_length=500)


def _check_new_scope(scope):
    """新保存的范围：不能为空（一个模型都没有），同一供应商只能出现一次。已存在的空范围（旧数据转换来的）照常读出。"""
    if scope is None:
        return scope
    if not scope or any(entry.models == [] for entry in scope):
        raise ValueError("至少选一个模型")
    if len({entry.alias for entry in scope}) != len(scope):
        raise ValueError("同一供应商只能出现一次")
    return scope


class GatewayKeyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str | None = Field(default=None, min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$", repr=False)
    role: Literal["member", "admin"] = "member"
    name: Annotated[str, Field(min_length=1, max_length=40)]
    quota: gateway_keys.GatewayQuota | None = None
    scope: list[ScopeEntryInput] | None = Field(default=None, max_length=200)

    _scope_ok = field_validator("scope")(_check_new_scope)


class GatewayKeyPatch(BaseModel):
    role: Literal["member", "admin"] | None = None
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=40)
    quota: gateway_keys.GatewayQuota | None = None
    scope: list[ScopeEntryInput] | None = Field(default=None, max_length=200)

    _scope_ok = field_validator("scope")(_check_new_scope)


def _key_view(record: gateway_keys.GatewayKeyRecord) -> dict:
    with gateway_tasks._lock:
        return {
            **record.model_dump(mode="json", exclude={"token_sha256", "token"}),
            "quota_status": gateway_quota.quota_status(record),
            **gateway_quota.month_summary(record),
            "last_used_at": gateway_tasks.last_used_at(record.id),
        }


def _view() -> dict:
    health = {"quarantined_tasks": gateway_tasks.quarantined_count(), "config_error": None}
    try:
        config = gateway_keys.read_config()
    except gateway_keys.GatewayConfigCorruptError as error:
        # 页面要能看到「配置损坏」：不 500，返回空配置 + 原因；不碰原文件。
        return {
            "enabled": False, "port": gateway_keys.DEFAULT_PORT, "name": "",
            "default_name": socket.gethostname(), "keys": [],
            "status": gateway_server.status(), **health, "config_error": str(error),
        }
    return {
        "enabled": config.enabled, "port": config.port,
        "name": config.name, "default_name": socket.gethostname(),
        "keys": [_key_view(record) for record in config.keys],
        "status": gateway_server.status(), **health,
    }


@gateway_router.get("")
def get_gateway() -> dict:
    return _view()


@gateway_router.get("/service")
def get_gateway_service() -> dict:
    """常驻任务状态要起一次 PowerShell，单独成接口，页面只在打开时读一次。"""
    from viewer_server.windows_service import service_status
    return service_status()


@gateway_router.post("/service/install")
def install_gateway_service() -> dict:
    """拉起提权 PowerShell 安装常驻服务（D16，会弹 UAC）；失败时页面保留「复制命令手动安装」。"""
    from viewer_server.windows_service import ServiceInstallError, install_service
    try:
        install_service()
    except ServiceInstallError as error:
        raise HTTPException(409, {
            "message": str(error), "code": "service_install_failed",
            "recovery": "可以复制命令，在以管理员身份打开的 PowerShell 中手动安装", "raw": error.raw,
        }) from None
    return {"started": True}


# 首次开启时端口被占，往后顺延找空闲端口（同 viewer-server 的 +1 规则）；最多试这么多个。
_PORT_SEARCH_SPAN = 20


def _first_free_port(start: int) -> int | None:
    for port in range(start, min(start + _PORT_SEARCH_SPAN, 65536)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind((gateway_server.host, port))
        except OSError:
            continue
        return port
    return None


@gateway_router.put("")
def update_gateway(body: GatewaySettingsPatch) -> dict:
    port = body.port
    if body.enabled and port is None:
        current = gateway_keys.read_config()
        # 还没有成员时地址没交出去过，换端口无人受影响；有成员后端口固定，被占要用户自己改。
        if not current.enabled and not any(not key.revoked_at for key in current.keys):
            free = _first_free_port(current.port)
            port = free if free not in (None, current.port) else None
    config = gateway_keys.update_settings(enabled=body.enabled, port=port, name=body.name)
    gateway_server.apply(config)
    return _view()


@gateway_router.post("/keys", status_code=201)
def create_gateway_key(body: GatewayKeyCreate) -> dict:
    try:
        record, token = gateway_keys.create_key(**body.model_dump())
    except gateway_keys.CustomGatewayTokenError as error:
        raise HTTPException(422, str(error)) from None
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


@gateway_router.get("/keys/{key_id}/token")
def reveal_gateway_token(key_id: str, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    try:
        return {"token": gateway_keys.reveal_token(key_id)}
    except gateway_keys.NoSuchGatewayKeyError as error:
        raise HTTPException(404, "网关密钥不存在或已撤销") from error


@gateway_router.post('/keys/{key_id}/reset')
def reset_gateway_key(key_id: str):
    try:
        record, token = gateway_keys.reset_key(key_id)
        return {'key': _key_view(record), 'token': token}
    except gateway_keys.NoSuchGatewayKeyError:
        raise HTTPException(404, '网关密钥不存在或已撤销') from None


@gateway_router.post("/keys/{key_id}/revoke")
def revoke_gateway_key(key_id: str) -> dict:
    try:
        return _key_view(gateway_keys.revoke_key(key_id))
    except gateway_keys.NoSuchGatewayKeyError as error:
        raise HTTPException(404, "网关密钥不存在") from error


@gateway_router.get("/options")
def gateway_options() -> dict:
    """本机设置页的密钥范围选项：与管理员远程管理同一份（按供应商分组，第 7 批）。"""
    from viewer_server.gateway_admin import scope_options

    return scope_options()


# ---- 接入端：局域网 Atelier 供应商 ----

class GatewayCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: Annotated[str, Field(min_length=1, max_length=300)]
    access_key: str | None = Field(default=None, max_length=300)
    # 编辑已存的网关供应商时前端只有掩码：按别名取存储的密钥，地址必须和存储的一致。
    alias: str | None = Field(default=None, max_length=120)


def _gateway_failure(error: Exception) -> HTTPException:
    if isinstance(error, requests.RequestException):
        return HTTPException(502, "连不上网关：请确认网关机器已开机、Atelier 已启动并开启局域网共享，地址和端口正确")
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
