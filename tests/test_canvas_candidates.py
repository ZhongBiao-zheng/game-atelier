from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from threading import Barrier, Event
from types import SimpleNamespace

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
    run_canvas_job,
)
from character_workflow.lib.jobs import read_job, save_job, update_job_status
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


@pytest.mark.parametrize("assignments", [
    [("canvas-a", "key-a")] * 6,
    [("canvas-a", "key-a"), ("canvas-b", "key-a")] * 3,
    [("canvas-a", "key-a")] * 6 + [("canvas-b", "key-b")] * 6,
])
def test_video_jobs_execute_concurrently(monkeypatch, assignments):
    jobs = {
        f"video-{index}": SimpleNamespace(
            job_id=f"video-{index}", kind=JobKind.VIDEO, alias=alias,
            canvas_project_id=project_id,
        )
        for index, (project_id, alias) in enumerate(assignments)
    }
    all_running = Barrier(len(jobs))

    def execute(job_id):
        all_running.wait(timeout=5)
        return jobs[job_id]

    monkeypatch.setattr(canvas_runs, "read_job", jobs.__getitem__)
    monkeypatch.setattr(canvas_runs, "run_canvas_job", execute)
    monkeypatch.setattr(canvas_runs, "_RUN_PROJECT_GATES", {})
    monkeypatch.setattr(canvas_runs, "_RUN_ALIAS_GATES", {})
    with ThreadPoolExecutor(max_workers=len(jobs)) as executor:
        futures = [executor.submit(canvas_runs.run_canvas_job_scheduled, job_id) for job_id in jobs]
        results = [future.result(timeout=10) for future in futures]
    assert [(job.job_id, job.canvas_project_id) for job in results] == [
        (job_id, job.canvas_project_id) for job_id, job in jobs.items()
    ]


@pytest.mark.parametrize("shared", ["key", "project"])
def test_canvas_scheduler_queues_seventh_job_and_releases_slots(monkeypatch, shared):
    jobs = {
        str(index): SimpleNamespace(
            alias="key" if shared == "key" else f"key-{index}",
            canvas_project_id="canvas" if shared == "project" else f"canvas-{index}",
        )
        for index in range(7)
    }
    started = Barrier(7)
    release = Event()
    seventh_submitted = Event()

    def read(job_id):
        if job_id == "6":
            seventh_submitted.set()
        return jobs[job_id]

    def execute(job_id):
        if job_id != "6":
            started.wait(timeout=5)
            assert release.wait(timeout=5)
        return job_id

    monkeypatch.setattr(canvas_runs, "read_job", read)
    monkeypatch.setattr(canvas_runs, "run_canvas_job", execute)
    monkeypatch.setattr(canvas_runs, "_RUN_PROJECT_GATES", {})
    monkeypatch.setattr(canvas_runs, "_RUN_ALIAS_GATES", {})
    with ThreadPoolExecutor(max_workers=7) as executor:
        futures = [executor.submit(canvas_runs.run_canvas_job_scheduled, str(i)) for i in range(6)]
        try:
            started.wait(timeout=5)
            seventh = executor.submit(canvas_runs.run_canvas_job_scheduled, "6")
            assert seventh_submitted.wait(timeout=5)
            with pytest.raises(FutureTimeoutError):
                seventh.result(timeout=0.1)
        finally:
            release.set()
        assert [future.result(timeout=5) for future in futures] == list(map(str, range(6)))
        assert seventh.result(timeout=5) == "6"


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


def _project_with_result_node(
    *,
    primary_version_id: str | None,
    active_run_id: str,
    generation_draft: dict | None = None,
):
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
                "generation_draft": generation_draft,
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


def test_finalize_clears_active_run_id_on_success_and_failure():
    """active_run_id 只在 run 进行中非空（#96）：成功挂产物后清，失败没产物也要清并落一版文档。"""
    run_id = "run-release"
    project, _document, _primary = _project_with_result_node(primary_version_id=None, active_run_id=run_id)
    candidates = [CanvasResultCandidate(candidate_id="candidate-0", index=0, status="pending")]
    job = _job(project.project_id, run_id, candidates)
    output = _write_output(project.project_id, job.job_id)
    save_job(job.model_copy(update={"status": JobStatus.DONE, "output_paths": [output]}))

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.status == JobStatus.DONE
    result = next(node for node in document.nodes if node.id == "image-result")
    assert result.data.current_version_id == finalized.canvas_run.candidates[0].version_id
    assert result.data.active_run_id is None

    failed_run = "run-release-failed"
    project, before, _primary = _project_with_result_node(primary_version_id=None, active_run_id=failed_run)
    job = _job(project.project_id, failed_run, [
        CanvasResultCandidate(candidate_id="candidate-0", index=0, status="pending"),
    ])
    save_job(job.model_copy(update={"status": JobStatus.FAILED, "error": "厂商 500"}))

    finalized, document = finalize_canvas_run(project.project_id, job.job_id)

    assert finalized.status == JobStatus.FAILED
    assert document is not None and document.revision == before.revision + 1
    result = next(node for node in document.nodes if node.id == "image-result")
    assert result.data.active_run_id is None
    assert read_canvas_document(project.project_id).revision == document.revision


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


@pytest.mark.parametrize("count,has_success", [(1, False), (3, False), (3, True)])
def test_tuzi_poll_abandon_settles_canvas_without_rebilling(monkeypatch, count, has_success):
    from character_workflow.lib import job_runner
    from character_workflow.lib.callers.tuzi_async import TuziAsyncPendingError

    run_id = "run-tuzi-poll-abandon"
    project, _, primary = _project_with_result_node(
        primary_version_id="existing" if has_success else None, active_run_id=run_id,
    )
    candidates = [CanvasResultCandidate(
        candidate_id=f"candidate-{i}", index=i,
        status="succeeded" if has_success and i == 0 else "pending",
        version_id=primary if has_success and i == 0 else None,
    ) for i in range(count)]
    job = _job(project.project_id, run_id, candidates)
    save_job(job)
    calls = []

    def dispatch(**kwargs):
        calls.append(1)
        kwargs["params"].update(provider_task_protocol="tuzi_images", provider_task_ids=["paid-1"])
        kwargs["on_params_changed"]()
        raise TuziAsyncPendingError("轮询超时（task_id=paid-1）")

    monkeypatch.setattr(job_runner, "dispatch", dispatch)
    result = run_canvas_job(job.job_id)
    assert calls == [1]
    assert result.status == (JobStatus.PARTIAL if has_success else JobStatus.FAILED)
    assert result.completed_at and result.progress_phase is None
    assert result.params.n == count
    assert result.params.provider_task_ids == ["paid-1"]
    assert result.params.provider_task_protocol == "tuzi_images"
    failed = [c for c in result.canvas_run.candidates if c.status == "failed"]
    assert len(failed) == count - int(has_success)
    assert all("paid-1" in c.error and "本地等待" in c.error for c in failed)
    assert "paid-1" in result.error and "本地等待" in result.error
    if has_success:
        assert result.canvas_run.candidates[0].version_id == primary
    assert read_job(job.job_id) == result
    document = read_canvas_document(project.project_id)
    assert read_canvas_document(project.project_id) == document
    assert read_job(job.job_id) == result
    assert calls == [1]


@pytest.mark.parametrize("errors,expected", [
    (["上游拒绝请求", "上游拒绝请求"], "上游拒绝请求"),
    (["上游拒绝请求", "下载失败"], "上游拒绝请求；下载失败"),
    ([None, "下载失败"], "下载失败"),
    ([None], "Canvas Job 没有可登记的结果"),
    ([], "Canvas Job 没有可登记的结果"),
])
def test_failed_candidate_aggregate_preserves_distinct_causes(errors, expected):
    candidates = [CanvasResultCandidate(
        candidate_id=f"candidate-{i}", index=i, status="failed", error=error,
    ) for i, error in enumerate(errors)]
    assert canvas_runs._candidate_aggregate(candidates) == (JobStatus.FAILED, expected)


def test_cancel_wins_when_canvas_poll_failure_is_settled():
    run_id = "run-cancel-at-poll-end"
    project, _, _ = _project_with_result_node(primary_version_id=None, active_run_id=run_id)
    job = _job(project.project_id, run_id, [CanvasResultCandidate(
        candidate_id="candidate-0", index=0, status="pending",
    )])
    save_job(job)
    request_canvas_run_cancel(project.project_id, run_id)
    result = canvas_runs._fail_pending_canvas_candidates(project.project_id, job.job_id, "超时")
    assert result.status == JobStatus.CANCELED
    assert result.canvas_run.candidates[0].status == "canceled"


def test_duplicate_incremental_runner_does_not_fail_owned_candidate(monkeypatch):
    run_id = "run-busy-incremental"
    project, _document, _primary = _project_with_result_node(
        primary_version_id=None,
        active_run_id=run_id,
    )
    candidate = CanvasResultCandidate(candidate_id="candidate-0", index=0, status="pending")
    job = _job(project.project_id, run_id, [candidate])
    save_job(job)
    monkeypatch.setattr(
        canvas_runs,
        "run_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            canvas_runs.JobExecutionBusy("already owned")
        ),
    )

    result = run_canvas_job(job.job_id)

    assert result.status == JobStatus.PENDING
    assert result.canvas_run.candidates[0].status == "pending"
    assert result.error is None


def test_duplicate_nonincremental_runner_does_not_finalize_owned_job(monkeypatch):
    run_id = "run-busy-text"
    project, _document, _primary = _project_with_result_node(
        primary_version_id=None,
        active_run_id=run_id,
    )
    candidate = CanvasResultCandidate(candidate_id="candidate-0", index=0, status="pending")
    job = _job(project.project_id, run_id, [candidate]).model_copy(update={"kind": JobKind.TEXT})
    save_job(job)
    monkeypatch.setattr(
        canvas_runs,
        "run_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            canvas_runs.JobExecutionBusy("already owned")
        ),
    )

    result = run_canvas_job(job.job_id)

    assert result.status == JobStatus.PENDING
    assert result.canvas_run.candidates[0].status == "pending"
    assert result.error is None


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


@pytest.mark.parametrize("status", [JobStatus.FAILED, JobStatus.CANCELED])
def test_run_recovery_proof_does_not_require_connections_or_outputs(status):
    project, document, _ = _project_with_result_node(
        primary_version_id=None, active_run_id="run-empty-terminal",
    )
    job = _job(project.project_id, "run-empty-terminal", [CanvasResultCandidate(
        candidate_id="empty-terminal", index=0,
        status="failed" if status == JobStatus.FAILED else "canceled",
    )]).model_copy(update={"status": status})
    save_job(job)
    assert not document.connections
    assert not document.content_versions
    assert canvas_runs._document_has_run(document, "run-empty-terminal", job.job_id)


def test_layer_stack_run_recovery_proof_uses_active_run_without_connections():
    from tests.test_canvas_layer_decomposition import _project_with_decomposition_node

    _project, document, _version = _project_with_decomposition_node()
    stack = next(node for node in document.nodes if node.type == "layer_stack")
    stack.data.active_run_id = "run-stack"
    document.connections = []
    assert canvas_runs._document_has_run(document, "run-stack", "job-stack")
