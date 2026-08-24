from __future__ import annotations

import base64

import pytest

from character_workflow.lib.canvas_projects import (
    canvas_output_dir,
    create_canvas_project,
    read_canvas_document,
    replace_canvas_node_media,
    save_canvas_document,
)
from character_workflow.lib import canvas_runs
from character_workflow.lib.canvas_runs import (
    dismiss_canvas_candidate,
    finalize_canvas_run,
    request_canvas_run_cancel,
    reconcile_canvas_jobs,
    retry_canvas_run,
    run_canvas_job,
)
from character_workflow.lib.jobs import read_job, save_job, update_job_status
from character_workflow.lib.keys import KeySpec, KeysDB, ModelSpec, write_keys_db
from character_workflow.lib.schemas import (
    CanvasActor,
    CanvasGenerationSnapshot,
    CanvasJobContext,
    CanvasResultCandidate,
    Job,
    JobKind,
    JobParams,
    JobStatus,
)


NOW = "2026-08-25T00:00:00+00:00"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _snapshot(result_node_id: str) -> CanvasGenerationSnapshot:
    return CanvasGenerationSnapshot(
        surface_node_id="config-one",
        result_node_id=result_node_id,
        mode="image",
        final_prompt="一只纸雕狐狸",
        input_policy="all_connected",
        model="gpt-image-1",
        provider="openai",
        alias="openai-main",
        normalized_params={"n": 1, "ratio": "1:1"},
        inputs=[],
        submitted_at=NOW,
        submitted_by=CanvasActor(kind="user"),
        request_fingerprint="a" * 64,
    )


def _project_with_result_node(*, primary_version_id: str | None, active_run_id: str):
    project = create_canvas_project("候选结果")
    current = read_canvas_document(project.project_id)
    payload = current.model_dump(mode="json")
    payload.update({
        "nodes": [{
            "id": "image-result",
            "title": "图片结果",
            "type": "image",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": None,
                "generation_draft": None,
                "active_run_id": active_run_id,
                "display": {"fit": "contain", "free_resize": False},
            },
        }],
        "content_versions": {},
    })
    document = type(current).model_validate(payload)
    saved = save_canvas_document(project.project_id, document, current.revision)
    if primary_version_id:
        version, saved, _filename = replace_canvas_node_media(
            project.project_id,
            "image-result",
            "existing.png",
            ".png",
            PNG,
            "image",
            saved.revision,
        )
        primary_version_id = version.version_id
    return project, saved, primary_version_id


def _job(project_id: str, run_id: str, candidates: list[CanvasResultCandidate]) -> Job:
    return Job(
        job_id=f"job-{run_id}",
        character_id="openai-main",
        prompt="一只纸雕狐狸",
        submitted_at=NOW,
        model="gpt-image-1",
        params=JobParams(n=len(candidates), ratio="1:1"),
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        kind=JobKind.IMAGE,
        namespace="canvas",
        canvas_project_id=project_id,
        canvas_run=CanvasJobContext(
            run_id=run_id,
            snapshot=_snapshot("image-result"),
            result_node_id="image-result",
            candidates=candidates,
        ),
        alias="openai-main",
        provider="openai",
    )


def _write_output(project_id: str, job_id: str, name: str = "candidate.png") -> str:
    target = canvas_output_dir(project_id, job_id) / name
    target.write_bytes(PNG)
    return str(target)


def test_single_candidate_retry_succeeds_without_stealing_existing_primary():
    run_id = "run-retry-one"
    project, _document, primary_version_id = _project_with_result_node(
        primary_version_id="version-existing",
        active_run_id=run_id,
    )
    candidate = CanvasResultCandidate(
        candidate_id="candidate-retry",
        index=1,
        status="pending",
        replaces_candidate_id="candidate-failed",
    )
    job = _job(project.project_id, run_id, [candidate])
    output = _write_output(project.project_id, job.job_id)
    save_job(job.model_copy(update={"status": JobStatus.DONE, "output_paths": [output]}))

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.canvas_run.candidates[0].status == "succeeded"
    assert finalized.canvas_run.candidates[0].version_id is not None
    assert document is not None
    result = next(node for node in document.nodes if node.id == "image-result")
    assert result.data.current_version_id == primary_version_id


def test_cancel_with_one_output_keeps_success_and_cancels_remaining_slots():
    run_id = "run-stop-partial"
    project, _document, _primary = _project_with_result_node(primary_version_id=None, active_run_id=run_id)
    candidates = [
        CanvasResultCandidate(candidate_id=f"candidate-{index}", index=index, status="pending")
        for index in range(3)
    ]
    job = _job(project.project_id, run_id, candidates)
    output = _write_output(project.project_id, job.job_id)
    save_job(job.model_copy(update={
        "status": JobStatus.DONE,
        "output_paths": [output],
        "cancel_requested_at": NOW,
    }))

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.status == JobStatus.PARTIAL
    assert [candidate.status for candidate in finalized.canvas_run.candidates] == [
        "succeeded",
        "canceled",
        "canceled",
    ]
    assert document is not None
    result = next(node for node in document.nodes if node.id == "image-result")
    assert result.data.current_version_id == finalized.canvas_run.candidates[0].version_id


def test_non_native_batch_commits_each_slot_before_starting_the_next(monkeypatch):
    run_id = "run-incremental"
    project, _document, _primary = _project_with_result_node(
        primary_version_id=None,
        active_run_id=run_id,
    )
    candidates = [
        CanvasResultCandidate(candidate_id=f"candidate-{index}", index=index, status="pending")
        for index in range(3)
    ]
    job = _job(project.project_id, run_id, candidates)
    save_job(job)
    observed_statuses: list[list[str]] = []

    def fake_run_job(job_id: str, *, defer_terminal: bool = False):
        current = read_job(job_id)
        observed_statuses.append([
            candidate.status for candidate in current.canvas_run.candidates
        ])
        assert defer_terminal is True
        assert current.params.n == 1
        index = len(observed_statuses) - 1
        output = _write_output(project.project_id, job_id, f"candidate-{index}.png")
        updated = update_job_status(
            job_id,
            status=JobStatus.PENDING,
            output_paths=[output],
            error=None,
        )
        if index == 1:
            request_canvas_run_cancel(project.project_id, run_id)
            updated = read_job(job_id)
        return updated

    monkeypatch.setattr(canvas_runs, "run_job", fake_run_job)

    finalized = run_canvas_job(job.job_id)

    assert observed_statuses == [
        ["pending", "pending", "pending"],
        ["succeeded", "pending", "pending"],
    ]
    assert finalized.status == JobStatus.PARTIAL
    assert finalized.params.n == 3
    assert len(finalized.output_paths) == 2
    assert [candidate.status for candidate in finalized.canvas_run.candidates] == [
        "succeeded",
        "succeeded",
        "canceled",
    ]
    document = read_canvas_document(project.project_id)
    assert len(document.content_versions) == 2
    result = next(node for node in document.nodes if node.id == "image-result")
    assert result.data.current_version_id == finalized.canvas_run.candidates[0].version_id


def test_text_batches_keep_the_existing_single_provider_request_path():
    job = _job("canvas-text-batch", "run-text-batch", [
        CanvasResultCandidate(candidate_id=f"candidate-{index}", index=index, status="pending")
        for index in range(2)
    ]).model_copy(update={"kind": JobKind.TEXT})

    assert canvas_runs._uses_incremental_candidates(job) is False


def test_restart_recovery_registers_paid_incremental_output_before_failing_unknown_slots():
    run_id = "run-recover-output"
    project, _document, _primary = _project_with_result_node(
        primary_version_id=None,
        active_run_id=run_id,
    )
    candidates = [
        CanvasResultCandidate(candidate_id=f"candidate-{index}", index=index, status="pending")
        for index in range(3)
    ]
    job = _job(project.project_id, run_id, candidates)
    output = _write_output(project.project_id, job.job_id)
    save_job(job.model_copy(update={
        "params": job.params.model_copy(update={"n": 1}),
        "output_paths": [output],
        "runner_started_at": NOW,
    }))

    reconciled = reconcile_canvas_jobs(fail_pending=True, project_id=project.project_id)

    assert reconciled == [job.job_id]
    recovered = read_job(job.job_id)
    assert recovered.status == JobStatus.PARTIAL
    assert recovered.params.n == 3
    assert [candidate.status for candidate in recovered.canvas_run.candidates] == [
        "succeeded",
        "failed",
        "failed",
    ]
    document = read_canvas_document(project.project_id)
    assert recovered.canvas_run.candidates[0].version_id in document.content_versions


def test_failed_candidate_can_be_hidden_without_deleting_provenance():
    run_id = "run-hide-failed"
    project, document, primary_version_id = _project_with_result_node(
        primary_version_id="version-existing",
        active_run_id=run_id,
    )
    candidates = [
        CanvasResultCandidate(
            candidate_id="candidate-success",
            index=0,
            status="succeeded",
            version_id=primary_version_id,
        ),
        CanvasResultCandidate(
            candidate_id="candidate-failed",
            index=1,
            status="failed",
            error="上游超时",
        ),
    ]
    job = _job(project.project_id, run_id, candidates).model_copy(update={
        "status": JobStatus.PARTIAL,
        "error": "部分候选没有生成成功",
    })
    save_job(job)

    updated_job, unchanged_document = dismiss_canvas_candidate(
        project.project_id,
        run_id,
        "candidate-failed",
        document.revision,
    )

    failed = updated_job.canvas_run.candidates[1]
    assert failed.dismissed_at is not None
    assert failed.status == "failed"
    assert failed.error == "上游超时"
    assert unchanged_document.revision == document.revision
    persisted = read_job(job.job_id)
    assert persisted.canvas_run.candidates[1].dismissed_at == failed.dismissed_at


@pytest.mark.parametrize("status", ["pending", "succeeded"])
def test_only_failed_or_canceled_candidate_can_be_hidden(status: str):
    run_id = f"run-no-hide-{status}"
    project, document, primary_version_id = _project_with_result_node(
        primary_version_id="version-existing",
        active_run_id=run_id,
    )
    candidate = CanvasResultCandidate(
        candidate_id="candidate-one",
        index=0,
        status=status,
        version_id=primary_version_id if status == "succeeded" else None,
    )
    save_job(_job(project.project_id, run_id, [candidate]))

    with pytest.raises(ValueError, match="只能隐藏失败或已停止的候选"):
        dismiss_canvas_candidate(
            project.project_id,
            run_id,
            candidate.candidate_id,
            document.revision,
        )


def test_successful_candidate_cannot_be_retried_as_a_single_slot():
    run_id = "run-no-retry-success"
    project, document, primary_version_id = _project_with_result_node(
        primary_version_id="version-existing",
        active_run_id=run_id,
    )
    candidate = CanvasResultCandidate(
        candidate_id="candidate-success",
        index=0,
        status="succeeded",
        version_id=primary_version_id,
    )
    save_job(_job(project.project_id, run_id, [candidate]).model_copy(update={
        "status": JobStatus.DONE,
    }))

    with pytest.raises(ValueError, match="只能单独重试失败或已停止的候选"):
        retry_canvas_run(
            project.project_id,
            run_id,
            "original",
            document.revision,
            candidate.candidate_id,
        )


def test_original_retry_reuses_the_frozen_prompt_model_and_parameters():
    run_id = "run-retry-frozen-snapshot"
    project, document, _primary = _project_with_result_node(
        primary_version_id=None,
        active_run_id=run_id,
    )
    write_keys_db(KeysDB(default_alias="openai-main", keys=[KeySpec(
        alias="openai-main",
        provider="openai",
        access_key="sk-test",
        models=[ModelSpec(name="GPT Image 1", id="gpt-image-1", modality="image")],
        created_at=NOW,
    )]))
    original = _job(project.project_id, run_id, [CanvasResultCandidate(
        candidate_id="candidate-failed",
        index=0,
        status="failed",
        error="network down",
    )]).model_copy(update={"status": JobStatus.FAILED, "error": "network down"})
    save_job(original)

    retry, updated_document = retry_canvas_run(
        project.project_id,
        run_id,
        "original",
        document.revision,
    )

    assert retry.retry_of == original.job_id
    assert retry.prompt == original.canvas_run.snapshot.final_prompt
    assert retry.model == original.canvas_run.snapshot.model
    assert retry.alias == original.canvas_run.snapshot.alias
    assert retry.provider == original.canvas_run.snapshot.provider
    assert retry.params.ratio == original.canvas_run.snapshot.normalized_params["ratio"]
    assert retry.canvas_run.snapshot.final_prompt == original.canvas_run.snapshot.final_prompt
    assert retry.canvas_run.snapshot.normalized_params == original.canvas_run.snapshot.normalized_params
    assert updated_document.revision == document.revision + 1
