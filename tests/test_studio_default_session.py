from concurrent.futures import ThreadPoolExecutor

import pytest

from character_workflow.lib import jobs, studio_agent_sessions as sessions
from character_workflow.lib.schemas import Job, JobParams
from character_workflow.lib.studio_agent import job_for
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app


BASE = "/api/studio/agent/sessions"
DEFAULT = "session-default-studio"


@pytest.fixture
def client(isolated_data_root):
    # 不进入应用 lifespan，直接覆盖首次请求触发的按需创建。
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root))
    yield client
    client.close()


def test_read_creates_one_default_session_under_contention():
    assert not sessions.session_path(DEFAULT).exists()
    with ThreadPoolExecutor(4) as pool:
        rows = list(pool.map(sessions.read, [DEFAULT] * 8))
    assert all(row == rows[0] for row in rows)
    assert rows[0].title == "默认会话"
    assert sessions.read(DEFAULT) == rows[0]


def test_first_list_creates_default_and_keeps_it_first(client):
    assert not sessions.session_path(DEFAULT).exists()
    assert [row["session_id"] for row in client.get(BASE).json()["sessions"]] == [DEFAULT]
    first = sessions.create({})
    second = sessions.create({})
    rows = client.get(BASE).json()["sessions"]
    assert [row["session_id"] for row in rows] == [DEFAULT, second.session_id, first.session_id]


def test_unreadable_default_keeps_other_sessions_visible():
    ordinary = sessions.create({})
    path = sessions.session_path(DEFAULT)
    path.write_text("invalid JSON", encoding="utf-8")
    assert [row["session_id"] for row in sessions.summaries()] == [ordinary.session_id]
    assert path.read_text(encoding="utf-8") == "invalid JSON"


def test_patch_and_delete_default_session(client):
    response = client.patch(f"{BASE}/{DEFAULT}", json={"model": "local-model", "model_alias": "local"})
    assert response.status_code == 200
    row = response.json()
    assert sessions.read(DEFAULT).model == "local-model"
    for headers in ({}, {"If-Match": str(row["revision"])}):
        rejected = client.delete(f"{BASE}/{DEFAULT}", headers=headers)
        assert rejected.status_code == 400
        assert rejected.json()["detail"] == "默认会话不能删除"
    assert client.get(f"{BASE}/{DEFAULT}").json() == row


def save_job(jid, sid=None, tid=None, **fields):
    return jobs.save_job(Job(
        job_id=jid, character_id="local", prompt="cat", submitted_at="now", model="m",
        params=JobParams(), output_paths=[], status="pending", error=None,
        studio_agent_session_id=sid, studio_agent_turn_id=tid, **fields,
    ))


@pytest.fixture
def mixed_jobs():
    other = sessions.create({}).session_id
    save_job("legacy")
    save_job("default-manual", DEFAULT)
    save_job("other-manual", other)
    save_job("other-agent", other, "turn-1")
    save_job("assist", namespace="assist", kind="text")
    return other


@pytest.mark.parametrize("default", [True, False])
def test_list_session_jobs(client, mixed_jobs, default):
    sid = DEFAULT if default else mixed_jobs
    response = client.get(f"{BASE}/{sid}/jobs")
    assert response.status_code == 200
    ids = {job["job_id"] for job in response.json()["jobs"]}
    assert ids == ({"legacy", "default-manual"} if default else {"other-manual", "other-agent"})


def test_agent_job_for_checks_same_ownership_as_list(mixed_jobs):
    assert job_for(DEFAULT, "legacy").job_id == "legacy"
    assert job_for(mixed_jobs, "other-manual").job_id == "other-manual"
    for sid, jid in [(mixed_jobs, "legacy"), (mixed_jobs, "default-manual"),
                     (DEFAULT, "other-agent"), (DEFAULT, "assist")]:
        with pytest.raises(ValueError, match="任务不属于当前对话"):
            job_for(sid, jid)


def test_delete_returns_jobs_after_turn_stops_and_preserves_outputs(client, monkeypatch, tmp_path):
    from viewer_server import studio_agent_routes

    session = sessions.create({})
    sid = session.session_id
    manual = save_job("manual", sid)
    agent = save_job("agent", sid, "turn-1")
    other = save_job("untouched", sessions.create({}).session_id)
    output = tmp_path / "result.png"
    output.write_bytes(b"result")

    async def stop_turn(stopped_sid):
        assert stopped_sid == sid
        assert jobs.read_job(agent.job_id).studio_agent_turn_id == "turn-1"
        jobs.update_job_status(manual.job_id, status=jobs.JobStatus.DONE, output_paths=[str(output)])

    monkeypatch.setattr(studio_agent_routes, "stop_task", stop_turn)
    response = client.delete(f"{BASE}/{sid}", headers={"If-Match": str(session.revision)})
    assert response.status_code == 204
    assert client.get(f"{BASE}/{sid}").status_code == 404
    assert jobs.read_job(other.job_id) == other
    assert jobs.read_job(manual.job_id).output_paths == [str(output)]
    assert output.read_bytes() == b"result"
    assert jobs.read_job(agent.job_id).status == agent.status
    jobs.update_job_status(agent.job_id, status=jobs.JobStatus.DONE, output_paths=[str(output)])
    assert {j["job_id"] for j in client.get(f"{BASE}/{DEFAULT}/jobs").json()["jobs"]} == {"agent", "manual"}
    reloaded = {job.job_id: job for job in jobs.list_jobs()}
    assert set(reloaded) == {"manual", "agent", "untouched"}
    for jid in ("agent", "manual"):
        assert reloaded[jid].studio_agent_session_id is None
        assert reloaded[jid].studio_agent_turn_id is None
        assert reloaded[jid].status == jobs.JobStatus.DONE


def test_delete_retries_only_remaining_jobs_after_write_failure(client, monkeypatch):
    session = sessions.create({})
    sid = session.session_id
    save_job("a", sid, "turn-1")
    save_job("b", sid)
    url = f"{BASE}/{sid}"
    headers = {"If-Match": str(session.revision)}
    write = jobs.write_job_under_lock
    attempts = []

    def fail_second(job):
        attempts.append(job.job_id)
        if len(attempts) == 2:
            raise OSError("simulated disk error")
        return write(job)

    monkeypatch.setattr(jobs, "write_job_under_lock", fail_second)
    assert client.delete(url, headers=headers).status_code == 500
    assert sessions.read(sid) == session
    assert jobs.read_job("a").studio_agent_session_id is None
    assert jobs.read_job("b").studio_agent_session_id == sid
    assert client.delete(url, headers=headers).status_code == 204
    assert attempts == ["a", "b", "b"]
    assert not sessions.session_path(sid).exists()
    assert [(job.job_id, job.studio_agent_session_id, job.studio_agent_turn_id)
            for job in jobs.list_jobs()] == [("a", None, None), ("b", None, None)]


def test_delete_preserves_session_when_job_cannot_be_read(client, monkeypatch):
    session = sessions.create({})
    save_job("unreadable", session.session_id)
    url = f"{BASE}/{session.session_id}"
    headers = {"If-Match": str(session.revision)}

    with monkeypatch.context() as patch:
        def deny_read(path):
            raise PermissionError("simulated read failure")

        patch.setattr(jobs, "read_text_with_retry", deny_read)
        assert client.delete(url, headers=headers).status_code == 500
        assert sessions.read(session.session_id) == session
    assert client.delete(url, headers=headers).status_code == 204
    assert jobs.read_job("unreadable").studio_agent_session_id is None
