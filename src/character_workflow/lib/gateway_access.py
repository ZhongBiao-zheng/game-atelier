"""Gateway route and upstream-member permissions; never relay to another gateway."""
from character_workflow.lib import model_routes
from character_workflow.lib.gateway_keys import GatewayKeyRecord


def member_in_scope(key: GatewayKeyRecord, member: model_routes.RouteMember) -> bool:
    """这把密钥能不能用这个路由成员（某供应商的某个模型）。范围判定的唯一来源（第 7 批）：
    成员列表、执行时挑成员、文本中转、「自动」都只用它。"""
    if key.scope is None:
        return True
    entry = next((item for item in key.scope if item.alias == member.alias), None)
    return entry is not None and (entry.models is None or member.model_id in entry.models)


def member_relayable(modality: str, member: model_routes.RouteMember) -> bool:
    """网关能不能转这个成员：文本成员目前只转 OpenAI 格式（Chat / Responses）。

    接入端始终按 OpenAI 格式打网关；Anthropic 等协议要等主机端转换才放进来。
    临时边界（ADR-0044），第 4 批完成后移除。"""
    from character_workflow.lib.llm_protocols import speaks_openai

    return modality != "text" or speaks_openai(member.protocol)


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
    return publishable(route) and any(
        m.provider != "atelier" and member_in_scope(key, m) and member_relayable(route.modality, m)
        for m in route.members)


def check_route(key: GatewayKeyRecord, modality, route_id: str) -> model_routes.ModelRoute:
    from character_workflow.lib.gateway_tasks import GatewayRequestError

    try:
        route = model_routes.find_route(modality, route_id)
    except model_routes.NoSuchRouteError as error:
        raise GatewayRequestError(404, f"网关没有模型 {route_id}") from error
    if not publishable(route) or not any(m.provider != "atelier" for m in route.members):
        raise GatewayRequestError(404, f"网关没有模型 {route_id}")
    if not route_visible(key, route):
        raise GatewayRequestError(403, f"这把密钥不能用模型 {route_id}")
    return route
