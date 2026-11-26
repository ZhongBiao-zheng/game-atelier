"""Local-session management and explicit proxy routes for LAN shared canvases."""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import collab_config as config
from character_workflow.lib.canvas_projects import canvas_project_lock_path, read_canvas_project
from character_workflow.lib.collab_discovery import Peer, discovery, lan_endpoint
from character_workflow.lib.file_lock import file_lock
from viewer_server.collab_app import collab_server, manifest, owner_name
from viewer_server.collab_proxy import authenticate_remote, has_token, remote_json, stream_media
from viewer_server.gateway_app import lan_addresses

router = APIRouter(prefix="/api/collab")
REMOTE = "/remote/{peer_key}/projects/{project_id}"


class Address(BaseModel):
    model_config = ConfigDict(extra="forbid")
    address: str = Field(min_length=1, max_length=80)


class Passcode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passcode: str = Field(default="", max_length=200)


def display_name():
    name = owner_name()
    if not name:
        raise HTTPException(422, "请先填写团队显示名")
    return name


def own_cards():
    current = manifest()
    if not current.shares:
        return []
    return [{**card, "authenticated": True} for card in Peer("self", current, 0, 0).cards(is_self=True)]


@router.get("/status")
def status():
    return {"running": collab_server.running, "port": collab_server.port,
            "share_count": len(config.read_config().shares),
            "addresses": lan_addresses() if collab_server.running else []}


@router.get("/shares")
def shares():
    return {"shares": own_cards()}


@router.put("/shares/{project_id}")
def save_share(project_id: str, body: config.ShareSettings):
    display_name()
    try:
        with file_lock(canvas_project_lock_path(project_id)):
            read_canvas_project(project_id)
            config.enable_share(project_id, body)
    except KeyError:
        raise HTTPException(404, "找不到画布") from None
    try:
        collab_server.apply_saved()
    except OSError:
        raise HTTPException(503, "无法启用共享端口") from None
    discovery.broadcast(collab_server.beacon())
    return shares()


def _disable_locked(project_id: str):
    try:
        lock = canvas_project_lock_path(project_id)
    except KeyError:
        # An already deleted project's remaining config can only be revoked.
        config.disable_share(project_id)
        return
    with file_lock(lock):
        config.disable_share(project_id)


@router.delete("/shares/{project_id}")
def stop_share(project_id: str):
    _disable_locked(project_id)
    collab_server.apply_saved()
    return shares()


@router.post("/shares/stop-all")
def stop_all():
    for project_id in config.read_config().shares:
        _disable_locked(project_id)
    collab_server.apply_saved()
    return {"shares": []}


@router.get("/peers")
def peers(request: Request):
    # A manual address and a UDP interface can point at the same room. Prefer the
    # endpoint this browser authenticated, then its saved manual address.
    manual = set(config.read_config().manual_peers)
    rooms = {}
    for peer in discovery.online():
        for card in peer.cards():
            project_id = card["project_id"]
            authenticated = has_token(request, peer.key, project_id)
            priority = (authenticated, peer.address in manual, peer.key)
            room = peer.manifest.host_id, project_id
            if room not in rooms or priority > rooms[room][0]:
                rooms[room] = priority, {**card, "authenticated": authenticated}
    cards = sorted((card for _, card in rooms.values()), key=lambda card: card["updated_at"], reverse=True)
    return {"shares": own_cards() + cards}


@router.post("/peers/manual")
def add_peer(body: Address, request: Request):
    try:
        address = lan_endpoint(body.address)
        discovery.probe(address)
        config.set_manual_peer(address, enabled=True)
    except ValueError:
        raise HTTPException(422, "共享主机地址或清单无效") from None
    except (OSError, httpx.HTTPError):
        raise HTTPException(503, "无法连接共享主机") from None
    return peers(request)


@router.delete("/peers/manual")
def remove_peer(body: Address, request: Request):
    try:
        address = lan_endpoint(body.address)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    config.set_manual_peer(address, enabled=False)
    discovery.forget(address)
    return peers(request)


@router.post(REMOTE + "/auth")
def auth(peer_key: str, project_id: str, body: Passcode, request: Request):
    return authenticate_remote(request, peer_key, project_id, display_name(), body.passcode)


@router.get(REMOTE + "/document")
def document(peer_key: str, project_id: str, request: Request):
    return remote_json(request, peer_key, project_id, "document")


@router.get(REMOTE + "/versions/{version_id}/media")
def media(peer_key: str, project_id: str, version_id: str, request: Request, thumb: bool = False):
    return stream_media(request, peer_key, project_id, version_id, thumb=thumb)


@router.get(REMOTE + "/cover")
def cover(peer_key: str, project_id: str, request: Request):
    return stream_media(request, peer_key, project_id, thumb=True)
