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


def is_unpriced_route(route: model_routes.ModelRoute) -> bool:
    """自定义接口一律未计价；路由 id 带模板 id，组内只会是同一模板的成员。"""
    return any(m.protocol == "declarative" for m in route.members)


def blocked_by_limits(key: GatewayKeyRecord, route: model_routes.ModelRoute) -> bool:
    # 金额上限是为了控制花费：未计价的模型无法计入上限，设了上限的密钥一律不能用。
    return bool(key.limits) and is_unpriced_route(route)


def declared_view(route: model_routes.ModelRoute) -> dict | None:
    """给接入端的能力快照：只含能力，不含模板正文、模板 id、路径与鉴权方式。"""
    for member in route.members:
        declared = member_declared(member)
        if declared and declared["available"]:
            return {name: value for name, value in declared.items()
                    if name not in {"available", "error", "name"}}
    return None


def route_visible(key: GatewayKeyRecord, route: model_routes.ModelRoute) -> bool:
    return (publishable(route) and not blocked_by_limits(key, route)
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
    if blocked_by_limits(key, route):
        raise GatewayRequestError(
            403, f"这把密钥设了金额上限，不能用未计价的模型「{route.name}」：它的费用无法计入上限，"
                 "请联系管理员调整密钥")
    if not route_visible(key, route):
        raise GatewayRequestError(403, f"这把密钥能用的供应商都不提供 {route_id}")
    return route
