"""模型路由成员状态，仅限本机管理会话。"""
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from character_workflow.lib import gateway_audit, gateway_keys, keys, model_routes
from character_workflow.lib.schemas import ModelRouteMemberStatusResponse

member_status_router = APIRouter(prefix="/api/model-routes/member-status")


@member_status_router.get("", response_model=ModelRouteMemberStatusResponse)
def gateway_members() -> dict:
    routes = model_routes.list_routes()
    statuses = model_routes.member_statuses() + model_routes.temporary_member_statuses()
    return {
        "members": [{**row, "route_ids": [route.id for route in routes
                     if route.modality == row["modality"]
                     and any(m.alias == row["alias"] and m.provider != "atelier"
                             for m in route.members)]} for row in statuses],
        "unavailable_routes": [{"id": route.id, "name": route.name, "modality": route.modality}
                               for route in routes
                               if (members := [m for m in route.members if m.provider != "atelier"])
                               and all(model_routes.balance_blocked(route.modality, m.alias)
                                       for m in members)],
    }


class GatewayMemberRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modality: keys.ModelModality
    alias: str = Field(min_length=1)


@member_status_router.post("/restore", response_model=ModelRouteMemberStatusResponse)
def restore_gateway_member(body: GatewayMemberRestore) -> dict:
    restore_member(body.modality, body.alias)
    return gateway_members()

def restore_member(modality, alias, actor=None):
    with gateway_keys._lock():
        current = gateway_keys.require_admin(gateway_keys._read_config_locked(), actor.id if actor else None)
        before = [row for row in model_routes.member_statuses() if row["alias"] == alias and row["modality"] == modality]
        model_routes.clear_member_status(modality, alias)
        gateway_audit.append("upstream.restore", alias, {"modality": modality, "before": before, "after": "available"}, current)
