"""FastAPI app factory — REST routes + SSE + filesystem watchers."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from character_workflow.lib.jobs import fail_orphan_studio_jobs
from character_workflow.lib.secret_filter import SecretRedactionFilter
from viewer_server.routes import router
from viewer_server.sse import hub, sse_router
from viewer_server.watcher import start_watchers


_CANVAS_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024


class CanvasDocumentBodyLimitMiddleware:
    """Reject oversized canvas PUT bodies before JSON/Pydantic parsing allocates them."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _is_canvas_document_put(scope):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                if int(raw_length) > _CANVAS_DOCUMENT_MAX_BYTES:
                    await _canvas_body_too_large(scope, receive, send)
                    return
            except ValueError:
                pass
        buffered: list[Message] = []
        total = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break
            total += len(message.get("body", b""))
            if total > _CANVAS_DOCUMENT_MAX_BYTES:
                await _canvas_body_too_large(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        index = 0

        async def replay_receive() -> Message:
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)


def _is_canvas_document_put(scope: Scope) -> bool:
    path = str(scope.get("path", ""))
    return (
        scope.get("type") == "http"
        and scope.get("method") == "PUT"
        and path.startswith("/api/canvas/projects/")
        and path.endswith("/document")
    )


async def _canvas_body_too_large(scope: Scope, receive: Receive, send: Send) -> None:
    response = JSONResponse({"detail": "画布文档请求体不能超过 25 MiB"}, status_code=413)
    await response(scope, receive, send)


def _install_secret_filter() -> None:
    flt = SecretRedactionFilter()
    for name in ("", "uvicorn", "uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(name)
        for handler in logger.handlers:
            handler.addFilter(flt)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.set_loop(asyncio.get_running_loop())
    # 插件升级入口：旧项目只在 server 启动阶段一次性改成 V1；正常 GET/Skill 读路径不做迁移。
    from character_workflow.lib.ui_schemes import migrate_legacy_projects

    migrated = migrate_legacy_projects()
    if migrated:
        logging.getLogger(__name__).info(
            "migrated %d project(s) to UI schemes: %s", len(migrated), ", ".join(migrated)
        )
    # 孤儿回收：studio job 只在本进程跑，重启时还 pending 的必然已死（一键启动脚本
    # 每次双击都是 stop→start）。不回收 = Web 永久转圈 + 永久轮询。
    reclaimed = fail_orphan_studio_jobs()
    if reclaimed:
        logging.getLogger(__name__).warning(
            "reclaimed %d orphan studio job(s): %s", len(reclaimed), ", ".join(reclaimed)
        )
    observer = start_watchers()
    try:
        yield
    finally:
        observer.stop()
        observer.join(timeout=2)


def build_app(dist_dir: Path | None = None) -> FastAPI:
    _install_secret_filter()
    app = FastAPI(title="Game Atelier viewer-server", lifespan=lifespan)
    app.add_middleware(CanvasDocumentBodyLimitMiddleware)
    app.include_router(router)
    app.include_router(sse_router)

    if dist_dir is None:
        dist_dir = Path(__file__).resolve().parents[2] / "web" / "dist"

    if dist_dir.exists():
        assets_dir = dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def spa_fallback(path: str):
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            file = dist_dir / path
            # Containment check: prevent path traversal via absolute paths
            # (e.g. URL-encoded /%2Fetc%2Fpasswd) or `..` segments.
            try:
                file.resolve().relative_to(dist_dir.resolve())
            except ValueError:
                return FileResponse(dist_dir / "index.html")
            if path and file.is_file():
                return FileResponse(file)
            return FileResponse(dist_dir / "index.html")
    else:
        # 前端未构建：给出可读提示页，而不是裸 404（用户开窗只会看到一行报错）。
        @app.get("/{path:path}")
        async def missing_dist(path: str):
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            return HTMLResponse(
                "<h1>Web UI 未构建</h1>"
                "<p>未找到 <code>web/dist</code>。开发模式请运行 "
                "<code>make build</code>；插件用户请重装插件（安装包应自带预构建 UI）。</p>",
                status_code=503,
            )

    return app
