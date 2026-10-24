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


def route_visible(key: GatewayKeyRecord, route: model_routes.ModelRoute) -> bool:
    return model_allowed(key, route.id) and any(
        m.provider != "atelier" and member_allowed(key, m.alias) for m in route.members
    )


def check_route(key: GatewayKeyRecord, modality, route_id: str) -> model_routes.ModelRoute:
    from character_workflow.lib.gateway_tasks import GatewayRequestError

    try:
        route = model_routes.find_route(modality, route_id)
    except model_routes.NoSuchRouteError as error:
        raise GatewayRequestError(404, f"网关没有模型 {route_id}") from error
    if not any(m.provider != "atelier" for m in route.members):
        raise GatewayRequestError(404, f"网关没有模型 {route_id}")
    if not model_allowed(key, route_id):
        raise GatewayRequestError(403, f"这把密钥不能用模型 {route_id}")
    if not route_visible(key, route):
        raise GatewayRequestError(403, f"这把密钥能用的供应商都不提供 {route_id}")
    return route
