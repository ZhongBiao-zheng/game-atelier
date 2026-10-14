"""Local-only management endpoints. Secrets never enter website or tool responses."""
from __future__ import annotations

import sys
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from viewer_server.codex_config import write_codex_entry_if_installed
from viewer_server.connection_auth import COOKIE_NAME, ConnectionStore, iso_time
from viewer_server.request_boundary import development_origin

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


class PairingPayload(ControlPayload):
    origin: Annotated[str, StringConstraints(strip_whitespace=True, min_length=8, max_length=253)]


class PairPayload(ControlPayload):
    pairing_code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=16, max_length=128)]
    instance_id: TextId


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

    @router.get("/sessions")
    def sessions() -> dict:
        with store.lock:
            store._refresh()
            return {"sessions": [{
                "session_id": value.principal.session_id, "kind": value.principal.kind,
                "name": value.name, "origin": value.origin, "expires_at": iso_time(value.expires_at),
                "capabilities": sorted(value.principal.capabilities),
            } for value in store.sessions.values()]}

    @router.post("/pairings", status_code=201)
    def create_pairing(payload: PairingPayload, request: Request) -> dict:
        # 本机页面与 Vite 开发来源不能登记为网站：它们走 cookie 引导，被当成网站来源就连不上了。
        reserved = frozenset(filter(None, {request.state.connection_base_url, development_origin()}))
        code, pairing = store.create_pairing(payload.origin, reserved)
        return {"pairing_code": code, "origin": pairing.origin,
                "expires_at": iso_time(pairing.expires_at), "instance_id": store.instance_id}

    @router.post("/pair")
    def pair(payload: PairPayload, request: Request) -> dict:
        session, token = store.pair(payload.pairing_code, payload.instance_id, request.headers["origin"])
        return {
            "session_token": token, "session_id": session.principal.session_id,
            "instance_id": store.instance_id, "expires_at": iso_time(session.expires_at),
            "capabilities": sorted(session.principal.capabilities),
        }

    @router.post("/media-token")
    def media_token(payload: ControlPayload, request: Request) -> dict:
        token, expires_at = store.issue_media_token(request.state.connection_session)
        return {"media_token": token, "expires_at": iso_time(expires_at)}

    @router.delete("/sessions/{session_id}", status_code=204)
    def revoke(session_id: str) -> Response:
        store.revoke_session(session_id)
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
