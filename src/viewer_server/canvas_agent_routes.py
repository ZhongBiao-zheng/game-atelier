"""Authenticated typed canvas tool endpoints; a run schedules the same canvas job worker as the Web."""
from __future__ import annotations

from uuid import uuid4
from fastapi.responses import JSONResponse
from character_workflow.lib.canvas_tool_common import CanvasToolError

from fastapi import APIRouter, BackgroundTasks, FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasListModelsInput, CanvasListProjectsInput, CanvasProjectInput,
    CanvasReadMediaInput, GetRunInput, ImportMediaInput, RunInput,
)

router = APIRouter(prefix="/api/canvas-agent")


def principal(request: Request):
    return getattr(request.state, "connection_principal", None)


@router.post("/list-projects")
def list_projects(request: Request, payload: CanvasListProjectsInput):
    return tools.list_projects(principal(request), payload)


@router.post("/get-document")
def get_document(request: Request, payload: CanvasProjectInput):
    return tools.get_document(principal(request), payload)


@router.post("/list-models")
def list_models(request: Request, payload: CanvasListModelsInput):
    return tools.list_models(principal(request), payload)


@router.post("/apply-changes")
def apply_changes(request: Request, payload: ApplyChangesInput):
    return tools.apply_changes(principal(request), payload)


@router.post("/import-media")
def import_media(request: Request, payload: ImportMediaInput):
    return tools.import_media(principal(request), payload)


@router.post("/run")
def run(request: Request, payload: RunInput, background: BackgroundTasks):
    from viewer_server import routes as web_routes
    result, job = tools.run(principal(request), payload)
    background.add_task(web_routes._run_canvas_job_safely, job.job_id)
    return result


@router.post("/get-run")
def get_run(request: Request, payload: GetRunInput):
    return tools.get_run(principal(request), payload)


@router.post("/read-media")
def read_media(request: Request, payload: CanvasReadMediaInput):
    return tools.read_media(principal(request), payload)


# 只有这些插件的 Agent 工具进 Canvas MCP（ADR-0043）：PS 联动是为外部 Agent 驱动 PS 做的，其他插件的工具不开放。
MCP_PLUGIN_IDS = frozenset({"ps-bridge"})


class PluginToolList(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PluginToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=160)
    arguments: dict = Field(default_factory=dict)


def _agent(request: Request):
    """插件工具接口只认 Agent 凭据：本机页面的会话也能走到 /api/canvas-agent/，在这里拒掉。"""
    current = principal(request)
    if current is None or current.kind != "agent":
        raise CanvasToolError("CAPABILITY_DENIED", "插件工具只给 Agent 用", 403)
    return current


def _mcp_plugin_tools() -> list[dict]:
    from character_workflow.lib.canvas_agent_runtime import plugin_tools
    return [spec for spec in plugin_tools().values() if spec["plugin_id"] in MCP_PLUGIN_IDS]


@router.post("/plugin-tools")
def list_plugin_tools(request: Request, payload: PluginToolList):
    """此刻可用的插件工具：插件未启用、或插件藏起的（PS 联动脚本开关关着时的 execute）不列出。"""
    _agent(request)
    return {"tools": [{key: spec[key] for key in ("plugin_id", "tool", "read_only", "description", "parameters")}
                      for spec in _mcp_plugin_tools()]}


@router.post("/plugin-tools/{plugin_id}/{tool}")
def call_plugin_tool(request: Request, plugin_id: str, tool: str, payload: PluginToolCall):
    from character_workflow.lib import plugin_server
    from character_workflow.lib.plugin_registry import PluginError
    current = _agent(request)
    spec = next((item for item in _mcp_plugin_tools() if item["plugin_id"] == plugin_id and item["tool"] == tool), None)
    if spec is None:
        raise CanvasToolError("TOOL_NOT_AVAILABLE", "这个插件工具当前不可用（插件未启用，或在设置里被关闭）", 404)
    tools.authorize(current, payload.project_id, "canvas_read" if spec["read_only"] else "canvas_edit")
    try:
        result, _created = plugin_server.call(plugin_id, "POST", spec["route"], project_id=payload.project_id,
                                              origin="agent", params=payload.arguments, caller="外部 Agent")
    except PluginError as error:
        raise CanvasToolError(error.code, error.message, error.status) from None
    return result


def register_canvas_agent_routes(app: FastAPI) -> None:
    app.include_router(router)


async def handle_canvas_tool_error(_request: Request, error: CanvasToolError):
    return JSONResponse({"error": {"code": error.code, "message": error.message,
                                   "request_id": str(uuid4())}}, status_code=error.status)
