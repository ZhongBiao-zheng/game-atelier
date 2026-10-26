"""Typed Canvas tools, with no generic HTTP, file, shell or approval tool."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
from contextlib import asynccontextmanager

from mcp.server import MCPServer
from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from pydantic import ValidationError

from character_workflow.mcp.client import AdapterError, CanvasClient
from character_workflow.mcp.tool_catalog import ALL_TOOL_INPUT_MODELS, TOOL_DEFINITIONS



def operation_of(name: str) -> str:
    if name.startswith("canvas_"):
        return "canvas-" + name.removeprefix("canvas_").replace("_", "-")
    return ""


def _error_result(error: AdapterError) -> CallToolResult:
    payload = error.payload()
    return CallToolResult(
        is_error=True, structured_content=payload,
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
    )


def _success_result(operation: str, result: dict) -> CallToolResult:
    content = []
    metadata = dict(result)
    preview = metadata.pop("preview", None) if operation.endswith("read-media") else None
    if preview is not None:
        try:
            if not isinstance(preview, dict) or preview.get("mime_type") != "image/jpeg":
                raise ValueError("invalid preview")
            encoded = preview["data_base64"]
            if not isinstance(encoded, str):
                raise ValueError("invalid preview")
            base64.b64decode(encoded, validate=True)
        except (ValueError, KeyError, binascii.Error):
            raise AdapterError("RESPONSE_INVALID", "画布图片预览格式不正确。") from None
        content.append(ImageContent(type="image", data=encoded, mime_type="image/jpeg"))
    content.insert(0, TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False)))
    return CallToolResult(structured_content=metadata, content=content)


async def _strict_tool_arguments(context, call_next):
    if context.method == "tools/call" and isinstance(context.params, dict):
        name = context.params.get("name", "")
        operation = operation_of(name) if isinstance(name, str) else ""
        model = ALL_TOOL_INPUT_MODELS.get(operation)
        if model is not None:
            arguments = context.params.get("arguments")
            try:
                if not isinstance(arguments, dict) or set(arguments) != {"payload"}:
                    raise ValueError("invalid tool envelope")
                model.model_validate(arguments["payload"])
            except (ValueError, ValidationError):
                return _error_result(AdapterError(
                    "INVALID_TOOL_INPUT", "工具参数不符合契约，请使用列出的字段、类型和范围。",
                ))
    result = await call_next(context)
    if context.method == "tools/list" and isinstance(result, dict):
        for tool in result.get("tools", []):
            tool["inputSchema"]["additionalProperties"] = False
    return result


def create_server(client: CanvasClient) -> MCPServer:
    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield {}
        finally:
            client.close()

    server = MCPServer(
        "game-atelier-canvas", version="1.0.0", log_level="WARNING",
        instructions=("Use authorized Canvas projects only. Ask the human before paid generation. "
                      "Do not bypass denied permissions using shell or provider calls."),
        lifespan=lifespan, middleware=[_strict_tool_arguments],
    )
    slots = asyncio.Semaphore(4)

    def bind(tool):
        operation, model = tool.operation, tool.input_model
        async def invoke(payload) -> CallToolResult:
            if slots.locked():
                return _error_result(AdapterError("CONNECTION_RATE_LIMITED", "并发工具过多，请稍后重试。"))
            async with slots:
                try:
                    result = await asyncio.to_thread(client.call, operation, payload)
                    return _success_result(operation, result)
                except AdapterError as error:
                    return _error_result(error)

        invoke.__name__ = tool.name
        invoke.__annotations__["payload"] = model
        return invoke

    for tool in TOOL_DEFINITIONS:
        server.add_tool(
            bind(tool), description=tool.description,
            annotations=ToolAnnotations(
                read_only_hint=tool.read_only,
                destructive_hint=tool.operation == "canvas-apply-changes",
                idempotent_hint=True, open_world_hint=False,
            ),
        )
    return server
