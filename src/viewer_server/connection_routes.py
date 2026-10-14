"""Local-only management endpoints. Secrets never enter tool responses."""
from __future__ import annotations

import sys
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from viewer_server.codex_config import write_codex_entry_if_installed
from viewer_server.connection_auth import COOKIE_NAME, ConnectionStore, iso_time

TextId = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]


class ControlPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EditorPayload(ControlPayload):
    client_id: TextId
    takeover: bool = False


class AgentSessionPayload(ControlPayload):
    grant_id: TextId
    grant_token: Annotated[str, StringConstraints(min_length=32, max_length=128)]
    instance_id: TextId
    client: Literal["claude-code", "codex"] | None = None


def connection_router(store: ConnectionStore) -> APIRouter:
    router = APIRouter(prefix="/api/connection")

    @router.post("/local-session")
    def local_session(payload: ControlPayload, request: Request, response: Response) -> dict:
        session, token = store.local_session(
            request.headers["origin"], request.cookies.get(COOKIE_NAME),
        )
        if token:
            response.set_cookie(
                COOKIE_NAME, token, httponly=True, samesite="strict", path="/",
                max_age=max(0, int(session.expires_at - time.time())),
            )
        return {"session_id": session.principal.session_id, "instance_id": store.instance_id,
                "expires_at": iso_time(session.expires_at)}

    @router.post("/editor-lease")
    def lease(payload: EditorPayload, request: Request) -> dict:
        return store.editor_lease(
            request.state.connection_session, payload.client_id, takeover=payload.takeover,
        )

    @router.delete("/editor-lease", status_code=204)
    def release(payload: EditorPayload, request: Request) -> Response:
        store.release_editor(request.state.connection_session, payload.client_id)
        return Response(status_code=204)

    @router.get("/agent")
    def agent() -> dict:
        return store.agent_status()

    @router.put("/agent")
    def enable_agent(payload: ControlPayload, request: Request) -> dict:
        store.enable_agent(request.state.connection_base_url)
        # Claude Code 由插件自带 MCP 读同一份凭据；Codex 没有插件，装了就顺手写进它的配置。
        write_codex_entry_if_installed(sys.executable)
        return store.agent_status()

    @router.delete("/agent")
    def disable_agent(payload: ControlPayload) -> dict:
        store.disable_agent()
        return store.agent_status()

    @router.post("/agent-sessions")
    def agent_session(payload: AgentSessionPayload) -> dict:
        session, token = store.agent_session(
            payload.grant_id, payload.grant_token, payload.instance_id, payload.client,
        )
        return {
            "session_token": token, "session_id": session.principal.session_id,
            "instance_id": store.instance_id, "expires_at": iso_time(session.expires_at),
            "capabilities": sorted(session.principal.capabilities),
        }

    return router
