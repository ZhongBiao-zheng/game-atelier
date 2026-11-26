"""LAN-only application. Each shared project is a separately revocable room."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import socket
import threading
import time

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import collab_config as config
from character_workflow.lib.canvas_projects import (
    _cover_for_project, _resolve_canvas_media_version, read_canvas_document, read_canvas_project,
)
from character_workflow.lib.canvas_thumbnails import resolve_canvas_thumbnail
from character_workflow.lib.collab_sanitize import public_text
from character_workflow.lib.collab_discovery import Beacon, Card, Manifest, discovery, is_lan_ip
from character_workflow.lib.team_library import read_profile
from viewer_server import collab_access, loop_watch
from viewer_server.gateway_app import lan_addresses

logger = logging.getLogger(__name__)
PREFIX = "/collab/v1/projects/{project_id}"


class GuestAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=40)
    passcode: str = Field(default="", max_length=200)
    resume_proof: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    client_proof: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


def owner_name() -> str:
    profile = read_profile()
    return public_text(profile.display_name) if profile else ""


def manifest() -> Manifest:
    saved = config.read_config()
    cards = []
    for entry in saved.shares.values():
        if not entry.enabled:
            continue
        try:
            project = read_canvas_project(entry.project_id)
            document = read_canvas_document(entry.project_id)
            cover = _cover_for_project(entry.project_id, document)
        except (ValueError, KeyError, OSError):
            continue
        cards.append(Card(
            project_id=entry.project_id, name=public_text(project.name), node_count=len(document.nodes),
            cover_version_id=cover.version_id if cover else None, mode=entry.mode,
            requires_passcode=bool(entry.passcode_hash), access_epoch=entry.passcode_version,
            allow_borrow_provider=entry.allow_borrow_provider,
            online_count=collab_access.online_count(entry), updated_at=max(document.updated_at, entry.updated_at),
        ))
    return Manifest(protocol_version=config.COLLAB_PROTOCOL_VERSION, host_id=saved.host_id,
                    display_name=owner_name(), shares=cards)


def create_collab_app() -> FastAPI:
    from viewer_server.collab_transfer_routes import collab_transfer_lan_router

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    from viewer_server.update_routes import UpdateAdmissionMiddleware
    app.add_middleware(UpdateAdmissionMiddleware)
    from viewer_server.collab_ws import lan_ws
    from viewer_server.collab_uploads import lan_uploads
    app.include_router(lan_ws)
    app.include_router(lan_uploads)
    app.include_router(collab_transfer_lan_router)

    @app.middleware("http")
    async def native_only(request, call_next):
        # Browsers always enter through their own authenticated loopback proxy.
        if ("origin" in request.headers or "cookie" in request.headers
                or any(name.startswith("sec-fetch-") for name in request.headers)):
            return JSONResponse({"detail": "请通过本机 Atelier 进入"}, status_code=403)
        if not is_lan_ip(request.url.hostname or ""):
            return JSONResponse({"detail": "共享服务地址无效"}, status_code=421)
        if not request.client or not is_lan_ip(request.client.host):
            return JSONResponse({"detail": "仅限局域网访问"}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _error):
        return JSONResponse({"detail": "共享请求格式不正确"}, status_code=422)

    @app.get("/collab/v1/manifest")
    def get_manifest():
        return manifest()

    @app.post(PREFIX + "/auth")
    def auth(project_id: str, body: GuestAuth):
        name = body.display_name.strip()
        if not name:
            raise HTTPException(422, "请填写团队显示名")
        return collab_access.authenticate(project_id, body.passcode, name, body.client_proof, body.resume_proof)

    @app.get(PREFIX + "/document")
    def document(project_id: str, request: Request):
        from character_workflow.lib.collab_sanitize import public_document
        collab_access.require_guest(request, project_id)
        try:
            result = public_document(project_id)
            project = read_canvas_project(project_id)
        except (KeyError, FileNotFoundError):
            raise HTTPException(404, "找不到画布") from None
        except ValueError:
            raise HTTPException(422, "画布内容无法共享") from None
        collab_access.require_guest(request, project_id)
        entry = collab_access.share_entry(project_id)
        return {"document": result, "name": public_text(project.name), "owner_display_name": owner_name(),
                "mode": entry.mode, "allow_borrow_provider": entry.allow_borrow_provider,
                "protocol_version": config.COLLAB_PROTOCOL_VERSION}

    @app.get(PREFIX + "/cover")
    def cover(project_id: str):
        entry = collab_access.share_entry(project_id)
        if entry.passcode_hash:
            raise HTTPException(403, "需要口令的画布封面仅在进入后可见")
        doc = read_canvas_document(project_id)
        selected = _cover_for_project(project_id, doc)
        if not selected:
            raise HTTPException(404, "画布没有封面")
        path, version = _resolve_canvas_media_version(project_id, doc.content_versions[selected.version_id])
        preview = resolve_canvas_thumbnail(project_id, version, path, 256)
        if collab_access.share_entry(project_id).passcode_hash:
            raise HTTPException(403, "画布访问口令已变更")
        return FileResponse(preview or path, media_type="image/webp" if preview else version.mime_type)

    @app.get(PREFIX + "/versions/{version_id}/media")
    def media(project_id: str, version_id: str, request: Request, thumb: bool = False):
        collab_access.require_guest(request, project_id)
        try:
            owned = read_canvas_document(project_id).content_versions[version_id]
            path, version = _resolve_canvas_media_version(project_id, owned)
            preview = resolve_canvas_thumbnail(project_id, version, path, 1024) if thumb else None
        except (KeyError, OSError, ValueError):
            raise HTTPException(404, "找不到画布媒体") from None
        collab_access.require_guest(request, project_id)
        return FileResponse(preview or path, media_type="image/webp" if preview else version.mime_type)

    return app


class CollabServer:
    def __init__(self, host: str = "0.0.0.0"):
        self.host = host
        self.lock = threading.Lock()
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.port: int | None = None

    @property
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def apply_saved(self) -> None:
        with self.lock:
            saved = config.read_config()
            if not any(entry.enabled for entry in saved.shares.values()):
                if self.port:
                    discovery.broadcast(Beacon(proto=config.COLLAB_PROTOCOL_VERSION, host_id=saved.host_id,
                                              display_name=owner_name(), port=self.port, share_count=0,
                                              revision=saved.revision, ts=int(time.time())))
                self._stop()
                return
            if self.running:
                return
            app = create_collab_app()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                if os.name != "nt":
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                for port in list(range(saved.preferred_port, 5201)) + list(range(5181, saved.preferred_port)):
                    try:
                        sock.bind((self.host, port))
                        break
                    except OSError:
                        continue
                else:
                    raise OSError("无法启动协作服务，5181–5200 端口均被占用")
                sock.listen(128)
                server = uvicorn.Server(uvicorn.Config(
                    app, host=self.host, port=port, access_log=False, log_level="warning",
                    lifespan="off", ws="websockets", proxy_headers=False, timeout_graceful_shutdown=2,
                ))
                def run():
                    async def serve():
                        watch = loop_watch.start("画布协作", warn_after=.2)
                        try:
                            await server.serve(sockets=[sock])
                        finally:
                            watch.cancel()
                    try:
                        asyncio.run(serve())
                    finally:
                        sock.close()
                self.thread = threading.Thread(target=run, name="lan-canvas", daemon=True)
                self.thread.start()
                self.port, self.server = port, server
            except BaseException:
                sock.close()
                raise

    def _stop(self):
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=5)
        self.server = self.thread = self.port = None
        collab_access.reset_sessions()

    def stop(self):
        with self.lock:
            self._stop()

    def beacon(self):
        if not self.running and not config.read_config().shares:
            return None
        if not self.running:
            # The discovery heartbeat also supervises the on-demand listener.
            self.apply_saved()
        if not self.port:
            return None
        current = manifest()
        return Beacon(proto=current.protocol_version, host_id=current.host_id, display_name=current.display_name,
                      port=self.port, share_count=len(current.shares), ts=int(time.time()),
                      revision=int.from_bytes(hashlib.sha256(current.model_dump_json().encode()).digest()[:8], "big"))


collab_server = CollabServer()


def start_collab() -> None:
    try:
        collab_server.apply_saved()
        from viewer_server.collab_offline import repair_online
        discovery.start(collab_server.beacon, lan_addresses, repair_online)
    except (ValueError, OSError):
        logger.exception("共享画布服务启动失败")


def stop_collab() -> None:
    discovery.stop()
    collab_server.stop()
    from viewer_server.collab_proxy import clear_tokens
    clear_tokens()


def reload_collab_root() -> None:
    if discovery.active or collab_server.running:
        stop_collab()
        start_collab()
