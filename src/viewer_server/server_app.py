"""FastAPI app factory — REST routes + SSE + filesystem watchers."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from character_workflow.lib.secret_filter import SecretRedactionFilter
from viewer_server.routes import router
from viewer_server.sse import hub, sse_router
from viewer_server.watcher import start_watchers


def _install_secret_filter() -> None:
    flt = SecretRedactionFilter()
    for name in ("", "uvicorn", "uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(name)
        for handler in logger.handlers:
            handler.addFilter(flt)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.set_loop(asyncio.get_running_loop())
    observer = start_watchers()
    try:
        yield
    finally:
        observer.stop()
        observer.join(timeout=2)


def build_app(dist_dir: Path | None = None) -> FastAPI:
    _install_secret_filter()
    app = FastAPI(title="Game Atelier viewer-server", lifespan=lifespan)
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
