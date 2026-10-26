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
    return {"models": [{"id": route.id, "name": route.name, "modality": route.modality,
                        "aliases": [m.alias for m in route.members if m.provider != "atelier"]}
                       for route in model_routes.list_routes()
                       if any(m.provider != "atelier" for m in route.members)]}


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

    @router.get("/keys")
    def members():
        return {"keys": [_key_view(key) for key in gateway_keys.read_config().keys]}

    @router.post("/keys", status_code=201)
    def create(body: GatewayKeyCreate, actor=Depends(admin)):
        key, token = gateway_keys.create_key(**body.model_dump(), actor_id=actor.id)
        return {"key": _key_view(key), "token": token}

    @router.patch("/keys/{key_id}")
    def update(key_id: str, body: GatewayKeyPatch, actor=Depends(admin)):
        return _key_view(gateway_keys.update_key(
            key_id, **body.model_dump(exclude_unset=True), actor_id=actor.id))

    @router.post("/keys/{key_id}/revoke")
    def revoke(key_id: str, actor=Depends(admin)):
        return _key_view(gateway_keys.revoke_key(key_id, actor_id=actor.id))

    @router.get("/options")
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
                    offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
        return get_usage_tasks(scope="team", range=range, member=member,
                               status=status, offset=offset, limit=limit)

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
                    await asyncio.to_thread(gateway_keys.require_admin, gateway_keys.read_config(), actor.id)
                    try:
                        task = await asyncio.wait_for(queue.get(), timeout=4)
                        await asyncio.to_thread(gateway_keys.require_admin, gateway_keys.read_config(), actor.id)
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
