"""局域网共享的本机管理接口（ADR-0025）：开关、网关密钥、用量。只给本机页面（管理权限）。

路由写成同步 `def`：每个处理器都读写 gateway.json 并抢它的文件锁，交给线程池执行。
"""
from __future__ import annotations

import re
import socket
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import gateway_keys, gateway_tasks
from viewer_server.gateway_app import gateway_server

gateway_router = APIRouter(prefix="/api/gateway")


class GatewaySettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    port: int | None = Field(default=None, ge=1024, le=65535)
    name: str | None = Field(default=None, max_length=40)


class GatewayKeyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=40)]
    daily_image_limit: int | None = Field(default=None, ge=0, le=100_000)


class GatewayKeyLimit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    daily_image_limit: int | None = Field(default=None, ge=0, le=100_000)


def _key_view(record: gateway_keys.GatewayKeyRecord) -> dict:
    return {
        "id": record.id, "name": record.name, "daily_image_limit": record.daily_image_limit,
        "created_at": record.created_at, "revoked_at": record.revoked_at,
        "used_today": gateway_tasks.images_used_today(record.id),
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
    record, token = gateway_keys.create_key(body.name, body.daily_image_limit)
    return {"key": _key_view(record), "token": token}


@gateway_router.patch("/keys/{key_id}")
def set_gateway_key_limit(key_id: str, body: GatewayKeyLimit) -> dict:
    try:
        return _key_view(gateway_keys.set_daily_limit(key_id, body.daily_image_limit))
    except gateway_keys.NoSuchGatewayKeyError as error:
        raise HTTPException(404, "网关密钥不存在") from error


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
