"""本机共享开关与成员代理；只用已保存的渠道凭据，不接收任意 URL 或本机路径。"""
import asyncio
from urllib.parse import quote

import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, TypeAdapter

from character_workflow.lib import gateway_keys, keys, team_library
from character_workflow.lib.callers import atelier_gateway
from viewer_server.gateway_libraries import SharedEntry, SharedLibrary

router = APIRouter()


class ShareUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


@router.get("/api/team-library-gateway-share")
def share_state():
    return {"shared_library_ids": sorted(team_library.shared_library_ids()),
            "gateway_enabled": gateway_keys.read_config().enabled}


@router.put("/api/team-library-gateway-share/{library_id}")
def update_share(library_id: str, body: ShareUpdate):
    if body.enabled and not gateway_keys.read_config().enabled:
        raise HTTPException(409, "请先开启网关")
    try:
        team_library.set_gateway_shared(library_id, body.enabled)
    except KeyError:
        raise HTTPException(404, "团队库不存在") from None
    return share_state()


def _provider(alias: str):
    key = keys.find_by_alias(alias)
    if not key or key.provider != "atelier" or not key.enabled or not key.base_url:
        raise HTTPException(404, "已停止共享")
    return key


def _fetch(key, suffix: str, *, thumbnail: bool = False, w: int = 512):
    # 禁止重定向，避免把网关凭据转发给别的地址；异常不透传上游文本或 URL。
    with atelier_gateway._session() as session:
        try:
            with session.get(key.base_url.rstrip("/") + "/gateway/v1/libraries" + suffix,
                             headers={"Authorization": f"Bearer {key.access_key}"},
                             params={"w": w} if thumbnail else None,
                             timeout=3, allow_redirects=False) as response:
                if response.status_code != 200:
                    raise HTTPException(404 if response.status_code == 404 else 502, "已停止共享")
                if thumbnail:
                    if response.headers.get("Content-Type", "").split(";")[0] != "image/webp":
                        raise ValueError("缩略图格式不正确")
                    return response.content
                model = SharedEntry if suffix else SharedLibrary
                # 双端都按白名单校验，误配到旧网关或非 Atelier 服务也不透传额外字段。
                return TypeAdapter(list[model]).validate_python(response.json())
        except (requests.RequestException, ValueError):
            raise HTTPException(502, "已停止共享") from None


@router.get("/api/gateway-libraries")
async def discover():
    providers = await asyncio.to_thread(keys.read_keys_db)

    async def one(key):
        try:
            if not key.enabled or not key.base_url:
                raise HTTPException(404)
            libraries = await asyncio.to_thread(_fetch, key, "")
            return {"gateway_alias": key.alias, "owner_name": libraries[0].owner_name if libraries else key.alias,
                    "unreachable": False, "libraries": libraries}
        except HTTPException:
            return {"gateway_alias": key.alias, "owner_name": key.alias,
                    "unreachable": True, "libraries": []}

    return await asyncio.gather(*(one(key) for key in providers.keys if key.provider == "atelier"))


def _path(library_id: str, entry_id: str | None = None):
    suffix = "/" + quote(library_id, safe="") + "/assets"
    return suffix if entry_id is None else suffix + "/" + quote(entry_id, safe="")


@router.get("/api/gateway-libraries/{alias}/{library_id}/assets", response_model=list[SharedEntry],
            response_model_exclude_none=True)
def assets(alias: str, library_id: str):
    return _fetch(_provider(alias), _path(library_id))


def _thumb(alias: str, library_id: str, entry_id: str, w: int, n: int | None = None):
    suffix = _path(library_id, entry_id) + ("/thumb" if n is None else f"/previews/{n}/thumb")
    body = _fetch(_provider(alias), suffix, thumbnail=True, w=w)
    return Response(body, media_type="image/webp", headers={"Cache-Control": "private, max-age=60"})


@router.get("/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/thumb")
def thumb(alias: str, library_id: str, entry_id: str, w: int = Query(512, ge=1, le=1024)):
    return _thumb(alias, library_id, entry_id, w)


@router.get("/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/previews/{n}/thumb")
def preview(alias: str, library_id: str, entry_id: str, n: int, w: int = Query(512, ge=1, le=1024)):
    return _thumb(alias, library_id, entry_id, w, n)
