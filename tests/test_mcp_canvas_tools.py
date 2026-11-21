"""Canvas MCP tools exercise strict stdio inputs, per-tool capabilities and the real viewer."""
import asyncio
import inspect
import threading
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
pytest_plugins = ["tests.test_canvas_agent_video"]


CASES = [
    ("search_library", {"limit": 2}, {"limit": "2"}),
    ("search_team", {"query": "cat"}, {"query": 1}),
    ("wait_for_run", {"run_id": "run-a"}, {"run_id": 1}),
    ("check_run", {"run_id": "run-a"}, {"run_id": 1}),
    ("read_video_frames", {"version_id": "v"}, {"version_id": "v", "count": True}),
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
        value = getattr(tools, name)(principal, model(project_id=project_id, **valid))
        if inspect.isawaitable(value):
            await value
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


async def test_reads_frames_and_checks_through_stdio(isolated_data_root, tmp_path, video_project, monkeypatch):
    import base64
    from mcp.types import ImageContent
    from character_workflow.lib.schemas import JobParams
    from tests.test_canvas_agent_video import _fake_run

    pid, video_id, _ = video_project
    _fake_run(monkeypatch, JobParams(duration=1), [("succeeded", video_id, None)])
    async with adapter_session(isolated_data_root, tmp_path) as client:
        checked = await client.call_tool("canvas_check_run", {"payload": {"project_id": pid, "run_id": "r"}})
        assert checked.structured_content["candidates"][0]["checks"][0]["name"] == "duration"
        frames = await client.call_tool("canvas_read_video_frames", {"payload": {
            "project_id": pid, "version_id": video_id, "count": 4}})
        assert not frames.is_error and len(frames.structured_content["frames"]) == 4
        [image] = [part for part in frames.content if isinstance(part, ImageContent)]
        assert image.mime_type == "image/jpeg" and base64.b64decode(image.data).startswith(b"\xff\xd8")
        assert "preview" not in frames.structured_content


async def test_wait_expires_with_current_state_and_leaves_other_slots_free(isolated_data_root, tmp_path, monkeypatch):
    from character_workflow.lib import canvas_agent_vision as vision
    from character_workflow.lib.canvas_agent_schema import GetRunInput
    from character_workflow.mcp.client import CanvasClient
    import requests

    pid = create_canvas_project("Waiting").project_id
    entered = threading.Event()
    released = threading.Event()
    seen_timeouts = []
    request = requests.Session.request

    def timed_request(self, method, url, **kwargs):
        if url.endswith("/wait-for-run"):
            seen_timeouts.append(kwargs["timeout"][1])
        return request(self, method, url, **kwargs)

    def pending(principal, payload):
        tools.authorize(principal, payload.project_id, "canvas_read")
        entered.set()
        assert released.wait(5)
        return {"run_id": payload.run_id, "status": "pending", "candidates": []}

    monkeypatch.setattr(tools, "get_run", pending)
    monkeypatch.setattr(requests.Session, "request", timed_request)
    async with adapter_session(isolated_data_root, tmp_path):
        adapter = CanvasClient()
        try:
            # Verify the real transport timeout against the production server wait before shortening it.
            wait = asyncio.create_task(asyncio.to_thread(adapter.call, "canvas-wait-for-run",
                                                        GetRunInput(project_id=pid, run_id="r")))
            assert await asyncio.to_thread(entered.wait, 3)
            assert seen_timeouts[0] > vision.WAIT_SECONDS
            from character_workflow.lib.canvas_agent_schema import CanvasReadSpecInput
            spec = await asyncio.wait_for(asyncio.to_thread(adapter.call, "canvas-read-spec",
                CanvasReadSpecInput(project_id=pid, category="none")), timeout=2)
            assert spec == {"text": ""}
            monkeypatch.setattr(vision, "POLL_SECONDS", 0.01)
            # Advance only the polling clock past its original deadline.
            from time import monotonic
            monkeypatch.setattr(vision, "time", SimpleNamespace(monotonic=lambda: monotonic() + 300))
            released.set()
            result = await asyncio.wait_for(wait, 2)
            assert result["status"] == "pending" and "还在生成" in result["note"]
        finally:
            released.set()
            adapter.close()
