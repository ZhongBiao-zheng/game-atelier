"""局域网网关的配置与网关密钥（ADR-0025）。

`.config/gateway.json` 存开关、端口、网关名和每个人的网关密钥。明文仅供本机管理查看，鉴权继续
比较 sha256；撤销即时生效（每次鉴权都读文件）。文件权限只给当前用户。
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from character_workflow.lib import data_root, gateway_audit
from character_workflow.lib.corrupt_files import parse_reason
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.private_json import read_private_json, write_private_json

logger = logging.getLogger(__name__)

DEFAULT_PORT = 5180
TOKEN_PREFIX = "atg_"
_MAX_FILE_BYTES = 256 * 1024


QuotaPeriod = Literal["day", "week", "month", "none"]
_UNSET = object()
# 旧数据里多条额度并存时取周期最长的一条（飙哥 2026-11-20：现有密钥没有同时设多条的，直接改）。
_PERIOD_LENGTH = {"day": 1, "week": 2, "month": 3}


class GatewayQuota(BaseModel):
    """一把网关密钥的额度：一个金额 + 一个周期（第 7 批，取代多条 limits）。

    周期按主机本机时区：day = 自然日，week = 周一 00:00 起，month = 自然月，none = 不重置、从 since 起累计。
    since 由主机写：设置额度或改周期时记当时时间；只改金额时保留（已用量不变）。
    """
    model_config = ConfigDict(extra="forbid")
    cap_cny: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)
    period: QuotaPeriod
    since: str | None = None


class ScopeEntry(BaseModel):
    """范围里的一个供应商：models 为 None 时是它的全部模型（含以后新增），否则是它的这些模型（供应商自己的 model id）。"""
    model_config = ConfigDict(extra="forbid")
    alias: str = Field(min_length=1, max_length=120)
    models: list[Annotated[str, Field(min_length=1, max_length=200)]] | None = Field(default=None, max_length=500)


class GatewayPolicy(BaseModel):
    """网关密钥的可用范围与额度（第 7 批）。

    scope 为 None 是全部模型（所有供应商，含以后新增）；否则按供应商列出——模型挂在供应商下面，
    表达不出「选了模型但供应商没开」。判定只有一处：gateway_access.member_in_scope。
    """
    model_config = ConfigDict(extra="forbid")
    quota: GatewayQuota | None = None
    scope: list[ScopeEntry] | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def unique_aliases(self):
        if self.scope is not None and len({entry.alias for entry in self.scope}) != len(self.scope):
            raise ValueError("同一供应商只能出现一次")
        return self


def _legacy_limits_to_quota(limits: list) -> dict | None:
    """旧的多条 limits → 一条 quota。一条原样转；多条取周期最长的一条并记日志。读不出的条目跳过。"""
    usable = [item for item in limits if isinstance(item, dict)
              and item.get("period") in _PERIOD_LENGTH and isinstance(item.get("cap_cny"), int | float)]
    if not usable:
        return None
    chosen = max(usable, key=lambda item: _PERIOD_LENGTH[item["period"]])
    if len(usable) > 1:
        logger.warning("网关密钥有 %d 条旧额度，按周期最长的一条（%s）转换", len(usable), chosen["period"])
    return {"cap_cny": chosen["cap_cny"], "period": chosen["period"], "since": _now()}


def _legacy_pattern_matches(pattern: str, route_id: str) -> bool:
    """第 7 批前 allowed_models 的匹配规则：整串相等，或以 * 结尾时按前缀匹配。"""
    return route_id == pattern or (pattern.endswith("*") and route_id.startswith(pattern[:-1]))


def _legacy_members() -> list[tuple[str, str, str]]:
    """转换旧范围用的（供应商别名, 供应商自己的 model id, 路由 id），含停用的供应商。"""
    from character_workflow.lib import keys, model_routes

    return [(key.alias, model.id, model_routes.route_id(model, key))
            for key in keys.read_keys_db().keys if key.provider != "atelier"
            for model in key.models if model.id]


def legacy_scope(allowed_models, allowed_aliases, members) -> tuple[list[dict] | None, str]:
    """旧的两张名单 → scope（第 7 批）。转换只有这一处；返回（scope, 类别），类别写进日志。

    转换表（PLAN-7「旧范围转换表」）：
    - 都为 None → None（全部模型）。等价。
    - models=None、aliases=[…] → 每个供应商一条「全部」。等价。
    - models=None、aliases=[] → []（空范围，仍不可用）。等价（管理会话定）。
    - models=[…]、aliases=[…] → 每个允许的供应商下，路由 id 命中名单的那些模型。转换当时等价。
    - models=[…]、aliases=None → 同上，范围是当时提供这些模型的全部供应商；以后新增的供应商不再自动包含（变严）。
    - models=[…]、aliases=[] → 按「供应商不限」转（变宽，飙哥 2026-11-20 定：「直接可用」）。
    - 带 * 前缀的条目展开成当时命中的具体模型，不升级成「该供应商全部」（变严）。
    """
    aliases = None if allowed_aliases is None else list(dict.fromkeys(
        alias for alias in allowed_aliases if isinstance(alias, str) and 0 < len(alias) <= 120))
    if allowed_models is None:
        if aliases is None:
            return None, "equal"
        return [{"alias": alias, "models": None} for alias in aliases], "equal"
    patterns = [item for item in allowed_models if isinstance(item, str)]
    widened = aliases == []
    allowed = None if aliases is None or widened else set(aliases)
    by_alias: dict[str, list[str]] = {}
    for alias, model_id, route in members:
        if (allowed is None or alias in allowed) and any(_legacy_pattern_matches(p, route) for p in patterns):
            ids = by_alias.setdefault(alias, [])
            if model_id not in ids:
                ids.append(model_id)
    kind = "widened" if widened else "prefix" if any(p.endswith("*") for p in patterns) else "equal"
    return [{"alias": alias, "models": ids} for alias, ids in by_alias.items()], kind


def _convert_legacy_scopes(raw: dict) -> bool:
    """gateway.json 原文里第 7 批前的 allowed_models / allowed_aliases 就地换成 scope；返回有没有改。

    读不出供应商列表时这几把密钥按空范围处理（宁可暂时不可用，也不放开），且不写回，下次读时重试。
    """
    legacy = [item for item in raw.get("keys") or [] if isinstance(item, dict)
              and ("allowed_models" in item or "allowed_aliases" in item)]
    if not legacy:
        return False
    try:
        members = _legacy_members()
    except Exception:  # noqa: BLE001 —— keys.json 坏了也不能把密钥放开
        logger.warning("读不出供应商列表，%d 把旧网关密钥暂按空范围处理", len(legacy))
        for item in legacy:
            item.pop("allowed_models", None)
            item.pop("allowed_aliases", None)
            item.setdefault("scope", [])
        raise _LegacyScopeDeferred from None
    for item in legacy:
        models, aliases = item.pop("allowed_models", None), item.pop("allowed_aliases", None)
        if "scope" in item:
            continue
        item["scope"], kind = legacy_scope(models, aliases, members)
        level = logging.WARNING if kind != "equal" else logging.INFO
        logger.log(level, "网关密钥「%s」旧范围转换（%s）：allowed_models=%s allowed_aliases=%s → scope=%s",
                   item.get("name"), kind, models, aliases, item["scope"])
    return True


class _LegacyScopeDeferred(Exception):
    """旧范围这次没能转换（供应商列表读不出）：已按空范围读入，不写回。"""


class GatewayKeyRecord(GatewayPolicy):
    # 本机旧配置中的 daily_image_limit 读入即丢弃，不迁移、不保留旧协议。
    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def convert_legacy_limits(cls, data):
        """第 7 批前的 `limits` 列表读入时转成 `quota`；旧字段不保留，下次写盘即是新格式。"""
        if isinstance(data, dict) and "limits" in data:
            data = dict(data)
            limits = data.pop("limits")
            if data.get("quota") is None and isinstance(limits, list):
                data["quota"] = _legacy_limits_to_quota(limits)
        return data
    id: str
    name: str = Field(min_length=1, max_length=40)
    role: Literal["member", "admin"] = "member"
    token_sha256: str
    token: str = Field(default="", repr=False)
    created_at: str
    revoked_at: str | None = None


class GatewayConfig(BaseModel):
    enabled: bool = False
    port: int = Field(default=DEFAULT_PORT, ge=1024, le=65535)
    name: str = Field(default="", max_length=40)
    keys: list[GatewayKeyRecord] = Field(default_factory=list)


class GatewayAdminError(PermissionError):
    pass


class GatewayConfigCorruptError(RuntimeError):
    """gateway.json 内容损坏或读不出。文件里有成员密钥：只报错，绝不自动覆盖或重建。

    消息与 reason 只含路径和错误类型，不含文件内容（校验错误的原文会带出密钥）。
    """

    def __init__(self, path: Path, reason: str, *, unreadable: bool = False) -> None:
        label = "网关配置文件不可读" if unreadable else "网关配置文件损坏"
        super().__init__(f"{label}：{path}（{reason}）。原文件未改动；修好或移走后刷新本页，重新开启网关")
        self.path = path
        self.reason = reason


class CustomGatewayTokenError(ValueError):
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
    with _lock():
        return _read_config_locked()


def _read_config_locked() -> GatewayConfig:
    """Caller holds the gateway lock, including while replacing legacy credentials."""
    path = gateway_file()
    if not path.exists():
        return GatewayConfig()
    try:
        raw = read_private_json(path, _MAX_FILE_BYTES)
    except ValueError as error:  # JSON / UTF-8 / 超长
        raise GatewayConfigCorruptError(path, parse_reason(error)) from None
    except PermissionError as error:  # 权限或属主不对：同样不能动它
        raise GatewayConfigCorruptError(path, str(error), unreadable=True) from None
    # 第 7 批前的旧字段读入即转换，并写回一次新格式；转换不了时不写回。
    legacy_limits = isinstance(raw, dict) and any(
        isinstance(item, dict) and "limits" in item for item in raw.get("keys") or [])
    deferred = False
    try:
        changed = (_convert_legacy_scopes(raw) if isinstance(raw, dict) else False) or legacy_limits
    except _LegacyScopeDeferred:
        changed, deferred = False, True
    try:
        config = GatewayConfig.model_validate(raw)
    except ValueError as error:  # 校验
        raise GatewayConfigCorruptError(path, parse_reason(error)) from None
    for record in config.keys:
        if not record.revoked_at and not record.token:
            record.token = TOKEN_PREFIX + secrets.token_urlsafe(32)
            record.token_sha256 = digest(record.token)
            changed = True
    if changed and not deferred:
        _write(config)
    return config


def _write(config: GatewayConfig) -> None:
    write_private_json(gateway_file(), config.model_dump(mode="json"))


def _lock():
    return file_lock(gateway_file().with_suffix(".lock"))


def update_settings(
    *, enabled: bool | None = None, port: int | None = None, name: str | None = None,
) -> GatewayConfig:
    with _lock():
        config = _read_config_locked()
        patch = {k: v for k, v in {"enabled": enabled, "port": port, "name": name}.items()
                 if v is not None}
        updated = GatewayConfig.model_validate({**config.model_dump(), **patch})
        _write(updated)
        return updated


def create_key(
    name: str, quota: GatewayQuota | dict | None = None,
    scope: list[ScopeEntry] | list[dict] | None = None,
    *, role: Literal["member", "admin"] = "member", actor_id: str | None = None,
    token: str | None = None,
) -> tuple[GatewayKeyRecord, str]:
    """新建网关密钥；返回 (记录, 明文)。"""
    if token is not None and not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", token):
        raise CustomGatewayTokenError("自定义密钥格式不合法")
    token = TOKEN_PREFIX + (token if token is not None else secrets.token_urlsafe(32))
    record = GatewayKeyRecord(
        id=uuid.uuid4().hex[:12], name=name.strip(), token_sha256=digest(token), token=token,
        quota=_with_since(quota, None), scope=scope,
        created_at=_now(), role=role,
    )
    with _lock():
        config = _read_config_locked()
        actor = require_admin(config, actor_id)
        if any(secrets.compare_digest(k.token_sha256, record.token_sha256) for k in config.keys):
            raise CustomGatewayTokenError("密钥已被使用")
        _write(config.model_copy(update={"keys": [*config.keys, record]}))
        gateway_audit.append("member.create", record.id, {"after": _summary(record)}, actor)
    return record, token


def update_key(
    key_id: str, *, name=_UNSET, quota=_UNSET,
    scope=_UNSET, role=_UNSET, actor_id: str | None = None,
) -> GatewayKeyRecord:
    patch = {k: v for k, v in {
        "name": name, "quota": quota, "scope": scope, "role": role,
    }.items() if v is not _UNSET}
    if isinstance(patch.get("name"), str):
        patch["name"] = patch["name"].strip()

    def change(record):
        values = {**record.model_dump(), **patch}
        if "quota" in patch:
            values["quota"] = _with_since(patch["quota"], record.quota)
        return GatewayKeyRecord.model_validate(values)

    return _replace(key_id, change, actor_id, "member.update")


def _with_since(quota: GatewayQuota | dict | None, before: GatewayQuota | None) -> GatewayQuota | None:
    """主机写 since：只改金额（周期不变）时沿用原来的起点，其余（新设、改周期）从现在起算。"""
    if quota is None:
        return None
    parsed = quota if isinstance(quota, GatewayQuota) else GatewayQuota.model_validate(quota)
    since = before.since if before is not None and before.period == parsed.period and before.since else _now()
    return parsed.model_copy(update={"since": since})


def drop_alias_from_scopes(alias: str) -> None:
    """供应商被删除：从所有密钥的范围里去掉它，以后同名的新供应商不会自动拿到权限。

    网关配置损坏时只记日志、不拦删除供应商（配置文件不能被自动改写）。"""
    try:
        with _lock():
            config = _read_config_locked()
            changed = [record.id for record in config.keys
                       if record.scope is not None and any(entry.alias == alias for entry in record.scope)]
            if not changed:
                return
            _write(config.model_copy(update={"keys": [
                record.model_copy(update={"scope": [e for e in record.scope if e.alias != alias]})
                if record.id in changed else record for record in config.keys]}))
            for key_id in changed:
                gateway_audit.append("member.scope_drop_provider", key_id, {"alias": alias}, None)
    except GatewayConfigCorruptError:
        logger.warning("网关配置损坏，删除供应商 %s 时未能更新密钥范围", alias)


def reset_key(key_id: str, *, actor_id: str | None = None) -> tuple[GatewayKeyRecord, str]:
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    def change(record):
        if record.revoked_at:
            raise NoSuchGatewayKeyError(key_id)
        return GatewayKeyRecord.model_validate({**record.model_dump(), 'token': token, 'token_sha256': digest(token)})
    return _replace(key_id, change, actor_id, 'member.reset'), token


def revoke_key(key_id: str, *, actor_id: str | None = None) -> GatewayKeyRecord:
    return _replace(key_id, lambda record: record if record.revoked_at
                    else record.model_copy(update={"revoked_at": _now()}), actor_id, "member.revoke")


def _replace(key_id: str, change, actor_id: str | None, action: str) -> GatewayKeyRecord:
    with _lock():
        config = _read_config_locked()
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
        if updated.revoked_at:
            from character_workflow.lib.gateway_share_store import revoke_owner_locked
            revoke_owner_locked(key_id)
        gateway_audit.append(action, record.id, {"before": _summary(record), "after": _summary(updated)}, actor)
        return updated


def _summary(record):
    return record.model_dump(mode="json", include={"name", "role", "quota", "scope", "revoked_at"})


def reveal_token(key_id: str) -> str:
    record = next((key for key in read_config().keys if key.id == key_id), None)
    if record is None or record.revoked_at or not record.token:
        raise NoSuchGatewayKeyError(key_id)
    return record.token


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
