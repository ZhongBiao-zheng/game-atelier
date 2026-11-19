"""Canvas MCP 里的 PS 联动工具（ADR-0043）：列工具时按服务端可用情况过滤、预览图作为图片返回。

用内存里的 MCP 客户端驱动真实的 MCPServer，适配器到 viewer-server 的那一段换成假对象。
"""
from __future__ import annotations

import base64

import pytest
from mcp.client import Client
from mcp.types import ImageContent

from character_workflow.mcp import client as adapter
from character_workflow.mcp.server import create_server
from character_workflow.mcp.tool_catalog import PsExecuteInput, PsImportInput

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg").decode("ascii")


class FakeCanvas:
    def __init__(self, available: set[str]) -> None:
        self.available = available
        self.calls: list[tuple[str, dict]] = []

    def close(self) -> None:
        pass

    def available_plugin_tools(self) -> set[str]:
        return set(self.available)

    def call(self, operation: str, payload) -> dict:
        self.calls.append((operation, payload.model_dump(mode="json")))
        if operation == "ps-preview":
            return {"document": {"id": 7, "name": "海报.psd"}, "width": 1600, "height": 900,
                    "preview": {"mime_type": "image/jpeg", "data_base64": JPEG}}
        return {"ok": True}


async def _tool_names(fake: FakeCanvas) -> set[str]:
    async with Client(create_server(fake)) as client:
        return {tool.name for tool in (await client.list_tools()).tools}


async def test_ps_tools_are_listed_only_while_the_server_offers_them():
    names = await _tool_names(FakeCanvas({"ps-inspect", "ps-import", "ps-place", "ps-preview"}))
    assert {"ps_inspect", "ps_import", "ps_place", "ps_preview"} <= names
    assert "ps_execute" not in names
    assert "canvas_get_document" in names

    with_scripts = await _tool_names(FakeCanvas({"ps-inspect", "ps-execute"}))
    assert {"ps_inspect", "ps_execute"} <= with_scripts and "ps_preview" not in with_scripts

    offline = await _tool_names(FakeCanvas(set()))
    assert not {name for name in offline if name.startswith("ps_")}
    assert "canvas_list_projects" in offline


async def test_ps_preview_comes_back_as_an_image():
    fake = FakeCanvas({"ps-preview"})
    async with Client(create_server(fake)) as client:
        result = await client.call_tool("ps_preview", {"payload": {"project_id": "canvas-abc12345"}})
    assert not result.is_error
    images = [part for part in result.content if isinstance(part, ImageContent)]
    assert len(images) == 1 and images[0].data == JPEG
    assert "preview" not in result.structured_content
    assert fake.calls == [("ps-preview", {"project_id": "canvas-abc12345", "document_id": 0})]


async def test_ps_execute_rejects_scripts_longer_than_the_confirm_limit():
    fake = FakeCanvas({"ps-execute"})
    async with Client(create_server(fake)) as client:
        result = await client.call_tool("ps_execute", {"payload": {"project_id": "canvas-abc12345", "code": "x" * 3601}})
    assert result.is_error and fake.calls == []


def test_plugin_tool_requests_wrap_arguments_and_go_to_the_plugin_tool_route():
    payload = PsImportInput(project_id="canvas-abc12345", scope="layer")
    assert adapter._request_body("ps-import", payload) == {"project_id": "canvas-abc12345", "arguments": {"scope": "layer"}}
    assert adapter.OPERATIONS["ps-execute"] == "/api/canvas-agent/plugin-tools/ps-bridge/execute"
    execute = PsExecuteInput(project_id="canvas-abc12345", code="return 1;")
    assert adapter._request_body("ps-execute", execute)["arguments"] == {"code": "return 1;", "document_id": 0}


@pytest.mark.parametrize(("error", "code", "message"), [
    ({"code": "PS_NOT_RUNNING", "message": "Photoshop 未启动"}, "PS_NOT_RUNNING", "Photoshop 未启动"),
    ({"code": "TOOL_NOT_AVAILABLE", "message": "这个插件工具当前不可用"}, "TOOL_NOT_AVAILABLE", "这个插件工具当前不可用"),
    ({"code": "SOMETHING_ELSE", "message": "内部细节"}, "WORKSHOP_REQUEST_FAILED", "画布操作失败，请在本机页面检查。"),
])
def test_photoshop_errors_reach_the_agent_in_their_own_words(error, code, message):
    raised = adapter._server_error(error)
    assert (raised.code, raised.message) == (code, message)


async def test_turning_scripts_on_shows_up_on_the_next_tools_list():
    fake = FakeCanvas({"ps-inspect"})
    async with Client(create_server(fake)) as client:
        before = {tool.name for tool in (await client.list_tools()).tools}
        fake.available = {"ps-inspect", "ps-execute"}
        after = {tool.name for tool in (await client.list_tools()).tools}
    assert "ps_execute" not in before and "ps_execute" in after
