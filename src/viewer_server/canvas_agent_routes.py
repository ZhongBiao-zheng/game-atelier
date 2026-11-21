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
    CanvasSearchLibraryInput, CanvasSearchTeamInput, CanvasReadSpecInput,
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


def _reference_previews(project_id: str, result: dict) -> dict:
    from character_workflow.lib.canvas_agent_library import reference_preview
    from character_workflow.lib.canvas_agent_vision import MAX_ATTACH_IMAGES

    refs = result.pop("attach_images", [])
    previews, attached = [], []
    for ref in refs[:MAX_ATTACH_IMAGES]:
        url = reference_preview(project_id, ref)
        if url:
            attached.append(ref)
            previews.append({"mime_type": "image/jpeg", "data_base64": url.split(",", 1)[1]})
    return {**result, "attach_images": attached, "previews": previews}


@router.post("/search-library")
def search_library(request: Request, payload: CanvasSearchLibraryInput):
    return _reference_previews(payload.project_id, tools.search_library(principal(request), payload))


@router.post("/search-team")
def search_team(request: Request, payload: CanvasSearchTeamInput):
    return _reference_previews(payload.project_id, tools.search_team(principal(request), payload))


@router.post("/read-spec")
def read_spec(request: Request, payload: CanvasReadSpecInput):
    return tools.read_spec(principal(request), payload)


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


def _agent(request: Request, message: str = "插件工具只给 Agent 用"):
    """插件工具与自定义接口工具只认 Agent 凭据：本机页面的会话也能走到 /api/canvas-agent/，在这里拒掉。"""
    current = principal(request)
    if current is None or current.kind != "agent":
        raise CanvasToolError("CAPABILITY_DENIED", message, 403)
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


# 自定义接口的接入说明与干跑校验（ADR-0036，第 5 批 5-6B）：让用户自己的 AI 代理读说明、改模板到校验通过。
# 不挂项目、不加能力开关：只要是有效的本机 Agent 会话。不写盘、不发出站请求、不读已有模板与密钥；
# 保存与绑定仍只在本机设置页（/api/http-protocols* 对 Agent 会话是 401）。
PROTOCOL_DOCUMENT_MAX_BYTES = 200 * 1024


class ProtocolManualRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProtocolValidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: dict


@router.post("/protocol-manual")
def protocol_manual(request: Request, payload: ProtocolManualRequest):
    from importlib.resources import files
    _agent(request, "自定义接口说明只给 Agent 用")
    text = files("character_workflow").joinpath("data/http_protocol_manual.md").read_text(encoding="utf-8")
    return {"markdown": text}


@router.post("/protocol-validate")
def protocol_validate(request: Request, payload: ProtocolValidateRequest):
    import json

    from viewer_server.http_protocol_routes import validate_document
    _agent(request, "自定义接口干跑校验只给 Agent 用")
    size = len(json.dumps(payload.document, ensure_ascii=False).encode("utf-8"))
    if size > PROTOCOL_DOCUMENT_MAX_BYTES:
        raise CanvasToolError("CONTENT_TOO_LARGE",
                              f"接口模板 {size // 1024} KB，超过 200 KB 上限", 413)
    result = validate_document(payload.document)
    if result["preview"]:
        result["preview"] = {name: _hide_private_fields(call) for name, call in result["preview"].items()}
    return result


def _hide_private_fields(call: dict) -> dict:
    """MCP 适配器拒绝任何名字在 PRIVATE_KEYS 里的字段（authorization、api_key 等），整份结果作废。

    预览里这类字段只可能是鉴权头的 `***` 占位，或模板请求体 / 请求头里同名的字段：拿掉它们，把路径报在
    `hidden_fields`，其余预览照常返回。查询串鉴权在 url 字符串里（`?api_key=***`），不是字段名，不受影响。
    """
    from character_workflow.mcp.client import PRIVATE_KEYS

    hidden: list[str] = []

    def walk(value, path: str):
        if isinstance(value, dict):
            kept = {}
            for key, item in value.items():
                here = f"{path}.{key}" if path else str(key)
                if str(key).lower() in PRIVATE_KEYS:
                    hidden.append(here)
                    continue
                kept[key] = walk(item, here)
            return kept
        if isinstance(value, list):
            return [walk(item, f"{path}.{index}") for index, item in enumerate(value)]
        return value

    view = walk(call, "")
    if hidden:
        view["hidden_fields"] = hidden
    return view


def register_canvas_agent_routes(app: FastAPI) -> None:
    app.include_router(router)


async def handle_canvas_tool_error(_request: Request, error: CanvasToolError):
    return JSONResponse({"error": {"code": error.code, "message": error.message,
                                   "request_id": str(uuid4())}}, status_code=error.status)
