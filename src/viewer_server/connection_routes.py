"""Local-only management endpoints. Secrets never enter website or tool responses."""
from __future__ import annotations

import time
from typing import Annotated, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from viewer_server.connection_auth import COOKIE_NAME, ConnectionStore, iso_time

TextId = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]


class ControlPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EditorPayload(ControlPayload):
    client_id: TextId
    takeover: bool = False


class GrantPayload(ControlPayload):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    project_ids: Annotated[list[TextId], Field(min_length=1, max_length=32)]
    capabilities: Annotated[list[Literal[
        "read", "edit_documents", "create_targets", "prepare_generation",
    ]], Field(min_length=1, max_length=4)]
    days: Annotated[int, Field(ge=1, le=30)] = 7


class AgentSessionPayload(ControlPayload):
    grant_id: TextId
    grant_token: Annotated[str, StringConstraints(min_length=32, max_length=128)]
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
                "name": value.name, "expires_at": iso_time(value.expires_at),
                "project_ids": sorted(value.principal.project_ids),
                "capabilities": sorted(value.principal.capabilities),
            } for value in store.sessions.values()]}

    @router.delete("/sessions/{session_id}", status_code=204)
    def revoke(session_id: str) -> Response:
        store.revoke_session(session_id)
        return Response(status_code=204)

    @router.get("/agent-grants")
    def grants() -> dict:
        return {"grants": store.list_grants()}

    @router.post("/agent-grants", status_code=201)
    def create_grant(payload: GrantPayload, request: Request) -> dict:
        return store.create_grant(**payload.model_dump(), base_url=request.state.connection_base_url)

    @router.delete("/agent-grants/{grant_id}", status_code=204)
    def revoke_grant(grant_id: str) -> Response:
        store.revoke_grant(grant_id)
        return Response(status_code=204)

    @router.post("/agent-sessions")
    def agent_session(payload: AgentSessionPayload) -> dict:
        session, token = store.agent_session(
            payload.grant_id, payload.grant_token, payload.instance_id,
        )
        return {
            "session_token": token, "session_id": session.principal.session_id,
            "instance_id": store.instance_id, "expires_at": iso_time(session.expires_at),
            "capabilities": sorted(session.principal.capabilities),
            "project_ids": sorted(session.principal.project_ids),
        }

    return router
