import asyncio
from pathlib import Path
import threading

import httpx
import pytest

from character_workflow.lib import plugin_registry, video_operations as ops
from character_workflow.lib.canvas_projects import canvas_project_lock_path, create_canvas_project
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.video_service import service
from tests.test_video_operations import request, upload
from viewer_server.server_app import build_app


async def test_video_routes_project_scope_idempotency_and_loop(tmp_path, isolated_data_root, monkeypatch):
    project, version = upload()
    other = create_canvas_project("另一个项目").project_id
    base = "/api/plugins/video-tools/routes/"
    app = build_app(dist_dir=tmp_path / "dist")
    headers = {"Origin": "http://127.0.0.1:5199", "Sec-Fetch-Site": "same-origin",
               "X-Atelier-Client": "video-test-client"}
    started, release = asyncio.Event(), asyncio.Event()

    async def render(project, body, path, progress):
        path.write_bytes(b"test")
        started.set()
        await release.wait()
        return {"width": 320, "height": 192, "duration_ms": 500}

    monkeypatch.setattr(service().queue, "render", render)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1:5199", headers=headers) as client:
        assert (await client.post("/api/connection/local-session", json={})).is_success
        assert (await client.post("/api/connection/editor-lease",
                                  json={"client_id": headers["X-Atelier-Client"]})).is_success
        assert "video-tools" not in plugin_registry.enabled_ids()
        assert (await client.post("/api/plugins/video-tools/enable", json={})).is_success
        assert not plugin_registry.find("video-tools").lock.contributes.agent_tools

        async def call(route, params, pid=project):
            return await client.post(base + route, json={"project_id": pid, "params": params})

        args = request(version, "one").model_dump()
        assert (await call("submit", args, other)).status_code == 403
        assert (await call("probe", {"version_id": version.version_id}, other)).status_code == 403
        assert (await call("probe", {"path": "/tmp/video.mp4"})).status_code == 422
        entered = threading.Event()
        unlock = threading.Event()

        def hold():
            with file_lock(canvas_project_lock_path(project)):
                entered.set()
                assert unlock.wait(5)

        holder = asyncio.create_task(asyncio.to_thread(hold))
        assert await asyncio.to_thread(entered.wait, 2)
        pending = asyncio.create_task(call("submit", args))
        try:
            await asyncio.sleep(0.05)
            assert not pending.done()
        finally:
            unlock.set()
        await holder
        reply = await pending
        assert reply.status_code == 200, reply.text
        key = {"operation_id": reply.json()["result"]["operation_id"]}
        await asyncio.wait_for(started.wait(), 3)
        assert (await call("submit", args)).json()["result"]["operation_id"] == key["operation_id"]
        assert (await call("get", key)).json()["result"]["status"] == "running"
        assert (await call("get", key, other)).status_code == 404
        assert (await call("cancel", key, other)).status_code == 404
        assert (await call("cancel", key)).json()["result"]["status"] == "canceled"
        await service().queue.worker
        assert not ops.Record(project, key["operation_id"]).stage.exists()
        for folder in ("jobs", "agent-usage", "gateway-charges"):
            assert not list((Path(isolated_data_root) / ".runtime" / folder).glob("*"))


@pytest.mark.asyncio
async def test_actual_child_termination(tmp_path):
    import sys
    from character_workflow.lib.video_encoder import command

    marker = tmp_path / "started"
    done = tmp_path / "child-survived"
    child = "import pathlib,sys,time; time.sleep(.8); pathlib.Path(sys.argv[1]).touch()"
    parent = ("import pathlib,subprocess,sys,time; subprocess.Popen([sys.executable,'-c',"
              "sys.argv[1],sys.argv[3]]); pathlib.Path(sys.argv[2]).touch(); time.sleep(10)")
    task = asyncio.create_task(command([sys.executable, "-c", parent, child, str(marker), str(done)]))
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(.85)
    assert not done.exists()
