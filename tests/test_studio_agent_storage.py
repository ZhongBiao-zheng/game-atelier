import asyncio
import json
from datetime import datetime, timedelta, timezone
from threading import Event

import pytest

from character_workflow.lib import agent_usage, jobs, studio_agent_sessions as sessions
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.schemas import Job, JobParams
from tests.local_client import LocalTestClient
from viewer_server import studio_agent_routes, update_routes
from viewer_server.server_app import build_app


def test_job_ownership_storage_and_manual_retry(isolated_data_root):
    shared = dict(character_id="local", prompt="cat", submitted_at="now", model="m",
                  output_paths=[], status="failed", error="failed")
    owned = Job(**shared, job_id="owned", params=JobParams(),
                studio_agent_session_id="session-aaaaaaaa", studio_agent_turn_id="turn-1")
    ordinary = Job(**shared, job_id="ordinary", params=JobParams.model_validate({
        "_studio_agent": {"studio_agent_session_id": "session-aaaaaaaa"},
    }))
    for job in (owned, ordinary):
        jobs.save_job(job)
        saved = json.loads((isolated_data_root / ".runtime/jobs" / f"{job.job_id}.json").read_text())
        assert "studio_agent_session_id" not in saved and "studio_agent_turn_id" not in saved
        assert ("_studio_agent" in saved["params"]) == (job == owned)
    assert jobs.read_job("owned") == owned
    assert jobs.read_job("ordinary").studio_agent_session_id is None
    retry = jobs.read_job(jobs.clone_job_for_retry("owned").job_id)
    assert retry.studio_agent_session_id is None and retry.studio_agent_turn_id is None


def test_old_and_studio_gateway_usage_are_isolated():
    sid = "session-aaaaaaaa"
    canvas = "canvas-aaaaaaaa"
    since = datetime.now(timezone.utc) - timedelta(minutes=1)
    for project, tag in [(canvas, f"{sid}:1"), (None, f"studio:{sid}:1")]:
        agent_usage.record_request(project_id=project, session_id=sid, key=None, alias="lan",
                                   model="m", input_tokens=4, output_tokens=2, cached_tokens=0)
        agent_usage.add_pending(project_id=project, session_id=sid, call_tag=tag, alias="lan", model="m")
    fetched = []

    def fetch(alias, tag):
        fetched.append(tag)
        return {"requests": 1, "charged_cny": 7}

    assert agent_usage.settle_pending(None, sid, fetch=fetch) == 1
    assert fetched == [f"studio:{sid}:1"]
    assert agent_usage.session_totals(None, sid, since)["cost_cny"] == 7
    assert agent_usage.session_totals(canvas, sid, since)["cost_cny"] is None
    assert agent_usage.settle_pending(fetch=fetch) == 1
    assert fetched == [f"studio:{sid}:1", f"{sid}:1"]
    rows = agent_usage.read_rows()
    assert all("workspace" not in row for row in rows if row["project_id"] == canvas)
    assert all(row["workspace"] == "studio" for row in rows if row["project_id"] is None)
    records = agent_usage.usage_records(rows, {}, {}, datetime.now().astimezone())
    assert {(r["project"], r["cost_cny"]) for r in records} == {("studio", 7), (f"canvas:{canvas}", 7)}


def test_update_waits_for_studio_and_recovers_an_abandoned_turn(isolated_data_root):
    def make(status):
        row = sessions.create({})
        return sessions.mutate(row.session_id, lambda current, now: {
            "status": status, "turns": [{"turn_id": "turn-1", "client_message_id": "m", "status": status}],
        })

    orphan, awaiting = make("running"), make("awaiting_approval")
    assert update_routes.active_work()["agents"] == 1
    base = f"/api/studio/agent/sessions/{awaiting.session_id}"
    with LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root)) as client:
        assert sessions.read(orphan.session_id).turns[-1].status == "interrupted"
        assert update_routes.active_work()["agents"] == 0
        assert update_routes.active_work()["approvals"] == 1
        update_routes.admission().maintenance = True
        assert client.post(base + "/messages", json={}).status_code == 503
        assert client.post(base + "/approvals", json={"decisions": []}).status_code == 422
        assert client.post(base + "/cancel").status_code == 200
        assert update_routes.active_work()["approvals"] == 0


def test_delete_keeps_concurrent_edit_and_live_task(isolated_data_root, monkeypatch):
    app = build_app(dist_dir=isolated_data_root)
    stop_called = Event()

    async def note_stop(sid):
        stop_called.set()

    monkeypatch.setattr(studio_agent_routes, "stop_task", note_stop)
    with LocalTestClient(base_url="http://127.0.0.1", app=app) as client:
        original = sessions.create({})
        base = f"/api/studio/agent/sessions/{original.session_id}"
        delete = sessions.delete

        def edited_before_lock(sid, revision):
            sessions.mutate(sid, lambda current, now: {"title": "同时编辑"})
            return delete(sid, revision)

        monkeypatch.setattr(sessions, "delete", edited_before_lock)
        response = client.delete(base, headers={"If-Match": str(original.revision)})
        assert response.status_code == 409
        assert sessions.read(original.session_id).title == "同时编辑"
        assert not stop_called.is_set()


def test_locked_attachment_keeps_delete_retryable(isolated_data_root, monkeypatch):
    app = build_app(dist_dir=isolated_data_root)
    with LocalTestClient(base_url="http://127.0.0.1", app=app) as client:
        row = sessions.create({})
        base = f"/api/studio/agent/sessions/{row.session_id}"
        directory = sessions.upload_dir(row.session_id)
        directory.mkdir(parents=True)
        headers = {"If-Match": str(row.revision)}

        def sharing_violation(*_args):
            raise PermissionError("file in use")

        with monkeypatch.context() as patch:
            patch.setattr(sessions.trash, "move_to_trash", sharing_violation)
            assert client.delete(base, headers=headers).status_code == 409
            assert client.get(base).json()["revision"] == row.revision
        assert client.delete(base, headers=headers).status_code == 204
        assert not directory.exists()


def test_delete_waits_for_turn_cleanup_before_unlink(isolated_data_root, monkeypatch):
    started, exited = Event(), Event()

    async def run_until_canceled(ws, notify):
        started.set()
        try:
            await asyncio.Future()
        finally:
            assert sessions.read(ws.session_id).status == "running"
            with pytest.raises(CanvasToolError) as blocked:
                await asyncio.to_thread(sessions.mutate, ws.session_id, lambda row, now: {"title": "迟到"})
            assert blocked.value.code == "SESSION_DELETING"
            exited.set()

    monkeypatch.setattr(studio_agent_routes.runtime, "run_workspace_turn", run_until_canceled)
    app = build_app(dist_dir=isolated_data_root)
    with LocalTestClient(base_url="http://127.0.0.1", app=app) as client:
        row = sessions.create({"model": "fake", "model_alias": "fake"})
        base = f"/api/studio/agent/sessions/{row.session_id}"
        sent = client.post(base + "/messages", json={"text": "hello", "client_message_id": "first"})
        assert sent.status_code == 202 and started.wait(5)
        assert client.delete(base, headers={"If-Match": str(row.revision)}).status_code == 409
        assert not exited.is_set()
        assert client.delete(base, headers={"If-Match": str(sent.json()["revision"])}).status_code == 204
        assert exited.is_set() and client.get(base).status_code == 404
