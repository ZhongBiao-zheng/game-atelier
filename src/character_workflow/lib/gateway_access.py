"""Gateway route and upstream-member permissions; never relay to another gateway."""
from character_workflow.lib import model_routes
from character_workflow.lib.gateway_keys import GatewayKeyRecord


def member_allowed(key: GatewayKeyRecord, alias: str) -> bool:
    return key.allowed_aliases is None or alias in key.allowed_aliases


def model_allowed(key: GatewayKeyRecord, route_id: str) -> bool:
    return key.allowed_models is None or any(
        route_id == pattern or (pattern.endswith("*") and route_id.startswith(pattern[:-1]))
        for pattern in key.allowed_models
    )


def member_declared(member: model_routes.RouteMember) -> dict | None:
    """自定义接口成员的能力声明（ADR-0036）；不是自定义接口返回 None。"""
    if member.protocol != "declarative":
        return None
    from character_workflow.lib import keys
    from character_workflow.lib.http_protocols import declared_for

    key = keys.find_by_alias(member.alias)
    model = next((m for m in (key.models if key else []) if m.id == member.model_id), None)
    return declared_for(model) or {"available": False, "error": "自定义接口不存在", "name": None}


def publishable(route: model_routes.ModelRoute) -> bool:
    """发布判据的唯一来源：组内每个自定义接口成员的模板都可用。成员列表、提交与管理视图共用。"""
    return all((declared := member_declared(m)) is None or declared["available"]
               for m in route.members)


def declared_view(route: model_routes.ModelRoute) -> dict | None:
    """给接入端的能力快照：只含能力，不含模板正文、模板 id、路径与鉴权方式。"""
    for member in route.members:
        declared = member_declared(member)
        if declared and declared["available"]:
            return {name: value for name, value in declared.items()
                    if name not in {"available", "error", "name"}}
    return None


def route_visible(key: GatewayKeyRecord, route: model_routes.ModelRoute) -> bool:
    # 未计价的路由限额密钥也能用（飙哥 2026-11-18 定）：额度用光后由受理时的额度检查一律拦下。
    return (publishable(route)
            and model_allowed(key, route.id) and any(
                m.provider != "atelier" and member_allowed(key, m.alias) for m in route.members))


def check_route(key: GatewayKeyRecord, modality, route_id: str) -> model_routes.ModelRoute:
    from character_workflow.lib.gateway_tasks import GatewayRequestError

    try:
        route = model_routes.find_route(modality, route_id)
    except model_routes.NoSuchRouteError as error:
        raise GatewayRequestError(404, f"网关没有模型 {route_id}") from error
    if not publishable(route) or not any(m.provider != "atelier" for m in route.members):
        raise GatewayRequestError(404, f"网关没有模型 {route_id}")
    if not model_allowed(key, route_id):
        raise GatewayRequestError(403, f"这把密钥不能用模型 {route_id}")
    if not route_visible(key, route):
        raise GatewayRequestError(403, f"这把密钥能用的供应商都不提供 {route_id}")
    return route
