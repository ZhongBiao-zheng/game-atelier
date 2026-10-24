"""模型路由：同一模型的多个供应商成员组成路由组，选「自动」时按组内顺序解析 KEY。

成员 = 某个 KEY 下的某个模型。路由 id = 去掉厂商前缀后转小写，所以 OpenRouter 的
`openai/gpt-image-2` 与 Tuzi 的 `gpt-image-2` 是同一组。只做这两步，路由 id 与无前缀渠道的
模型 id 保持一致，前端按模型 id 查的能力 / 价目表可以直接用。视频模型的参数随协议变化，协议不同的成员不进同一组：路由 id 前缀协议名。
图片的能力族由模型 id 决定，同一路由 id 必然同族，不需要额外区分。

组内默认顺序：`default_alias` 第一，其余按 keys.json 顺序；`model_order` 只存调整过的组。
"""
from __future__ import annotations

import re
import json
import logging
from datetime import datetime, timedelta, timezone
import threading
import time
from dataclasses import dataclass
from typing import Literal

import requests

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.keys import (
    KeysDB,
    KeySpec,
    ModelModality,
    ModelSpec,
    model_modality,
    read_keys_db,
    write_keys_db,
)


class NoSuchRouteError(LookupError):
    def __init__(self, modality: str, route_id: str) -> None:
        super().__init__(f"未配置模型 {route_id}，请在设置中接入")
        self.modality = modality
        self.route_id = route_id


class InsufficientBalanceError(ValueError):
    def __init__(self, identifier: str) -> None:
        super().__init__(f"{identifier} 的供应商都欠费了")


class InvalidRouteOrderError(ValueError):
    pass


@dataclass(frozen=True)
class RouteMember:
    alias: str
    provider: str
    base_url: str | None
    model_id: str
    name: str
    protocol: str | None
    # 成员是局域网 Atelier 时：网关那边的成员快照（能力、估价按它算）。
    via: tuple[dict, ...] = ()
    billing_group: str | None = None


@dataclass(frozen=True)
class ModelRoute:
    id: str
    modality: ModelModality
    members: tuple[RouteMember, ...]

    @property
    def name(self) -> str:
        return self.members[0].name


def route_id(model: ModelSpec, key: KeySpec) -> str:
    base = model.id.rsplit("/", 1)[-1].lower()
    if model_modality(model, key) == "video" and model.protocol:
        if key.provider == "atelier":
            return base
        return f"{model.protocol}:{base}"
    return base


def _default_key_order(database: KeysDB) -> list[KeySpec]:
    return sorted(database.keys, key=lambda key: 0 if key.alias == database.default_alias else 1)


def _ordered(members: list[RouteMember], preferred: list[str]) -> tuple[RouteMember, ...]:
    rank = {alias: index for index, alias in enumerate(preferred)}
    return tuple(sorted(members, key=lambda member: rank.get(member.alias, len(rank))))


def _routes(database: KeysDB) -> list[ModelRoute]:
    grouped: dict[tuple[ModelModality, str], list[RouteMember]] = {}
    for key in _default_key_order(database):
        for model in key.models:
            modality = model_modality(model, key)
            members = grouped.setdefault((modality, route_id(model, key)), [])
            # 同一 KEY 下重复登记同一模型时只取第一条，组内一个 KEY 只出现一次。
            if any(member.alias == key.alias for member in members):
                continue
            members.append(RouteMember(
                alias=key.alias, provider=key.provider, base_url=key.base_url,
                model_id=model.id, name=model.name or model.id, protocol=model.protocol,
                via=tuple(item.model_dump() for item in model.via or ()),
                billing_group=key.billing_group,
            ))
    return [
        ModelRoute(
            id=identifier, modality=modality,
            members=_ordered(members, database.model_order.get(modality, {}).get(identifier, [])),
        )
        for (modality, identifier), members in grouped.items()
    ]


def list_routes(modality: ModelModality | None = None) -> list[ModelRoute]:
    return [
        route for route in _routes(read_keys_db())
        if modality is None or route.modality == modality
    ]


def find_route(modality: ModelModality, identifier: str) -> ModelRoute:
    for route in list_routes(modality):
        if route.id == identifier:
            return route
    raise NoSuchRouteError(modality, identifier)


def resolve_auto(modality: ModelModality, identifier: str) -> tuple[KeySpec, ModelSpec]:
    """「自动」选择：组内第一个不在冷却中的成员；全都在冷却时只兜底非欠费成员。"""
    route = find_route(modality, identifier)
    member = next((m for m in route.members if not _cooling(modality, m.alias)), None)
    if member is None:
        member = next((m for m in route.members if not balance_blocked(modality, m.alias)), None)
    if member is None:
        raise InsufficientBalanceError(identifier)
    return _member_key_and_model(member)


def next_member(
    modality: ModelModality, identifier: str, exclude: list[str],
) -> tuple[KeySpec, ModelSpec] | None:
    """失败切换用：组内下一个没试过、不在冷却中的成员；没有就返回 None（不再换）。"""
    try:
        route = find_route(modality, identifier)
    except NoSuchRouteError:
        return None
    member = next((m for m in route.members
                   if m.alias not in exclude and not _cooling(modality, m.alias)), None)
    return _member_key_and_model(member) if member else None


def _member_key_and_model(member: RouteMember) -> tuple[KeySpec, ModelSpec]:
    database = read_keys_db()
    key = next(item for item in database.keys if item.alias == member.alias)
    model = next(item for item in key.models if item.id == member.model_id)
    return key, model


# ---- 失败切换：只认「请求确定没被执行」的失败 ----
#
# 换下一家的前提是上一家没出图也没开始出图，否则就是付两次钱拿一张图（被拒的请求照样
# 计费，但那笔钱换不换都花了）。超时、5xx、连上后被掐、响应解析失败一律不换：上游可能
# 已经在跑。参数错误、内容审核（多为 400）也不换：换哪家都一样会失败，只会多花钱。

FailoverReason = Literal["unreachable", "auth", "unavailable", "rate_limited", "insufficient_balance"]

FAILOVER_LABELS: dict[FailoverReason, str] = {
    "unreachable": "连不上",
    "auth": "密钥无效或没有权限",
    "unavailable": "没有开通这个模型",
    "rate_limited": "限流",
    "insufficient_balance": "欠费",
}

_COOLDOWN_SECONDS: dict[FailoverReason, float] = {
    "unreachable": 120,
    "rate_limited": 300,
    "insufficient_balance": 3600,
    "auth": 1800,
    "unavailable": 1800,
}

_STATUS = re.compile(r"(?:\bapi|\bHTTP)\s*(\d{3})\b")
_UNAVAILABLE_MARKERS = (
    "no_endpoints_available", "model_not_found", "no available channel", "无可用渠道",
    "模型不存在", "not support model", "gateway_unavailable",
)
_BALANCE_MARKERS = ("insufficient_quota", "insufficient balance", "余额不足", "额度不足")


def failover_reason(error: BaseException) -> FailoverReason | None:
    """这次失败能不能换下一家；能就返回原因，不能返回 None。"""
    from character_workflow.lib.callers.openai_image import _is_pre_flight_failure

    chain: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and current not in chain:
        chain.append(current)
        current = current.__cause__
    if any(isinstance(item, requests.RequestException) for item in chain):
        network = next(item for item in chain if isinstance(item, requests.RequestException))
        return "unreachable" if _is_pre_flight_failure(network) else None
    text = " ".join(str(item) for item in chain)
    low = text.lower()
    if "未确认" in text or "gateway_upstream_error" in low:
        return None
    # 网关已在内部换过家：错误文案里转述的上游欠费属于网关成员，不能让接入端把整个网关标成欠费。
    if "gateway_unavailable" in low:
        return "unavailable"
    match = _STATUS.search(text)
    status = int(match.group(1)) if match else None
    if status == 402 or any(marker in low for marker in _BALANCE_MARKERS):
        return "insufficient_balance"
    if status == 429 or "quota exceeded" in low:
        return "rate_limited"
    if status in (401, 403):
        return "auth"
    if status == 404 or (status == 503 and any(marker in low for marker in _UNAVAILABLE_MARKERS)):
        return "unavailable"
    return None


_cooldowns: dict[tuple[str, str], float] = {}
_cooldowns_lock = threading.Lock()


def cool_down(modality: str, alias: str, reason: FailoverReason, seconds: float | None = None) -> None:
    """欠费跨进程持久化；其他失败保留短期内存冷却。"""
    if reason == "insufficient_balance" and _is_gateway_alias(alias):
        # 欠费由网关按自己的成员记；网关本身只会「暂时不可用」。
        reason = "unavailable"
    if reason == "insufficient_balance":
        with file_lock(_status_file().with_suffix(".lock")):
            members = member_statuses()
            previous = next((m for m in members
                             if m["modality"] == modality and m["alias"] == alias), None)
            now = _now()
            row = {"modality": modality, "alias": alias, "reason": reason,
                   "since": previous["since"] if previous else now.isoformat(),
                   "next_probe_at": (now + timedelta(seconds=_COOLDOWN_SECONDS[reason])).isoformat()}
            members = [m for m in members if (m["modality"], m["alias"]) != (modality, alias)]
            atomic_write_json(_status_file(), {"members": [*members, row]})
        return
    with _cooldowns_lock:
        _cooldowns[(modality, alias)] = time.monotonic() + (seconds if seconds is not None else _COOLDOWN_SECONDS[reason])


def _cooling(modality: str, alias: str) -> bool:
    with _cooldowns_lock:
        until = _cooldowns.get((modality, alias))
        if until is not None:
            if until > time.monotonic():
                return True
            del _cooldowns[(modality, alias)]
    return balance_blocked(modality, alias)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _status_file():
    return data_root.runtime_dir() / "route-member-status.json"


def member_statuses() -> list[dict]:
    path = _status_file()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        members = payload["members"]
        if not isinstance(members, list):
            raise ValueError("members must be a list")
        for row in members:
            if (row["modality"] not in ("image", "video", "audio", "text")
                    or not isinstance(row["alias"], str)
                    or row["reason"] != "insufficient_balance"):
                raise ValueError("invalid member status")
            for field in ("since", "next_probe_at"):
                if datetime.fromisoformat(row[field]).tzinfo is None:
                    raise ValueError("status timestamp must have timezone")
        return members
    except FileNotFoundError:
        return []
    except (OSError, ValueError, TypeError, KeyError):
        logging.getLogger(__name__).warning("成员欠费状态文件损坏或不可读，按空状态处理")
        return []


def balance_blocked(modality: str, alias: str) -> bool:
    return any(row["modality"] == modality and row["alias"] == alias
               and _now() < datetime.fromisoformat(row["next_probe_at"])
               for row in member_statuses())


def _is_gateway_alias(alias: str) -> bool:
    return any(key.alias == alias and key.provider == "atelier" for key in read_keys_db().keys)


def mark_healthy(modality: str, alias: str) -> None:
    """成功后清除该成员欠费状态；没有记录时不写盘。"""
    with file_lock(_status_file().with_suffix(".lock")):
        members = member_statuses()
        kept = [m for m in members if (m["modality"], m["alias"]) != (modality, alias)]
        if len(kept) != len(members):
            atomic_write_json(_status_file(), {"members": kept})


def clear_member_status(modality: str, alias: str) -> None:
    mark_healthy(modality, alias)
    with _cooldowns_lock:
        _cooldowns.pop((modality, alias), None)


def put_alias_first(alias: str, *, only_unordered: bool = False) -> None:
    """把某个 KEY 排到它所在每个路由组的第一位（新加网关供应商时用）。

    only_unordered=True 时只处理保存的顺序里还没有它的组（同步后新出现的模型），
    不覆盖用户调整过的顺序。
    """
    database = read_keys_db()
    changed = False
    for route in _routes(database):
        aliases = [member.alias for member in route.members]
        if alias not in aliases or aliases[0] == alias:
            continue
        saved = database.model_order.get(route.modality, {}).get(route.id, [])
        if only_unordered and alias in saved:
            continue
        database.model_order.setdefault(route.modality, {})[route.id] = [
            alias, *(item for item in aliases if item != alias)]
        changed = True
    if changed:
        write_keys_db(database)


def set_route_order(modality: ModelModality, identifier: str, aliases: list[str]) -> ModelRoute:
    route = find_route(modality, identifier)
    if sorted(aliases) != sorted(member.alias for member in route.members):
        raise InvalidRouteOrderError("顺序必须恰好包含该模型的全部供应商")
    database = read_keys_db()
    database.model_order.setdefault(modality, {})[identifier] = list(aliases)
    write_keys_db(database)
    return find_route(modality, identifier)


def temporary_member_statuses() -> list[dict]:
    """公开当前进程的短期冷却快照，不把临时故障写成欠费。"""
    now = _now()
    tick = time.monotonic()
    with _cooldowns_lock:
        return [
            {"modality": modality, "alias": alias, "reason": "unavailable",
             "since": None, "next_probe_at": (now + timedelta(seconds=until - tick)).isoformat()}
            for (modality, alias), until in _cooldowns.items() if until > tick
        ]
