"""Local-only management endpoints. Secrets never enter tool responses."""
from __future__ import annotations

import sys
import time
from typing import Annotated

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from character_workflow.lib import data_root
from character_workflow.mcp.tool_catalog import TOOL_DEFINITIONS
from viewer_server import agent_clients
from viewer_server.connection_auth import ConnectionError, ConnectionStore, cookie_name, iso_time

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
    client: agent_clients.AgentClientId | None = None


class ClientConfigPayload(ControlPayload):
    client: agent_clients.AgentClientId


def connection_router(store: ConnectionStore) -> APIRouter:
    router = APIRouter(prefix="/api/connection")

    @router.post("/local-session")
    def local_session(payload: ControlPayload, request: Request, response: Response) -> dict:
        name = cookie_name((request.scope.get("server") or (None, None))[1])
        session, token = store.local_session(request.headers["origin"], request.cookies.get(name))
        if token:
            response.set_cookie(
                name, token, httponly=True, samesite="strict", path="/",
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

    def agent_status() -> dict:
        return {
            **store.agent_status(),
            "credential_path": str(data_root.agent_credential_file()),
            "clients": agent_clients.status(sys.executable),
            "tools": [{"name": tool.name, "billable": tool.billable} for tool in TOOL_DEFINITIONS],
        }

    @router.get("/agent")
    def agent() -> dict:
        return agent_status()

    @router.put("/agent")
    def enable_agent(payload: ControlPayload, request: Request) -> dict:
        store.enable_agent(request.state.connection_base_url)
        # Claude Code 由插件自带 MCP 读同一份凭据；Codex 没有插件，装了就顺手写进它的配置。
        agent_clients.write_codex_if_installed(sys.executable)
        return agent_status()

    @router.post("/agent/client-config")
    def write_client_config(payload: ClientConfigPayload) -> dict:
        """一键把适配器写进某个客户端的配置；只在开关打开时可用（写进去也连不上）。"""
        if not store.agent_status()["enabled"]:
            raise ConnectionError("AGENT_DISABLED", "先打开 Agent 连接", 409)
        agent_clients.write(payload.client, sys.executable)
        return agent_status()

    @router.delete("/agent")
    def disable_agent(payload: ControlPayload) -> dict:
        store.disable_agent()
        return agent_status()

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
