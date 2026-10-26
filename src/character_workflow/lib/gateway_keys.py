"""局域网网关的配置与网关密钥（ADR-0025）。

`.config/gateway.json` 存开关、端口、网关名和每个人的网关密钥。密钥只存 sha256，明文只在创建时
返回一次；撤销即时生效（每次鉴权都读文件）。文件权限与 Agent 凭据一样只给当前用户。
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from character_workflow.lib import data_root, gateway_audit
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.private_json import read_private_json, write_private_json

DEFAULT_PORT = 5180
TOKEN_PREFIX = "atg_"
_MAX_FILE_BYTES = 256 * 1024


LimitPeriod = Literal["day", "week", "month"]
_UNSET = object()


class GatewayLimit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: LimitPeriod
    cap_cny: float = Field(gt=0, le=1_000_000)


class GatewayPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limits: list[GatewayLimit] = Field(default_factory=list, max_length=3)
    allowed_models: list[str] | None = None
    allowed_aliases: list[str] | None = None

    @field_validator("limits")
    @classmethod
    def unique_periods(cls, limits):
        if len({limit.period for limit in limits}) != len(limits):
            raise ValueError("同一限额窗口只能设置一次")
        return limits


class GatewayKeyRecord(GatewayPolicy):
    # 本机旧配置中的 daily_image_limit 读入即丢弃，不迁移、不保留旧协议。
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str = Field(min_length=1, max_length=40)
    role: Literal["member", "admin"] = "member"
    token_sha256: str
    created_at: str
    revoked_at: str | None = None


class GatewayConfig(BaseModel):
    enabled: bool = False
    port: int = Field(default=DEFAULT_PORT, ge=1024, le=65535)
    name: str = Field(default="", max_length=40)
    keys: list[GatewayKeyRecord] = Field(default_factory=list)


class GatewayAdminError(PermissionError):
    pass


class NoSuchGatewayKeyError(LookupError):
    pass


def gateway_file() -> Path:
    return data_root.config_dir() / "gateway.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def read_config() -> GatewayConfig:
    path = gateway_file()
    if not path.exists():
        return GatewayConfig()
    return GatewayConfig.model_validate(read_private_json(path, _MAX_FILE_BYTES))


def _write(config: GatewayConfig) -> None:
    write_private_json(gateway_file(), config.model_dump(mode="json"))


def _lock():
    return file_lock(gateway_file().with_suffix(".lock"))


def update_settings(
    *, enabled: bool | None = None, port: int | None = None, name: str | None = None,
) -> GatewayConfig:
    with _lock():
        config = read_config()
        patch = {k: v for k, v in {"enabled": enabled, "port": port, "name": name}.items()
                 if v is not None}
        updated = GatewayConfig.model_validate({**config.model_dump(), **patch})
        _write(updated)
        return updated


def create_key(
    name: str, limits: list[GatewayLimit] | None = None,
    allowed_models: list[str] | None = None, allowed_aliases: list[str] | None = None,
    *, role: Literal["member", "admin"] = "member", actor_id: str | None = None,
) -> tuple[GatewayKeyRecord, str]:
    """新建网关密钥；返回 (记录, 明文)。明文之后再也拿不到。"""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    record = GatewayKeyRecord(
        id=uuid.uuid4().hex[:12], name=name.strip(), token_sha256=digest(token),
        limits=limits or [], allowed_models=allowed_models, allowed_aliases=allowed_aliases,
        created_at=_now(), role=role,
    )
    with _lock():
        config = read_config()
        actor = require_admin(config, actor_id)
        _write(config.model_copy(update={"keys": [*config.keys, record]}))
        gateway_audit.append("member.create", record.id, {"after": _summary(record)}, actor)
    return record, token


def update_key(
    key_id: str, *, name=_UNSET, limits=_UNSET,
    allowed_models=_UNSET, allowed_aliases=_UNSET, role=_UNSET, actor_id: str | None = None,
) -> GatewayKeyRecord:
    patch = {k: v for k, v in {
        "name": name, "limits": limits, "allowed_models": allowed_models,
        "allowed_aliases": allowed_aliases, "role": role,
    }.items() if v is not _UNSET}
    if isinstance(patch.get("name"), str):
        patch["name"] = patch["name"].strip()
    return _replace(key_id, lambda record: GatewayKeyRecord.model_validate(
        {**record.model_dump(), **patch}), actor_id, "member.update")


def revoke_key(key_id: str, *, actor_id: str | None = None) -> GatewayKeyRecord:
    return _replace(key_id, lambda record: record if record.revoked_at
                    else record.model_copy(update={"revoked_at": _now()}), actor_id, "member.revoke")


def _replace(key_id: str, change, actor_id: str | None, action: str) -> GatewayKeyRecord:
    with _lock():
        config = read_config()
        record = next((item for item in config.keys if item.id == key_id), None)
        if record is None:
            raise NoSuchGatewayKeyError(key_id)
        actor = require_admin(config, actor_id)
        updated = change(record)
        if actor and record.id == actor.id and (updated.revoked_at or updated.role != "admin"):
            raise GatewayAdminError("管理员不能撤销或降级自己的密钥，请在中转机本机操作")
        if actor and record.role == "admin" and (updated.revoked_at or updated.role != "admin"):
            if not any(k.id != record.id and k.role == "admin" and not k.revoked_at for k in config.keys):
                raise GatewayAdminError("最后一位管理员只能在中转机本机撤销或降级")
        _write(config.model_copy(update={
            "keys": [updated if item.id == key_id else item for item in config.keys],
        }))
        gateway_audit.append(action, record.id, {"before": _summary(record), "after": _summary(updated)}, actor)
        return updated


def _summary(record):
    return record.model_dump(mode="json", include={"name", "role", "limits", "allowed_models", "allowed_aliases", "revoked_at"})


def require_admin(config: GatewayConfig, actor_id: str | None):
    if actor_id is None:
        return None
    actor = next((k for k in config.keys if k.id == actor_id and not k.revoked_at and k.role == "admin"), None)
    if actor is None:
        raise GatewayAdminError("管理员密钥已撤销或权限已变更")
    return actor


def authenticate(token: str) -> GatewayKeyRecord | None:
    """按明文找有效（未撤销）的网关密钥；找不到返回 None。"""
    if not token.startswith(TOKEN_PREFIX):
        return None
    hashed = digest(token)
    for record in read_config().keys:
        if record.revoked_at is None and secrets.compare_digest(record.token_sha256, hashed):
            return record
    return None
