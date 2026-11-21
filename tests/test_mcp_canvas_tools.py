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
from tests import test_canvas_agent_tools, test_canvas_agent_video, test_gateway_client

canvas = test_canvas_agent_tools.canvas
team = test_canvas_agent_tools.team
gateway = test_gateway_client.gateway
upstream = test_gateway_client.upstream
video_project = test_canvas_agent_video.video_project


CASES = [
    ("search_library", {"limit": 2}, {"limit": "2"}),
    ("search_team", {"query": "cat"}, {"query": 1}),
    ("wait_for_run", {"run_id": "run-a"}, {"run_id": 1}),
    ("check_run", {"run_id": "run-a"}, {"run_id": 1}),
    ("read_video_frames", {"version_id": "v"}, {"version_id": "v", "count": True}),
    ("run_batch", {"expected_revision": 0, "items": [{"surface_node_id": "one"}]},
     {"expected_revision": 0, "items": [{"surface_node_id": "one", "count": "2"}]}),
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
        extra = {"schedule": lambda _: pytest.fail("unauthorized submission")} if name == "run_batch" else {}
        value = getattr(tools, name)(principal, model(project_id=project_id, **valid), **extra)
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


async def test_batch_rejects_oversize_and_unknown_item_fields():
    fake = FakeCanvas(set())
    async with Client(create_server(fake)) as client:
        for items in ([{"surface_node_id": str(i)} for i in range(21)],
                      [{"surface_node_id": "one", "token": "x"}], [],
                      [{"surface_node_id": "one", "count": 5}]):
            result = await client.call_tool("canvas_run_batch", {"payload": {
                "project_id": "project", "expected_revision": 0, "items": items}})
            assert result.is_error and result.structured_content["error"]["code"] == "INVALID_TOOL_INPUT"
    assert not fake.calls


async def test_real_adapter_runs_each_accepted_item_once(isolated_data_root, tmp_path, monkeypatch):
    import base64
    from character_workflow.lib import keys
    from character_workflow.lib.canvas_projects import read_canvas_document
    from tests.fake_http_vendor import FakeVendor, png_bytes
    from tests.test_canvas_agent_batch import IMAGE_KEY, _surfaces

    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("no_proxy", "*")
    pid = create_canvas_project("Batch").project_id
    path = "/v1/images/generations"
    with FakeVendor() as vendor:
        keys.write_keys_db(keys.KeysDB(keys=[IMAGE_KEY.model_copy(update={"base_url": vendor.url + "/v1"})]))
        _surfaces(pid, {"first": "gpt-image-2", "last": "gpt-image-2"})
        vendor.on("POST", path, {"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]},
                  (403, {"error": {"message": "fake quota exhausted"}}))
        revision = read_canvas_document(pid).revision
        async with adapter_session(isolated_data_root, tmp_path) as client:
            async def submit(ids, rev):
                return await client.call_tool("canvas_run_batch", {"payload": {
                    "project_id": pid, "expected_revision": rev,
                    "items": [{"surface_node_id": node} for node in ids]}})
            stale = await submit(["first"], revision - 1)
            assert stale.is_error and stale.structured_content["error"]["code"] == "DOCUMENT_CONFLICT"
            repeated = await submit(["first", "first"], revision)
            assert repeated.is_error and repeated.structured_content["error"]["code"] == "INVALID_PARAMETERS"
            assert not vendor.received
            batch = await submit(["first", "missing", "last"], revision)
            assert not batch.is_error, batch.content
            result = batch.structured_content
            assert (result["submitted"], result["failed"], result["rejected"]) == (2, 1, 0)
            assert [item["status"] for item in result["items"]] == ["submitted", "failed", "submitted"]
            assert result["items"][1]["error"].startswith("INVALID_TARGET")
            terminal = []
            for item in result["items"]:
                if item["status"] == "submitted":
                    view = await client.call_tool("canvas_wait_for_run", {"payload": {
                        "project_id": pid, "run_id": item["run_id"]}})
                    assert not view.is_error, view.content
                    terminal.append(view.structured_content["status"])
                    if terminal[-1] == "done":
                        assert view.structured_content["candidates"][0]["checks"]
                        assert any(part.type == "image" for part in view.content)
            assert sorted(terminal) == ["done", "failed"]
            assert len(vendor.calls("POST", path)) == len(vendor.received) == 2


async def test_real_batch_preserves_gateway_quota_result(isolated_data_root, tmp_path, gateway, upstream, monkeypatch):
    from character_workflow.lib import gateway_keys, gateway_tasks
    from character_workflow.lib.callers import atelier_gateway
    from character_workflow.lib.canvas_agent_schema import ApplyChangesInput
    from character_workflow.lib.canvas_agent_runtime import LOCAL
    from character_workflow.lib.jobs import list_jobs

    record = gateway_keys.read_config().keys[0]
    gateway_keys.update_key(record.id, quota={"period": "day", "cap_cny": 0.5})
    monkeypatch.setattr(gateway_tasks, "_estimate", lambda *_a, **_kw: 0.32)
    monkeypatch.setattr(atelier_gateway, "POLL_INTERVAL_SECONDS", 0.05)
    pid = create_canvas_project("Gateway batch").project_id
    changes = []
    for x, node in enumerate(["one", "two"]):
        changes.extend([{"op": "add_surface", "kind": "image", "title": node, "node_id": node,
                         "position": {"x": x * 300, "y": 0}},
                        {"op": "set_draft", "node_id": node, "mode": "image", "prompt": "cat",
                         "model": "gpt-image-2", "alias": "Hub", "params": {}}])
    doc = tools.apply_changes(LOCAL, ApplyChangesInput(project_id=pid, expected_revision=0, changes=changes))
    async with adapter_session(isolated_data_root, tmp_path) as client:
        batch = await client.call_tool("canvas_run_batch", {"payload": {"project_id": pid,
            "expected_revision": doc["revision"], "items": [{"surface_node_id": n} for n in ("one", "two")]}})
        assert not batch.is_error and batch.structured_content["submitted"] == 2
        views = []
        for row in batch.structured_content["items"]:
            waited = await client.call_tool("canvas_wait_for_run", {"payload": {
                "project_id": pid, "run_id": row["run_id"]}})
            assert not waited.is_error, waited.content
            views.append(waited.structured_content)
    assert sorted(v["status"] for v in views) == ["done", "failed"]
    failed = next(v for v in views if v["status"] == "failed")
    stored = next(job for job in list_jobs() if job.job_id == failed["job_id"])
    assert "中转额度已用完" in failed["error"] == stored.error
    assert failed["candidates"][0]["error"] == stored.canvas_run.candidates[0].error
    assert len(upstream["calls"]) == 1


async def test_four_outstanding_waits_bound_adapter_concurrency():
    class BlockingCanvas(FakeCanvas):
        def __init__(self):
            super().__init__(set())
            self.entered = threading.Barrier(5, timeout=4)
            self.release = threading.Event()

        def call(self, operation, payload):
            if operation == "canvas-wait-for-run":
                self.entered.wait()
                assert self.release.wait(5)
            return {"status": "pending"}

    fake = BlockingCanvas()
    async with Client(create_server(fake)) as client:
        payload = {"payload": {"project_id": "p", "run_id": "r"}}
        waits = [asyncio.create_task(client.call_tool("canvas_wait_for_run", payload)) for _ in range(4)]
        try:
            await asyncio.to_thread(fake.entered.wait)
            waits[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await waits[0]
            fifth = await client.call_tool("canvas_check_run", payload)
            assert fifth.is_error and fifth.structured_content["error"]["code"] == "CONNECTION_RATE_LIMITED"
        finally:
            fake.release.set()
            await asyncio.gather(*waits, return_exceptions=True)
        assert not (await client.call_tool("canvas_check_run", payload)).is_error


async def test_search_results_identify_each_native_thumbnail(isolated_data_root, tmp_path, canvas, team):
    from character_workflow.lib.canvas_agent_schema import ApplyChangesInput

    pid = canvas.project.project_id
    added = tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0,
        changes=[{"op": "add_asset_node", "asset_id": team.ref, "node_id": "ref"}]))
    asset = added["team_assets"][team.ref]
    async with adapter_session(isolated_data_root, tmp_path) as client:
        for name, identifier, ref in [("search_team", team.ref, team.ref),
                                      ("search_library", asset, "asset:" + asset)]:
            result = await client.call_tool("canvas_" + name, {"payload": {
                "project_id": pid, "category": "角色", "limit": 1}})
            assert not result.is_error and result.structured_content["assets"][0]["asset_id"] == identifier
            assert result.structured_content["attach_images"] == [ref]
            [image] = [part for part in result.content if part.type == "image"]
            assert image.mime_type == "image/jpeg" and image.data


@pytest.mark.parametrize("entry", ["builtin", "mcp_route"])
async def test_wait_leaves_event_loop_free_while_project_is_locked(entry, video_project, monkeypatch):
    import json
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib.canvas_agent_schema import GetRunInput
    from character_workflow.lib.canvas_projects import canvas_project_lock_path
    from character_workflow.lib.file_lock import file_lock
    from viewer_server import canvas_agent_routes as routes

    pid, video, image = video_project
    locked, reading, release = threading.Event(), threading.Event(), threading.Event()
    read = tools.read_canvas_document
    observed = []

    def hold():
        with file_lock(canvas_project_lock_path(pid)):
            locked.set()
            assert release.wait(4), "event loop stalled while the project lock was held"

    def observe_read(project_id):
        reading.set()
        return read(project_id)

    def select_images(project_id, ids):
        observed.append(list(ids))
        return original_filter(project_id, ids)

    original_filter = tools.image_versions
    monkeypatch.setattr(tools, "image_versions", select_images)
    monkeypatch.setattr(tools, "read_canvas_document", observe_read)
    monkeypatch.setattr(tools, "get_run", lambda *_: {"status": "done", "candidates": [
        {"status": "succeeded", "version_id": vid} for vid in (video, image)]})
    holder = asyncio.create_task(asyncio.to_thread(hold))
    try:
        assert await asyncio.to_thread(locked.wait, 2)
        if entry == "builtin":
            waiter = asyncio.create_task(runtime._wait_for_run(pid, "r"))
        else:
            request = SimpleNamespace(state=SimpleNamespace(connection_principal=runtime.LOCAL))
            waiter = asyncio.create_task(routes.wait_for_run(request, GetRunInput(project_id=pid, run_id="r")))
        assert await asyncio.to_thread(reading.wait, 2)
        await asyncio.sleep(0)
        assert not holder.done() and not waiter.done()
        assert observed == [[video, image]]
    finally:
        release.set()
        await holder
    result = await waiter
    if entry == "builtin":
        result = json.loads(result)
    assert result["status"] == "done" and result["attach_images"] == [image]
