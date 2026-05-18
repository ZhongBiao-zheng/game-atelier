"""FastAPI app factory."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from skill.viewer_server.routes import router


def build_app() -> FastAPI:
    app = FastAPI(title="game-ui-ai-workflow viewer-server")
    app.include_router(router)
    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="ui")
    return app
