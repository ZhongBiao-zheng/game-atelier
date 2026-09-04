from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from pydantic import ValidationError

from character_workflow.lib import jobs, keys, projects, workshop as ws
from character_workflow.lib import workshop_generation as generation
from character_workflow.lib.character_derivatives import initialize_character_directory
from character_workflow.lib.job_runner import JobRunnerError, run_job
from character_workflow.lib.schemas import JobStatus
from character_workflow.lib.workshop_schema import (
    AcknowledgeFeedbackInput, CreateTargetInput, GetGenerationInput, ListMediaInput,
    ListProjectsInput, ListTargetsInput, PrepareGenerationInput, ReadDocumentInput, ReadMediaInput,
    TargetInput, WithdrawGenerationInput, WriteDocumentInput,
)


@pytest.fixture
def setup(isolated_data_root):
    project = projects.create_project("工坊回归", "workshop-test")
    initialize_character_directory("bird", "# 小鸟\n\n黄色羽毛")
    projects.assign_character("bird", project.id)
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="fake", provider="openai", access_key="test-only-not-a-real-key",
        modalities=["image", "video"], models=[
            keys.ModelSpec(id="gpt-image-1", name="Fake Image", modality="image", protocol="openai"),
            keys.ModelSpec(id="seedance-2-0", name="Fake Video", modality="video", protocol="seedance"),
        ], created_at="2026-08-31T00:00:00Z",
    )]))
    local = SimpleNamespace(kind="local", session_id="human-session", grant_id=None)
    agent = SimpleNamespace(kind="agent", session_id="agent-session", grant_id="grant-one",
                            project_ids=frozenset([project.id]),
                            capabilities=frozenset(["read", "edit_documents", "create_targets",
                                                    "prepare_generation"]))
    target = {"type": "character", "project_id": project.id,
              "character_id": "bird", "asset_slot": "portrait"}
    return SimpleNamespace(root=isolated_data_root, project=project,
                           local=local, agent=agent, target=target)


def prepare(setup, **updates):
    values = {"target": setup.target, "prompt": "黄色小鸟", "alias": "fake",
              "model": "gpt-image-1", "params": {"type": "image", "n": 1},
              "idempotency_key": "prepare-first"}
    values.update(updates)
    return generation.prepare_generation(setup.agent, PrepareGenerationInput(**values))


def approve(setup, request):
    return generation.approve_generation(setup.local, request["request_id"],
                                           request["revision"], lambda *_: True)


def fake_image(**kwargs):
    path = Path(kwargs["output_dir"]) / "output.png"
    Image.new("RGB", (16, 24), "yellow").save(path)
    return [str(path)]


@pytest.mark.parametrize("slot", ["portrait", "promo", "turnaround"])
def test_character_workflow_reuses_original_output_and_one_runner(setup, monkeypatch, slot):
    import character_workflow.lib.job_runner as runner
    calls = []
    def dispatch(**kwargs):
        calls.append(kwargs)
        return fake_image(**kwargs)
    monkeypatch.setattr(runner, "dispatch", dispatch)
    prepared = prepare(setup, target={**setup.target, "asset_slot": slot})
    assert jobs.list_jobs() == [] and calls == []
    repeated = prepare(setup, target={**setup.target, "asset_slot": slot})
    assert repeated["request_id"] == prepared["request_id"]
    approved = approve(setup, prepared)
    assert approve(setup, prepared)["job_id"] == approved["job_id"]
    job = run_job(approved["job_id"], workshop_grant_is_active=lambda *_: True)
    assert job.status == JobStatus.DONE and len(calls) == 1
    assert Path(job.output_paths[0]).parent == setup.root / "characters" / "bird" / slot
    with pytest.raises(JobRunnerError):
        run_job(job.job_id)
    result = generation.get_generation(setup.agent, GetGenerationInput(request_id=prepared["request_id"]))
    assert result["job"] == {"status": "done", "error": None, "output_count": 1}
    assert len(result["output_media_ids"]) == 1
    media = ws.read_media(setup.agent, ReadMediaInput(target=prepared["target"],
                                                     media_id=result["output_media_ids"][0]))
    assert media["width"] == 16 and media["height"] == 24
    assert str(setup.root) not in json.dumps(result)


@pytest.mark.parametrize("kind", ["ui_screen", "video"])
def test_ui_and_video_end_to_end_use_existing_workshop_layout(setup, monkeypatch, kind):
    import character_workflow.lib.job_runner as runner
    values = {"project_id": setup.project.id, "type": kind, "name": "测试目标",
              "idempotency_key": "create-target-one"}
    if kind == "ui_screen":
        values["ui_scheme_id"] = "v1"
    created = ws.create_target(setup.agent, CreateTargetInput(**values))
    assert ws.create_target(setup.agent, CreateTargetInput(**values)) == created
    target = created["target"]
    if kind == "video":
        def fake_video(**kwargs):
            path = Path(kwargs["output_dir"]) / "video.mp4"
            path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 40)
            return [str(path)]
        monkeypatch.setattr(runner, "dispatch_video", fake_video)
        request = prepare(setup, target=target, model="seedance-2-0", params={"type": "video"})
        directory = setup.root / "projects" / setup.project.slug / "videos" / target["production_id"] / "versions"
    else:
        monkeypatch.setattr(runner, "dispatch", fake_image)
        request = prepare(setup, target=target)
        directory = setup.root / "projects" / setup.project.slug / "ui" / "v1" / "screens" / target["screen_id"]
    job = run_job(approve(setup, request)["job_id"], workshop_grant_is_active=lambda *_: True)
    assert job.status == JobStatus.DONE
    assert Path(job.output_paths[0]).parent == directory
    assert ws.list_media(setup.agent, ListMediaInput(target=target))["total"] == 1


def test_context_reads_without_consuming_feedback_and_document_cas(setup):
    drafts = setup.root / ".runtime" / "draft"
    drafts.mkdir()
    (drafts / "bird.md").write_text("<!-- character: bird -->\n再黄一些", encoding="utf-8")
    (drafts / "other.md").write_text("<!-- character: other -->\n秘密反馈", encoding="utf-8")
    context = ws.get_context(setup.agent, TargetInput(target=setup.target))
    assert len(context["feedback"]) == 1 and (drafts / "bird.md").is_file()
    old = ws.read_document(setup.agent, ReadDocumentInput(target=setup.target, kind="character_spec"))
    write = WriteDocumentInput(target=setup.target, kind="character_spec", expected_revision=old["revision"],
                               content="# 新小鸟\n", idempotency_key="write-spec-first")
    saved = ws.write_document(setup.agent, write)
    assert ws.write_document(setup.agent, write) == saved
    with pytest.raises(ws.WorkshopError, match="文档已修改"):
        ws.write_document(setup.agent, write.model_copy(update={"idempotency_key": "write-spec-second"}))
    ack = AcknowledgeFeedbackInput(target=setup.target,
                                   feedback_ids=[context["feedback"][0]["feedback_id"]],
                                   idempotency_key="ack-first-feedback")
    assert ws.acknowledge_feedback(setup.agent, ack) == ws.acknowledge_feedback(setup.agent, ack)
    assert not (drafts / "bird.md").exists() and (drafts / "other.md").is_file()


def test_authorization_checks_project_and_each_object(setup):
    other = projects.create_project("其他项目", "other")
    initialize_character_directory("secret", "# 私密角色")
    projects.assign_character("secret", other.id)
    listed = ws.list_projects(setup.agent, ListProjectsInput())
    assert listed["projects"] == [{"project_id": setup.project.id, "name": setup.project.name}]
    for target in [dict(setup.target, character_id="secret"),
                   dict(setup.target, project_id=other.id, character_id="secret")]:
        with pytest.raises(ws.WorkshopError) as error:
            ws.get_context(setup.agent, TargetInput(target=target))
        assert error.value.status == 403
    read_only = SimpleNamespace(**{**vars(setup.agent), "capabilities": frozenset(["read"])})
    with pytest.raises(ws.WorkshopError):
        generation.prepare_generation(read_only, PrepareGenerationInput(
            target=setup.target, prompt="x", alias="fake", model="gpt-image-1",
            params={"type": "image"}, idempotency_key="not-permitted"))


def test_prepare_references_are_registered_and_frozen(setup, monkeypatch):
    source = setup.root / "characters" / "bird" / "source" / "ref.png"
    Image.new("RGB", (8, 8), "yellow").save(source)
    listed = ws.list_media(setup.agent, ListMediaInput(target=setup.target))["media"]
    request = prepare(setup, media_ids=[listed[0]["media_id"]])
    original = source.read_bytes()
    Image.new("RGB", (8, 8), "blue").save(source)
    approved = approve(setup, request)
    frozen_job = jobs.read_job(approved["job_id"])
    assert Path(frozen_job.params.reference_images[0]).read_bytes() == original
    with pytest.raises(ws.WorkshopError) as error:
        prepare(setup, media_ids=[listed[0]["media_id"]])
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    with pytest.raises(ws.WorkshopError):
        prepare(setup, media_ids=["m-other-target"], idempotency_key="other-ref")
    preview = ws.read_media(setup.agent, ReadMediaInput(target=setup.target, media_id=listed[0]["media_id"]))
    assert preview["width"] == 8 and preview["preview"]["mime_type"] == "image/jpeg"
    assert str(setup.root) not in json.dumps(preview)


@pytest.mark.parametrize("change", ["key", "snapshot"])
def test_changed_frozen_inputs_or_provider_require_new_approval(setup, change):
    source = setup.root / "characters" / "bird" / "source" / "ref.png"
    Image.new("RGB", (8, 8)).save(source)
    media = ws.list_media(setup.agent, ListMediaInput(target=setup.target))["media"][0]
    request = prepare(setup, media_ids=[media["media_id"]])
    if change == "key":
        keys.patch_key("fake", {"base_url": "https://different.invalid"})
    else:
        record = generation.read_request(request["request_id"])
        Path(record.references[0]["snapshot_path"]).write_bytes(b"changed")
    with pytest.raises(ws.WorkshopError):
        approve(setup, request)
    assert jobs.list_jobs() == []


def test_agent_without_execute_capability_cannot_approve_and_revoked_grant_blocks_human(setup):
    request = prepare(setup)
    with pytest.raises(ws.WorkshopError) as error:
        generation.approve_generation(setup.agent, request["request_id"], 1,
                                      lambda _g, _p, capability: capability != "execute_generation")
    assert error.value.code == "CAPABILITY_DENIED"
    with pytest.raises(ws.WorkshopError):
        generation.approve_generation(setup.local, request["request_id"], 1, lambda *_: False)
    assert not jobs.list_jobs()


def test_expiry_withdraw_and_idempotency_conflicts(setup):
    request = prepare(setup)
    with pytest.raises(ws.WorkshopError) as error:
        prepare(setup, prompt="different")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    withdrawn = generation.withdraw_generation(setup.agent, WithdrawGenerationInput(
        request_id=request["request_id"], expected_revision=1))
    assert withdrawn["state"] == "withdrawn"
    with pytest.raises(ws.WorkshopError):
        approve(setup, withdrawn)
    request = prepare(setup, idempotency_key="expired-second")
    record = generation.read_request(request["request_id"])
    record.expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    generation._save(record)
    with pytest.raises(ws.WorkshopError) as error:
        approve(setup, request)
    assert error.value.code == "REQUEST_EXPIRED"
    assert generation.read_request(request["request_id"]).state == "expired"


def test_double_approve_concurrency_reuses_single_job(setup):
    request = prepare(setup)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: approve(setup, request), range(2)))
    assert results[0]["job_id"] == results[1]["job_id"]
    assert len(jobs.list_jobs()) == 1


def test_approval_transaction_recovery_and_unknown_execution_never_resubmits(setup, monkeypatch):
    request = prepare(setup)
    original = generation.save_job
    monkeypatch.setattr(generation, "save_job", lambda _: (_ for _ in ()).throw(OSError("crash")))
    with pytest.raises(OSError):
        approve(setup, request)
    monkeypatch.setattr(generation, "save_job", original)
    recovered = generation.recover_requests(lambda *_: True)
    assert recovered == [generation.read_request(request["request_id"]).job_id]
    job = jobs.read_job(recovered[0])
    generation.claim_execution(job, lambda *_: True)
    assert generation.recover_requests(lambda *_: True) == []
    assert generation.read_request(request["request_id"]).execution_state == "needs_review"
    with pytest.raises(ws.WorkshopError) as error:
        generation.claim_execution(job, lambda *_: True)
    assert error.value.code == "EXECUTION_NEEDS_REVIEW"


def test_forged_approved_job_cannot_bypass_approval(setup):
    approved = approve(setup, prepare(setup))
    saved = jobs.read_job(approved["job_id"])
    jobs.save_job(saved.model_copy(update={"prompt": "changed after approval"}))
    with pytest.raises(JobRunnerError):
        run_job(saved.job_id)


@pytest.mark.parametrize("params", [
    {"type": "image", "confirmed": True}, {"type": "image", "provider_task_ids": ["paid"]},
    {"type": "image", "reference_images": ["/etc/passwd"]},
    {"type": "image", "n": "2"}, {"type": "image", "n": True},
    {"type": "video"},
])
def test_external_parameter_schema_rejects_unsafe_fields(setup, params):
    with pytest.raises(ValidationError):
        PrepareGenerationInput(target=setup.target, prompt="x", alias="fake", model="gpt-image-1",
                                params=params, idempotency_key="schema-reject")


def test_symlink_document_and_reference_are_denied(setup, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("do not disclose", encoding="utf-8")
    style = setup.root / "projects" / setup.project.slug / "style.md"
    try:
        style.symlink_to(outside)
    except OSError:
        pytest.skip("symbolic links unavailable on this test host")
    with pytest.raises(ws.WorkshopError):
        ws.read_document(setup.agent, ReadDocumentInput(target=setup.target, kind="project_style"))


def test_project_and_empty_ui_scheme_documents_are_discoverable(setup):
    listed = ws.list_targets(setup.agent, ListTargetsInput(project_id=setup.project.id))
    assert {row["target"]["type"] for row in listed["targets"]} == {"character", "ui_scheme"}
    project_target = {"type": "project", "project_id": setup.project.id}
    context = ws.get_context(setup.agent, TargetInput(target=project_target))
    assert {row["kind"] for row in context["documents"]} >= {"gdd", "prd", "interaction"}
    read = ws.read_document(setup.agent, ReadDocumentInput(target=project_target, kind="gdd"))
    written = ws.write_document(setup.agent, WriteDocumentInput(
        target=project_target, kind="gdd", expected_revision=read["revision"],
        content="# GDD\n战斗循环", idempotency_key="write-project-gdd"))
    assert written["content"] == "# GDD\n战斗循环"
    for target in [project_target, {"type": "ui_scheme", "project_id": setup.project.id, "ui_scheme_id": "v1"}]:
        with pytest.raises(ValidationError):
            PrepareGenerationInput(target=target, prompt="x", alias="fake", model="gpt-image-1",
                                    params={"type": "image"}, idempotency_key="not-generatable")


def test_ui_scheme_creation_survives_operation_ledger_interruption(setup, monkeypatch):
    payload = CreateTargetInput(project_id=setup.project.id, type="ui_scheme", name="新方案",
                                idempotency_key="create-ui-scheme")
    original = ws.atomic_write_json
    def crash(path, value):
        if path.parent.name == "operations" and "result" in value:
            raise OSError("lost response after scheme commit")
        return original(path, value)
    monkeypatch.setattr(ws, "atomic_write_json", crash)
    with pytest.raises(OSError):
        ws.create_target(setup.agent, payload)
    monkeypatch.setattr(ws, "atomic_write_json", original)
    restored = ws.create_target(setup.agent, payload)
    from character_workflow.lib.ui_schemes import read_schemes
    assert restored["target"]["ui_scheme_id"] == "v2" and len(read_schemes(setup.project.id).schemes) == 2


def test_local_http_prepare_approve_executes_fake_provider_and_emits_events(setup, monkeypatch):
    import character_workflow.lib.job_runner as runner
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app
    from viewer_server.sse import hub
    events = []
    monkeypatch.setattr(hub, "broadcast", lambda event, payload: events.append((event, payload)))
    calls = []
    def dispatch(**kwargs):
        calls.append(kwargs)
        return fake_image(**kwargs)
    monkeypatch.setattr(runner, "dispatch", dispatch)
    app = build_app()
    client = LocalTestClient(base_url="http://127.0.0.1", app=app)
    result = client.post("/api/workshop/prepare-generation", json={
        "target": setup.target, "prompt": "本地回归", "alias": "fake", "model": "gpt-image-1",
        "params": {"type": "image"}, "idempotency_key": "http-prepare-one"})
    assert result.status_code == 200, result.json()
    prepared = result.json()
    assert not calls and not jobs.list_jobs()
    assert client.get("/api/workshop/requests").json()["requests"][0]["request_id"] == prepared["request_id"]
    approval = client.post(f"/api/workshop/requests/{prepared['request_id']}/approve",
                            json={"expected_revision": 1})
    assert approval.status_code == 200, approval.json()
    app.state.workshop_runtime.executor.shutdown(wait=True)
    result = client.post("/api/workshop/get-generation", json={"request_id": prepared["request_id"]}).json()
    assert result["job"]["status"] == "done" and len(calls) == 1
    assert sum(event == "workshop-request-changed" for event, _ in events) >= 2
    app.state.workshop_runtime.close()
    client.close()


def test_web_and_mcp_spec_writes_share_revision_lock(setup):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    old = client.get("/api/spec/bird").json()
    document = ws.read_document(setup.agent, ReadDocumentInput(target=setup.target, kind="character_spec"))
    assert document["revision"] == old["revision"]
    ws.write_document(setup.agent, WriteDocumentInput(target=setup.target, kind="character_spec",
        expected_revision=old["revision"], content="# Agent新内容", idempotency_key="agent-spec-change"))
    response = client.post("/api/spec/bird", json={"content": "浏览器旧内容", "expected_revision": old["revision"]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "DOCUMENT_CONFLICT"
    assert client.get("/api/spec/bird").json()["content"] == "# Agent新内容"
    client.close()


def test_changed_approved_config_stops_job_instead_of_leaving_spinner(setup):
    approved = approve(setup, prepare(setup))
    keys.patch_key("fake", {"access_key": "another-test-only"})
    with pytest.raises(JobRunnerError):
        run_job(approved["job_id"], workshop_grant_is_active=lambda *_: True)
    result = generation.get_generation(setup.agent, GetGenerationInput(request_id=approved["request_id"]))
    assert result["job"]["status"] == "failed" and result["execution_state"] == "needs_review"


def test_request_watcher_handles_atomic_move_without_exposing_snapshot_paths(monkeypatch):
    from viewer_server.sse import hub
    from viewer_server.watcher import WorkshopRequestsHandler
    from watchdog.events import FileMovedEvent
    events = []
    monkeypatch.setattr(hub, "broadcast", lambda event, data: events.append((event, data)))
    WorkshopRequestsHandler().on_moved(FileMovedEvent("/private/tmp.json.tmp", "/private/wr-abc.json"))
    assert events == [("workshop-request-changed", {"request_id": "wr-abc"})]


def test_approval_retry_completes_missing_job_without_another_order(setup, monkeypatch):
    request = prepare(setup)
    original = generation.save_job
    monkeypatch.setattr(generation, "save_job", lambda _: (_ for _ in ()).throw(OSError("crash")))
    with pytest.raises(OSError):
        approve(setup, request)
    monkeypatch.setattr(generation, "save_job", original)
    result = approve(setup, request)
    assert result["job"]["status"] == "pending"
    assert len(jobs.list_jobs()) == 1


@pytest.mark.parametrize("callback", [None, lambda *_: False])
def test_revoked_or_unverifiable_grant_cannot_dispatch_after_approval(setup, monkeypatch, callback):
    import character_workflow.lib.job_runner as runner
    calls = []
    monkeypatch.setattr(runner, "dispatch", lambda **kwargs: calls.append(kwargs))
    result = approve(setup, prepare(setup))
    with pytest.raises(JobRunnerError):
        run_job(result["job_id"], workshop_grant_is_active=callback)
    assert calls == [] and jobs.read_job(result["job_id"]).status == JobStatus.FAILED
    assert generation.read_request(result["request_id"]).execution_state == "needs_review"


def test_recovery_stops_requests_from_revoked_grants(setup):
    result = approve(setup, prepare(setup))
    assert generation.recover_requests(lambda *_: False) == []
    assert jobs.read_job(result["job_id"]).status == JobStatus.FAILED


def test_agent_generation_status_does_not_disclose_raw_provider_error(setup):
    approved = approve(setup, prepare(setup))
    raw = "/private/user/failure.png upstream Authorization: Bearer dangerous-token"
    jobs.update_job_status(approved["job_id"], status=JobStatus.FAILED, error=raw)
    payload = GetGenerationInput(request_id=approved["request_id"])
    assert generation.get_generation(setup.local, payload)["job"]["error"] == raw
    serialized = json.dumps(generation.get_generation(setup.agent, payload))
    assert "dangerous-token" not in serialized and "/private/user" not in serialized


def test_local_approval_deep_link_and_preview_use_frozen_reference(setup):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app
    source = setup.root / "characters" / "bird" / "source" / "source.png"
    source.parent.mkdir(exist_ok=True)
    Image.new("RGB", (8, 8), "yellow").save(source)
    original = source.read_bytes()
    media_id = ws.list_media(setup.agent, ListMediaInput(target=setup.target))["media"][0]["media_id"]
    prepared = prepare(setup, media_ids=[media_id])
    Image.new("RGB", (8, 8), "blue").save(source)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    base = f"/api/workshop/requests/{prepared['request_id']}"
    response = client.get(base)
    assert response.status_code == 200 and response.json()["request_id"] == prepared["request_id"]
    preview = client.get(f"{base}/references/{media_id}")
    assert preview.status_code == 200 and preview.content == original
    assert preview.headers["content-type"] == "image/png"
    assert client.get(f"{base}/references/m-wrong").status_code == 404
    with pytest.raises(ws.WorkshopError):
        generation.frozen_reference(setup.agent, prepared["request_id"], media_id)
    client.close()


def test_truncated_document_cannot_be_written_back_as_if_complete(setup):
    path = setup.root / "characters" / "bird" / "spec.md"
    path.write_text("x" * 200001, encoding="utf-8")
    current = ws.document_view(path, "character_spec")
    assert current["truncated"]
    with pytest.raises(ws.WorkshopError) as error:
        ws.write_document_content(path, "character_spec", current["revision"], current["content"])
    assert error.value.code == "CONTENT_TOO_LARGE" and len(path.read_text()) == 200001


def test_model_capabilities_only_report_verified_constraints(setup):
    image = generation.list_models(setup.agent, TargetInput(target=setup.target))["models"][0]
    assert image["capabilities"]["quality"] == ["auto", "low", "medium", "high"]
    assert image["capabilities"]["ratio"] is None and image["capabilities"]["size"] is None
    created = ws.create_target(setup.agent, CreateTargetInput(project_id=setup.project.id,
        type="video", name="视频", idempotency_key="video-capabilities"))
    video = generation.list_models(setup.agent, TargetInput(target=created["target"]))["models"][0]
    assert video["capabilities"]["duration"] == {"min": 4, "max": 15}
    assert video["reference_limits"] == {"image": 9, "video": 3, "audio": 3}


@pytest.mark.parametrize("operation", ["document", "feedback"])
def test_document_and_feedback_retries_survive_lost_operation_receipt(setup, monkeypatch, operation):
    if operation == "document":
        current = ws.read_document(setup.agent, ReadDocumentInput(target=setup.target, kind="character_spec"))
        payload = WriteDocumentInput(target=setup.target, kind="character_spec", content="# 新内容",
                                     expected_revision=current["revision"], idempotency_key="lost-doc-receipt")
        perform = ws.write_document
    else:
        drafts = setup.root / ".runtime" / "draft"
        drafts.mkdir(exist_ok=True)
        (drafts / "feedback.md").write_text("<!-- character: bird -->\n已处理反馈", encoding="utf-8")
        feedback = ws.get_context(setup.agent, TargetInput(target=setup.target))["feedback"]
        payload = AcknowledgeFeedbackInput(target=setup.target,
            feedback_ids=[feedback[0]["feedback_id"]], idempotency_key="lost-feedback-receipt")
        perform = ws.acknowledge_feedback
    original = ws.atomic_write_json
    def lose_receipt(path, value):
        if "result" in value:
            raise OSError("lost receipt")
        return original(path, value)
    monkeypatch.setattr(ws, "atomic_write_json", lose_receipt)
    with pytest.raises(OSError):
        perform(setup.agent, payload)
    monkeypatch.setattr(ws, "atomic_write_json", original)
    recovered = perform(setup.agent, payload)
    assert perform(setup.agent, payload) == recovered
    if operation == "document":
        assert recovered["content"] == "# 新内容"
    else:
        assert recovered["acknowledged_ids"] == payload.feedback_ids
        assert list(drafts.glob("*.md")) == []


def test_formally_selected_project_image_is_available_to_video_request(setup, monkeypatch):
    from character_workflow.lib import video_jobs
    import character_workflow.lib.job_runner as runner
    monkeypatch.setattr(runner, "dispatch", fake_image)
    generated = approve(setup, prepare(setup))
    image = run_job(generated["job_id"], workshop_grant_is_active=lambda *_: True)
    target = ws.create_target(setup.agent, CreateTargetInput(project_id=setup.project.id, type="video",
        name="小鸟视频", idempotency_key="video-image-reference"))["target"]
    relative = Path(image.output_paths[0]).relative_to(setup.root).as_posix()
    video_jobs.set_references(setup.project.id, target["production_id"], [relative])
    media = ws.list_media(setup.agent, ListMediaInput(target=target))["media"]
    assert len(media) == 1 and media[0]["kind"] == "image"
    prepared = prepare(setup, target=target, model="seedance-2-0", params={"type": "video"},
                       media_ids=[media[0]["media_id"]])
    assert prepared["references"][0]["media_id"] == media[0]["media_id"]


@pytest.mark.parametrize("first_writer", ["agent", "rename"])
@pytest.mark.parametrize("frontmatter", [False, True])
def test_web_rename_and_mcp_spec_save_share_latest_document_lock(setup, monkeypatch, first_writer, frontmatter):
    from contextlib import contextmanager
    from threading import Event
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    spec = setup.root / "characters" / "bird" / "spec.md"
    heading = "---\nname: 小鸟\n---" if frontmatter else "# 小鸟"
    spec.write_text(heading + "\n\n原内容", encoding="utf-8")
    original = ws.document_view(spec, "character_spec")
    payload = WriteDocumentInput(target=setup.target, kind="character_spec",
        content=heading + "\n\nAgent新增内容", expected_revision=original["revision"],
        idempotency_key="rename-concurrent-agent")
    entered_write = Event()
    release_write = Event()
    second_lock_attempt = Event()
    original_atomic = ws.atomic_write_text
    original_lock = ws.document_lock

    def controlled_write(path, content, *args, **kwargs):
        if path == spec and not entered_write.is_set():
            entered_write.set()
            assert release_write.wait(5), "test did not release document commit"
        return original_atomic(path, content, *args, **kwargs)

    @contextmanager
    def observed_lock(path):
        if path == spec and entered_write.is_set() and not release_write.is_set():
            second_lock_attempt.set()
        with original_lock(path):
            yield

    monkeypatch.setattr(ws, "atomic_write_text", controlled_write)
    monkeypatch.setattr(routes, "atomic_write_text", controlled_write)
    monkeypatch.setattr(ws, "document_lock", observed_lock)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    actions = {
        "agent": lambda: ws.write_document(setup.agent, payload),
        "rename": lambda: client.post("/api/characters/bird/rename", json={"name": "新名字"}),
    }
    second_writer = "rename" if first_writer == "agent" else "agent"
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(actions[first_writer])
            try:
                assert entered_write.wait(5)
                second = pool.submit(actions[second_writer])
                assert second_lock_attempt.wait(5), "rename did not use the common document lock"
            finally:
                release_write.set()
            first_result = first.result(timeout=5)
            if first_writer == "agent":
                assert second.result(timeout=5).status_code == 200
                assert "Agent新增内容" in spec.read_text(encoding="utf-8")
            else:
                assert first_result.status_code == 200
                with pytest.raises(ws.WorkshopError) as error:
                    second.result(timeout=5)
                assert error.value.code == "DOCUMENT_CONFLICT"
                assert "原内容" in spec.read_text(encoding="utf-8")
        current = spec.read_text(encoding="utf-8")
        assert ("name: 新名字" if frontmatter else "# 新名字") in current
    finally:
        client.close()


@pytest.mark.parametrize("kind,name", [("ui_screen", "背包"), ("video", "小鸟的开场视频")])
def test_target_discovery_and_approval_show_human_names_with_stable_ids(setup, kind, name):
    payload = {"project_id": setup.project.id, "type": kind, "name": name,
               "idempotency_key": "human-readable-target"}
    if kind == "ui_screen":
        payload["ui_scheme_id"] = "v1"
    target = ws.create_target(setup.agent, CreateTargetInput(**payload))["target"]
    listed = ws.list_targets(setup.agent, ListTargetsInput(project_id=setup.project.id))["targets"]
    row = next(item for item in listed if item["target"] == target)
    assert row["name"] == ("V1 · 背包" if kind == "ui_screen" else name)
    assert target.get("screen_id", target.get("production_id")).startswith("w-")
    options = ({"model": "seedance-2-0", "params": {"type": "video"}}
               if kind == "video" else {})
    request = prepare(setup, target=target, **options)
    assert request["target_name"] == name and request["target"] == target
    assert generation.read_request(request["request_id"]).target_name == name


def test_character_frontmatter_name_is_used_and_request_name_remains_frozen(setup):
    spec = setup.root / "characters" / "bird" / "spec.md"
    spec.write_text('---\nname: "金色小鸟"\n---\n\n# 不作为名称的标题\n原内容', encoding="utf-8")
    listed = ws.list_targets(setup.agent, ListTargetsInput(project_id=setup.project.id))["targets"]
    assert next(item for item in listed if item["target"]["type"] == "character")["name"] == "金色小鸟"
    request = prepare(setup)
    assert request["target_name"] == "金色小鸟"
    spec.write_text("# 改名后的鸟\n新内容", encoding="utf-8")
    assert prepare(setup)["target_name"] == "金色小鸟"
    spec.unlink()
    history = generation.list_requests(setup.local)["requests"]
    assert history[0]["target_name"] == "金色小鸟"
    record = generation.read_request(request["request_id"])
    assert generation.request_view(record.model_copy(update={"target_name": ""}))["target_name"] == "bird"


@pytest.mark.parametrize("failure", ["missing", "invalid_utf8", "oversized", "symlink"])
def test_display_name_fails_safely_without_affecting_target_identity(setup, tmp_path, failure):
    path = setup.root / "name.md"
    if failure == "invalid_utf8":
        path.write_bytes(b"\xff\xff")
    elif failure == "oversized":
        path.write_text("# 不应读取\n" + "x" * 800001, encoding="utf-8")
    elif failure == "symlink":
        outside = tmp_path / "outside-title.md"
        outside.write_text("# 外部私有标题", encoding="utf-8")
        path.symlink_to(outside)
    assert ws.document_display_name(path, "stable-id") == "stable-id"


def test_agent_with_execute_capability_approves_own_request_and_is_recorded(setup):
    request = prepare(setup)
    result = generation.approve_generation(setup.agent, request["request_id"], 1, lambda *_: True)
    assert result["state"] == "approved"
    saved = generation.read_request(request["request_id"])
    assert saved.approved_by == "grant-one"
    assert jobs.read_job(result["job_id"]).status == JobStatus.PENDING
    other = SimpleNamespace(kind="agent", session_id="s2", grant_id="grant-two",
                            project_ids=setup.agent.project_ids, capabilities=setup.agent.capabilities)
    with pytest.raises(ws.WorkshopError):
        generation.approve_generation(other, request["request_id"], 2, lambda *_: True)


def test_corrupt_request_file_is_skipped_by_list_and_recovery(setup):
    request = prepare(setup)
    requests_dir = ws.root() / "requests"
    (requests_dir / "wr-broken.json").write_text("{not json", encoding="utf-8")
    (requests_dir / "wr-oldschema.json").write_text(json.dumps({"request_id": "wr-oldschema"}),
                                                    encoding="utf-8")
    assert generation.recover_requests(lambda *_: True) == []
    listed = generation.list_requests(setup.local)["requests"]
    assert [item["request_id"] for item in listed] == [request["request_id"]]
