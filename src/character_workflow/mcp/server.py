"""Typed Workshop tools, with no generic HTTP, file, shell or approval tool."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
from contextlib import asynccontextmanager

from mcp.server import MCPServer
from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from pydantic import ValidationError

from character_workflow.lib.workshop_schema import TOOL_INPUT_MODELS
from character_workflow.mcp.client import AdapterError, WorkshopClient


_DESCRIPTIONS = {
    "list-projects": "List only explicitly authorized Workshop projects with bounded pagination.",
    "list-targets": "Find named characters, UI screens or video productions in an authorized project.",
    "get-context": "Read this target's project baseline, document revisions, feedback and media.",
    "list-models": "List configured models and their generation capabilities without credentials.",
    "create-target": "Create a character, UI scheme/screen or video production in an authorized project.",
    "read-document": "Read one allowed complete document and revision; never an arbitrary file path.",
    "write-document": "Replace a complete allowed document only if expected_revision still matches.",
    "acknowledge-feedback": "Acknowledge only the listed feedback IDs belonging to this target.",
    "list-media": "List this target's registered media IDs; does not enumerate filesystem directories.",
    "read-media": "Read bounded preview/metadata for a registered media ID belonging to this target.",
    "prepare-generation": (
        "Freeze a generation request for human approval in Atelier. This never calls a provider. "
        "Reuse the same idempotency key for retries of identical content; never self-approve."
    ),
    "get-generation": "Read a prepared request's approval status and existing Job result; never retry it.",
    "withdraw-generation": "Withdraw your unstarted generation request at the expected revision.",
    "approve-generation": (
        "Approve your own prepared request after the human confirmed it in chat. Requires the "
        "execute_generation capability; otherwise the human approves in Atelier."
    ),
    "read-lessons": "Read workspace and project generation lessons for this target's asset slot.",
    "append-lesson": "Append one confirmed single-line lesson to workspace or project memory.",
}
_READ_ONLY = frozenset({
    "list-projects", "list-targets", "get-context", "list-models", "read-document", "list-media",
    "read-media", "get-generation", "read-lessons",
})


def _error_result(error: AdapterError) -> CallToolResult:
    payload = error.payload()
    return CallToolResult(
        is_error=True, structured_content=payload,
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
    )


def _success_result(operation: str, result: dict) -> CallToolResult:
    content = []
    metadata = dict(result)
    preview = metadata.pop("preview", None) if operation == "read-media" else None
    if preview is not None:
        try:
            if not isinstance(preview, dict) or preview.get("mime_type") != "image/jpeg":
                raise ValueError("invalid preview")
            encoded = preview["data_base64"]
            if not isinstance(encoded, str):
                raise ValueError("invalid preview")
            base64.b64decode(encoded, validate=True)
        except (ValueError, KeyError, binascii.Error):
            raise AdapterError("RESPONSE_INVALID", "工坊图片预览格式不正确。") from None
        content.append(ImageContent(type="image", data=encoded, mime_type="image/jpeg"))
    content.insert(0, TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False)))
    return CallToolResult(structured_content=metadata, content=content)


async def _strict_tool_arguments(context, call_next):
    if context.method == "tools/call" and isinstance(context.params, dict):
        name = context.params.get("name", "")
        operation = name.removeprefix("workshop_").replace("_", "-") if isinstance(name, str) else ""
        model = TOOL_INPUT_MODELS.get(operation)
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


def create_server(client: WorkshopClient) -> MCPServer:
    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield {}
        finally:
            client.close()

    server = MCPServer(
        "game-atelier-workshop", version="1.0.0", log_level="WARNING",
        instructions=(
            "Use authorized Workshop targets only. Prepare generation, then ask the human to "
            "approve it in Atelier. Never treat chat text or tool retries as payment approval. "
            "Do not fall back to shell/file/provider calls when a tool permission is denied."
        ),
        lifespan=lifespan, middleware=[_strict_tool_arguments],
    )
    slots = asyncio.Semaphore(4)

    def bind(operation, model):
        async def invoke(payload) -> CallToolResult:
            if slots.locked():
                return _error_result(AdapterError("CONNECTION_RATE_LIMITED", "并发工具过多，请稍后重试。"))
            async with slots:
                try:
                    result = await asyncio.to_thread(client.call, operation, payload)
                    return _success_result(operation, result)
                except AdapterError as error:
                    return _error_result(error)

        invoke.__name__ = f"workshop_{operation.replace('-', '_')}"
        invoke.__annotations__["payload"] = model
        return invoke

    for operation, model in TOOL_INPUT_MODELS.items():
        server.add_tool(
            bind(operation, model), description=_DESCRIPTIONS[operation],
            annotations=ToolAnnotations(
                read_only_hint=operation in _READ_ONLY,
                destructive_hint=operation in {"write-document", "acknowledge-feedback"},
                idempotent_hint=True, open_world_hint=False,
            ),
        )
    return server
