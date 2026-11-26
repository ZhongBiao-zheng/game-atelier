"""管理员网关 API：复用本机管理能力，不暴露上游凭据或文件接口。"""
import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from character_workflow.lib import gateway_audit, gateway_keys, gateway_live, model_routes


class RestoreBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modality: Literal["image", "video", "audio", "text"]


def route_options() -> dict:
    from character_workflow.lib import gateway_access

    return {"models": [{"id": route.id, "name": route.name, "modality": route.modality,
                        "aliases": [m.alias for m in route.members if m.provider != "atelier"]}
                       for route in model_routes.list_routes()
                       if any(m.provider != "atelier" for m in route.members)
                       and gateway_access.publishable(route)]}


def scope_options() -> dict:
    """设置页密钥范围弹层的选项：按供应商分组列出它能经网关提供的模型（第 7 批）。

    模型 id 是供应商自己的 model id（范围按它记）；停用的供应商也列出（enabled=False），界面灰显、不能勾。"""
    from character_workflow.lib import gateway_access, keys

    providers: dict[str, dict] = {}
    for route in model_routes.list_routes():
        if not gateway_access.publishable(route):
            continue
        for member in route.members:
            if member.provider == "atelier" or not gateway_access.member_relayable(route.modality, member):
                continue
            entry = providers.setdefault(member.alias, {
                "alias": member.alias, "provider": member.provider, "enabled": True, "models": []})
            if all(model["id"] != member.model_id for model in entry["models"]):
                entry["models"].append({"id": member.model_id, "name": member.name,
                                        "modality": route.modality, "route_id": route.id})
    for key in keys.read_keys_db().keys:
        if key.provider != "atelier" and not key.enabled and key.alias not in providers:
            providers[key.alias] = {"alias": key.alias, "provider": key.provider, "enabled": False, "models": [
                {"id": model.id, "name": model.name or model.id, "modality": model.modality, "route_id": None}
                for model in key.models if model.id]}
    return {"providers": list(providers.values())}


def _same_admin_api(request: Request) -> None:
    """成员密钥的管理接口只接受同一版本的远程管理端（第 7 批）。

    旧版本机代理不带这个请求头，也解析不了新形状（scope / quota）：回一个旧版能照常显示的错误，
    而不是让它的设置页拿到读不懂的数据后白屏。用量、任务、路由等形状没变的接口不查。"""
    from character_workflow.lib.callers import atelier_gateway

    if request.headers.get(atelier_gateway.ADMIN_API_HEADER) != str(atelier_gateway.ADMIN_API_VERSION):
        raise HTTPException(426, "远程管理需要本机与主机是同一版本的 Cobrush：请把两边都更新到最新版本后再管理成员")


def create_router(require_key):
    from viewer_server.gateway_routes import (
        GatewayKeyCreate, GatewayKeyPatch, _key_view, gateway_options, gateway_task_list,
    )
    from viewer_server.model_route_status import gateway_members, restore_member
    from viewer_server.routes import _ModelOrderPayload, change_route_order
    from viewer_server.usage_routes import get_usage, get_usage_tasks

    def admin(key=Depends(require_key)):
        if key.role != "admin":
            raise HTTPException(403, "需要管理员密钥")
        return key

    router = APIRouter(prefix="/gateway/v1/admin", dependencies=[Depends(admin)])
    same_version = [Depends(_same_admin_api)]

    @router.get("/keys", dependencies=same_version)
    def members():
        return {"keys": [_key_view(key) for key in gateway_keys.read_config().keys]}

    @router.post("/keys", status_code=201, dependencies=same_version)
    def create(body: GatewayKeyCreate, actor=Depends(admin)):
        try:
            key, token = gateway_keys.create_key(**body.model_dump(), actor_id=actor.id)
        except gateway_keys.CustomGatewayTokenError as error:
            raise HTTPException(422, str(error)) from None
        return {"key": _key_view(key), "token": token}

    @router.patch("/keys/{key_id}", dependencies=same_version)
    def update(key_id: str, body: GatewayKeyPatch, actor=Depends(admin)):
        return _key_view(gateway_keys.update_key(
            key_id, **body.model_dump(exclude_unset=True), actor_id=actor.id))

    @router.post('/keys/{key_id}/reset', dependencies=same_version)
    def reset(key_id: str, actor=Depends(admin)):
        key, token = gateway_keys.reset_key(key_id, actor_id=actor.id)
        return {'key': _key_view(key), 'token': token}

    @router.post("/keys/{key_id}/revoke", dependencies=same_version)
    def revoke(key_id: str, actor=Depends(admin)):
        return _key_view(gateway_keys.revoke_key(key_id, actor_id=actor.id))

    @router.get("/options", dependencies=same_version)
    def options():
        return gateway_options()

    @router.get("/usage")
    def usage(range: Literal["today", "7d", "30d", "90d", "all"] = "30d",
              member: str | None = None):
        return get_usage(scope="team", range=range, member=member)

    @router.get("/usage/tasks")
    def usage_tasks(range: Literal["today", "7d", "30d", "90d", "all"] = "30d",
                    member: str | None = None,
                    status: Literal["all", "done", "failed", "unpriced"] = "all",
                    offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                    project: str | None = None, model: str | None = None,
                    alias: str | None = None, kind: str | None = None):
        return get_usage_tasks(scope="team", range=range, member=member,
                               status=status, offset=offset, limit=limit,
                               project=project, model=model, alias=alias, kind=kind)

    @router.get("/tasks")
    def tasks(scope: Literal["active", "recent"] = "active"):
        return gateway_task_list(scope)

    @router.get("/members")
    def upstream_members():
        return gateway_members()

    @router.post("/members/{alias}/restore")
    def restore(alias: str, body: RestoreBody, actor=Depends(admin)):
        restore_member(body.modality, alias, actor)
        return gateway_members()

    @router.get("/routes")
    def routes():
        return route_options()

    @router.put("/routes/order")
    def reorder(body: _ModelOrderPayload, actor=Depends(admin)):
        change_route_order(body, actor)
        return route_options()

    @router.get("/audit")
    def audit(limit: int = Query(200, ge=1, le=1000)):
        return {"entries": gateway_audit.read(limit)}

    @router.get("/live")
    async def live(request: Request, actor=Depends(admin)):
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue(maxsize=200)

        def enqueue(task):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(task)

        def notify(task):
            loop.call_soon_threadsafe(enqueue, task)

        async def events():
            gateway_live.listeners.append(notify)
            try:
                yield ": connected\n\n"
                while not await request.is_disconnected():
                    # 长连接亦实时撤权；不沿用连接建立时的角色快照。
                    await asyncio.to_thread(
                        lambda: gateway_keys.require_admin(gateway_keys.read_config(), actor.id))
                    try:
                        task = await asyncio.wait_for(queue.get(), timeout=4)
                        await asyncio.to_thread(
                            lambda: gateway_keys.require_admin(gateway_keys.read_config(), actor.id))
                        yield "event: task\ndata: " + json.dumps(task, ensure_ascii=False) + "\n\n"
                    except TimeoutError:
                        yield ": heartbeat\n\n"
            except gateway_keys.GatewayAdminError:
                # 鉴权撤销后结束流，浏览器轮询会获得明确的 401/403。
                return
            finally:
                gateway_live.listeners.remove(notify)

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    return router
