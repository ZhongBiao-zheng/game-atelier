"""FastAPI app factory — REST routes + SSE + filesystem watchers."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from viewer_server.routes import router
from viewer_server.sse import hub, sse_router
from viewer_server.watcher import start_watchers


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.set_loop(asyncio.get_running_loop())
    observer = start_watchers()
    try:
        yield
    finally:
        observer.stop()
        observer.join(timeout=2)


def build_app() -> FastAPI:
    app = FastAPI(title="game-ui-ai-workflow viewer-server", lifespan=lifespan)
    app.include_router(router)
    app.include_router(sse_router)
    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="ui")
    return app
