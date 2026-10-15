"""模型路由：同一模型的多个供应商成员组成路由组，选「自动」时按组内顺序解析 KEY。

成员 = 某个 KEY 下的某个模型。路由 id 取 `normalized_model_id`（去厂商前缀、小写、
`_` / `.` 归一为 `-`），所以 OpenRouter 的 `openai/gpt-image-2` 与 Tuzi 的 `gpt-image-2`
是同一组。视频模型的参数随协议变化，协议不同的成员不进同一组：路由 id 前缀协议名。
图片的能力族由模型 id 决定，同一路由 id 必然同族，不需要额外区分。

组内默认顺序：`default_alias` 第一，其余按 keys.json 顺序；`model_order` 只存调整过的组。
"""
from __future__ import annotations

from dataclasses import dataclass

from character_workflow.lib.callers.openai_image import normalized_model_id
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


@dataclass(frozen=True)
class ModelRoute:
    id: str
    modality: ModelModality
    members: tuple[RouteMember, ...]

    @property
    def name(self) -> str:
        return self.members[0].name


def route_id(model: ModelSpec, key: KeySpec) -> str:
    base = normalized_model_id(model.id)
    if model_modality(model, key) == "video" and model.protocol:
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
    """「自动」选择：返回组内第一个成员对应的 KEY 与模型。"""
    member = find_route(modality, identifier).members[0]
    database = read_keys_db()
    key = next(item for item in database.keys if item.alias == member.alias)
    model = next(item for item in key.models if item.id == member.model_id)
    return key, model


def set_route_order(modality: ModelModality, identifier: str, aliases: list[str]) -> ModelRoute:
    route = find_route(modality, identifier)
    if sorted(aliases) != sorted(member.alias for member in route.members):
        raise InvalidRouteOrderError("顺序必须恰好包含该模型的全部供应商")
    database = read_keys_db()
    database.model_order.setdefault(modality, {})[identifier] = list(aliases)
    write_keys_db(database)
    return find_route(modality, identifier)
