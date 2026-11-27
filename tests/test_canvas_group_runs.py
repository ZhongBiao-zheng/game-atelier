from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_group_runs as runs
from character_workflow.lib.canvas_projects import canvas_project_dir, create_canvas_project
from character_workflow.lib.jobs import JobStatus
from tests.local_client import LocalTestClient
from tests.test_canvas_group_plan import group_document
from viewer_server.server_app import build_app


@pytest.fixture
def group(monkeypatch, isolated_data_root):
    pid = create_canvas_project("分组").project_id
    doc = group_document(pid, edges=[("a", "b"), ("b", "c"), ("c", "d")])
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    monkeypatch.setattr(runs, "_launch", lambda *_: None)
    client = LocalTestClient(app=build_app(dist_dir=isolated_data_root / "dist"),
                             base_url="http://127.0.0.1")
    return pid, client, f"/api/canvas/projects/{pid}"


def test_concurrent_and_stale(group):
    pid, client, base = group
    plan = client.post(base + "/groups/group/run-plan").json()
    url = base + "/groups/group/group-runs"
    for invalid in ({"total_cny": 1}, {"order": []}):
        response = client.post(url, json={**plan, **invalid})
        assert (response.status_code, response.json()["detail"]) == (409, runs.STALE)
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda _: client.post(url, json=plan), range(2)))
    assert sorted(r.status_code for r in replies) == [201, 409]
    assert next(r for r in replies if r.status_code == 409).json()["detail"] == runs.BUSY


def test_failure_resume_interrupt_cancel(group, monkeypatch):
    pid, _, _ = group
    jobs, submissions = {}, []
    def submit(project_id, run, step):
        submissions.append(step["node_id"])
        job = SimpleNamespace(job_id=step["job_id"], status=JobStatus.PENDING,
                              canvas_run=SimpleNamespace(result_node_id=step["node_id"],
                                                        candidates=[SimpleNamespace(version_id="v")]),
                              error="假上游失败")
        jobs[job.job_id] = job
        return job
    monkeypatch.setattr(runs, "_submit_step", submit)
    monkeypatch.setattr(runs, "read_job", jobs.__getitem__)
    monkeypatch.setattr(runs.canvas_run_queue, "submit", lambda _: None)
    rid = runs.start(pid, "group", list("abcd"), 0)["run_id"]
    def tick():
        return runs._advance(pid, rid)
    assert tick() == tick() == "wait"
    jobs[next(iter(jobs))].status = JobStatus.DONE
    assert tick() == "advance"
    assert tick() == "wait"
    jobs[next(reversed(jobs))].status = JobStatus.FAILED
    assert tick() == "stop"
    assert runs.list_runs(pid)[0]["status"] == "failed" and submissions == ["a", "b"]
    runs.resume(pid, rid)
    assert tick() == "wait" and submissions == ["a", "b", "b"]
    runs.recover_group_runs(pid, resumable=set())
    assert runs.list_runs(pid)[0]["status"] == "interrupted" and tick() == "stop"
    runs.resume(pid, rid)
    assert tick() == "wait" and submissions == ["a", "b", "b"]
    runs.cancel(pid, rid)
    assert tick() == "stop" and jobs[next(reversed(jobs))].status == JobStatus.PENDING



def test_second_execution_freezes_new_output_from_populated_surface(group, monkeypatch):
    from character_workflow.lib import canvas_projects as cp, canvas_runs, jobs, keys
    from tests.test_canvas_candidates import PNG

    pid, _, _ = group
    doc = group_document(pid, edges=[("a", "b")], drafts=["a", "b"])
    model = keys.ModelSpec(id="gpt-image-1", name="test", modality="image", protocol="openai")
    key = keys.KeySpec(alias="local", provider="openai", created_at="now", models=[model])
    keys.write_keys_db(keys.KeysDB(keys=[key], default_alias="local"))
    doc.nodes[0].data.generation_draft.params.n = 3
    for node in doc.nodes[:2]:
        node.data.generation_draft.alias = key.alias
        node.data.generation_draft.model = model.id
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    monkeypatch.setattr(runs.canvas_run_queue, "submit", lambda _: None)
    first_version = None
    for attempt in range(2):
        plan = runs.group_plan(pid, "group")
        assert [row["count"] for row in plan["steps"]] == [3, 1]
        run = runs.start(pid, "group", plan["order"], plan["total_cny"])
        rid = run["run_id"]
        upstream_node_id = upstream_version = None
        for index in range(2):
            assert runs._advance(pid, rid) == "wait"
            step = runs._load(pid, rid)["steps"][index]
            job = jobs.read_job(step["job_id"])
            if index == 1:
                assert job.canvas_run.snapshot.inputs[0].version_id == upstream_version
                assert job.canvas_run.snapshot.inputs[0].node_id == upstream_node_id
            count = (3, 1)[index]
            assert job.params.n == count
            assert job.canvas_run.result_node_id == step["node_id"]
            paths = []
            for slot in range(count):
                path = cp.canvas_output_dir(pid, job.job_id) / f"image-{slot}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(PNG)
                paths.append(str(path))
            jobs.update_job_status(job.job_id, status=JobStatus.DONE, output_paths=paths)
            finalized, updated = canvas_runs.finalize_canvas_run(pid, job.job_id)
            assert updated.nodes[index].data.current_version_id == finalized.canvas_run.candidates[0].version_id
            assert len(updated.content_versions) == attempt * 4 + (3, 4)[index]
            assert updated.connections == doc.connections
            assert [(n.id, n.position, n.size) for n in updated.nodes] == [
                (n.id, n.position, n.size) for n in doc.nodes]
            assert updated.nodes[-1].data.member_node_ids == doc.nodes[-1].data.member_node_ids
            if index == 0:
                upstream_node_id = finalized.canvas_run.result_node_id
                upstream_version = finalized.canvas_run.candidates[0].version_id
                assert upstream_version and upstream_version != first_version
                first_version = upstream_version
            assert runs._advance(pid, rid) == "advance"
        assert runs._advance(pid, rid) == "stop" and runs._load(pid, rid)["status"] == "done"


def test_update_and_data_move_wait_between_steps(group):
    from viewer_server.update_routes import active_work, data_root_move_work, work_request

    pid, _, base = group
    assert work_request(base + "/groups/group/group-runs", "POST")
    assert work_request(base + "/group-runs/grun_id/resume", "POST")
    assert not work_request(base + "/group-runs/grun_id/cancel", "POST")
    assert not work_request(base + "/groups/group/run-plan", "POST")
    run = runs.start(pid, "group", list("abcd"), 0)
    assert active_work()["jobs"] == data_root_move_work()["jobs"] == 1
    runs.cancel(pid, run["run_id"])
    assert active_work()["jobs"] == 0


@pytest.mark.parametrize("persist_failure", [True, False])
def test_worker_failure_releases_group_and_update_gate(group, monkeypatch, persist_failure):
    pid, _, _ = group
    run = runs.start(pid, "group", list("abcd"), 0)

    def denied(*_):
        raise PermissionError("checkpoint unavailable")
    monkeypatch.setattr(runs, "_advance", denied)
    with monkeypatch.context() as failure:
        if not persist_failure:
            failure.setattr(runs, "atomic_write_json", denied)
        runs._work(pid, run["run_id"])
        stopped, = runs.list_runs(pid)
        assert stopped["status"] == "failed"
        assert "checkpoint unavailable" in stopped["steps"][0]["error"]
        assert runs.active_step_jobs() == []
        runs._check_idle(pid, "group")
    assert runs.resume(pid, run["run_id"])["status"] == "running"


def test_changed_model_with_same_price_rejects_web_quote(group):
    from character_workflow.lib import canvas_projects as cp

    pid, client, base = group
    quote = client.post(base + "/groups/group/run-plan").json()
    doc = cp.read_canvas_document(pid)
    doc.nodes[0].data.generation_draft.model += "-changed"
    cp.save_canvas_document(pid, doc, doc.revision)
    response = client.post(base + "/groups/group/group-runs", json=quote)
    assert response.status_code == 409 and response.json()["detail"] == runs.STALE


@pytest.mark.parametrize("claimed", [False, True])
def test_startup_reconciles_job_before_group_recovery(group, monkeypatch, claimed):
    from concurrent.futures import Future
    from threading import Event
    from character_workflow.lib import canvas_projects as cp, jobs, keys

    pid, client, _ = group
    doc = group_document(pid, edges=[("a", "b")], drafts=["a", "b"])
    model = keys.ModelSpec(id="gpt-image-1", name="test", modality="image", protocol="openai")
    key = keys.KeySpec(alias="local", provider="openai", created_at="now", models=[model])
    keys.write_keys_db(keys.KeysDB(keys=[key], default_alias="local"))
    for node in doc.nodes[:2]:
        node.data.generation_draft.alias = key.alias
        node.data.generation_draft.model = model.id
    cp.save_canvas_document(pid, doc, doc.revision)
    plan = runs.group_plan(pid, "group")
    rid = runs.start(pid, "group", plan["order"], plan["total_cny"])["run_id"]
    monkeypatch.setattr(runs.canvas_run_queue, "submit", lambda _: None)
    assert runs._advance(pid, rid) == "wait"
    job_id = runs._load(pid, rid)["steps"][0]["job_id"]
    if claimed:
        jobs.save_job(jobs.read_job(job_id).model_copy(update={"runner_started_at": runs._now()}))

    launched = []
    queued = Event()
    def submit_existing(resumed_id):
        assert resumed_id == job_id
        queued.set()
        future = Future()
        future.set_result(None)
        return future
    monkeypatch.setattr(runs.canvas_run_queue, "submit", submit_existing)
    monkeypatch.setattr(runs, "_launch", lambda p, r: launched.append((p, r)))
    with client:
        recovered = runs._load(pid, rid)
        assert recovered["steps"][0]["job_id"] == job_id
        if claimed:
            assert recovered["status"] == "interrupted"
            assert recovered["steps"][0]["status"] == "failed"
            assert "未自动重试以避免重复扣费" in recovered["steps"][0]["error"]
            assert jobs.read_job(job_id).status == JobStatus.FAILED
            assert not cp.read_canvas_document(pid).nodes[0].data.active_run_id
            assert not launched and not queued.is_set()
        else:
            assert recovered["status"] == "running" and launched == [(pid, rid)]
            assert queued.wait(3)
            assert jobs.read_job(job_id).status == JobStatus.PENDING


def test_group_text_batch_keeps_every_candidate_on_the_original_node(group, monkeypatch):
    from character_workflow.lib import canvas_projects as cp, canvas_runs, jobs, keys
    from character_workflow.lib.schemas import CanvasDocument

    pid, _, _ = group
    raw = group_document(pid, drafts=["a"]).model_dump(mode="json")
    raw["nodes"][0].update(type="text", data={"generation_draft": {
        "mode": "text", "alias": "local", "model": "gpt-4o-mini", "prompt": "分镜",
        "params": {"n": 3}, "updated_at": "now"}})
    doc = CanvasDocument.model_validate(raw)
    cp.save_canvas_document(pid, doc, doc.revision)
    model = keys.ModelSpec(id="gpt-4o-mini", name="test", modality="text", protocol="openai-chat")
    key = keys.KeySpec(alias="local", provider="custom", created_at="now", models=[model])
    keys.write_keys_db(keys.KeysDB(keys=[key], default_alias="local"))
    monkeypatch.setattr(runs.canvas_run_queue, "submit", lambda _: None)
    plan = runs.group_plan(pid, "group")
    assert plan["steps"][0]["count"] == 3
    rid = runs.start(pid, "group", plan["order"], plan["total_cny"])["run_id"]
    assert runs._advance(pid, rid) == "wait"
    job_id = runs._load(pid, rid)["steps"][0]["job_id"]
    folder = cp.canvas_output_dir(pid, job_id)
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for slot in range(3):
        path = folder / f"{slot}.txt"
        path.write_text(f"分镜 {slot}")
        paths.append(str(path))
    jobs.update_job_status(job_id, status=JobStatus.DONE, output_paths=paths)
    job, result = canvas_runs.finalize_canvas_run(pid, job_id)
    assert len(result.nodes) == len(doc.nodes) and result.connections == doc.connections
    assert result.nodes[0].data.current_version_id == job.canvas_run.candidates[0].version_id
    assert {c.version_id for c in job.canvas_run.candidates} == set(result.content_versions)
