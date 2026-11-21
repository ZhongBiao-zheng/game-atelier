"""Canvas MCP tools exercise strict stdio inputs, per-tool capabilities and the real viewer."""
from types import SimpleNamespace

import pytest
from mcp.client import Client

from character_workflow.lib import canvas_agent_tools as tools, canvas_specs
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.mcp.server import create_server
from character_workflow.mcp.tool_catalog import ALL_TOOL_INPUT_MODELS
from tests.mcp_local_service import adapter_session
from tests.test_mcp_ps_tools import FakeCanvas


CASES = [
    ("search_library", {"limit": 2}, {"limit": "2"}),
    ("search_team", {"query": "cat"}, {"query": 1}),
    ("read_spec", {"category": "cat"}, {"category": False}),
]


@pytest.mark.parametrize("name,valid,invalid", CASES)
async def test_strict_inputs_and_capability(name, valid, invalid):
    project = create_canvas_project("Tools")
    project_id = project.project_id
    fake = FakeCanvas(set())
    async with Client(create_server(fake)) as client:
        for bad in (invalid, {**valid, "extra": True}):
            result = await client.call_tool("canvas_" + name, {"payload": {"project_id": project_id, **bad}})
            assert result.is_error and result.structured_content["error"]["code"] == "INVALID_TOOL_INPUT"
        assert not fake.calls
    model = ALL_TOOL_INPUT_MODELS["canvas-" + name.replace("_", "-")]
    principal = SimpleNamespace(kind="agent", grant_id="test", capabilities=[])
    with pytest.raises(CanvasToolError) as caught:
        getattr(tools, name)(principal, model(project_id=project_id, **valid))
    assert caught.value.code == "TARGET_NOT_AUTHORIZED" and caught.value.status == 403


async def test_real_adapter_reads_reference_libraries_and_spec(isolated_data_root, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    project = create_canvas_project("Tools")
    category = project.categories[0]
    canvas_specs.write_spec(project.project_id, "Use a square crop.", category)
    async with adapter_session(isolated_data_root, tmp_path) as client:
        for name in ("search_library", "search_team", "read_spec"):
            result = await client.call_tool("canvas_" + name, {"payload": {
                "project_id": project.project_id, "category": category}})
            assert not result.is_error, result.content
            if name == "read_spec":
                assert result.structured_content == {"text": "Use a square crop."}
            else:
                assert result.structured_content == {"assets": [], "attach_images": []}
