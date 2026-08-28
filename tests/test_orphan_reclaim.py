"""孤儿 PENDING studio job 回收 — studio job 只在 viewer-server 进程内跑，
server 重启时还 pending 的必然已死；不回收 = 前端永久转圈 + 永久轮询。"""
from fastapi.testclient import TestClient

from character_workflow.lib import jobs as jobs_lib
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
from viewer_server.server_app import build_app


def _studio_job(job_id: str, status: JobStatus) -> Job:
    return Job(
        job_id=job_id, character_id="alias", prompt="p",
        submitted_at="2026-06-10T10:00:00Z", model="m",
        params=JobParams(), output_paths=[],
        status=status, error=None, kind="video", namespace="studio",
    )


def test_fail_orphan_studio_jobs_only_touches_pending_studio(isolated_data_root):
    jobs_lib.save_job(_studio_job("studio-pending", JobStatus.PENDING))
    jobs_lib.save_job(_studio_job("studio-done", JobStatus.DONE))
    # character job 由独立 Skill 进程跑，server 重启不代表它死了 —— 不能动。
    jobs_lib.write_job(
        job_id="char-pending", character_id="c1", prompt="p",
        model="m", params={}, status=JobStatus.PENDING,
    )

    reclaimed = jobs_lib.fail_orphan_studio_jobs()

    assert reclaimed == ["studio-pending"]
    orphan = jobs_lib.read_job("studio-pending")
    assert orphan.status == JobStatus.FAILED
    assert "interrupted" in (orphan.error or "")
    assert jobs_lib.read_job("studio-done").status == JobStatus.DONE
    assert jobs_lib.read_job("char-pending").status == JobStatus.PENDING


def test_recoverable_tuzi_async_job_is_resumed_instead_of_failed(isolated_data_root):
    resumable = _studio_job("studio-tuzi", JobStatus.PENDING).model_copy(update={
        "kind": JobKind.IMAGE,
        "params": JobParams(
            provider_task_protocol="tuzi_async",
            provider_task_ids=["async-1"],
        ),
    })
    jobs_lib.save_job(resumable)

    reclaimed = jobs_lib.fail_orphan_studio_jobs()

    assert reclaimed == []
    assert jobs_lib.resumable_studio_jobs() == ["studio-tuzi"]
    assert jobs_lib.read_job("studio-tuzi").status == JobStatus.PENDING


def test_lifespan_resumes_tuzi_async_job_on_startup(isolated_data_root, monkeypatch):
    from threading import Event

    from viewer_server import routes

    resumed = Event()
    resumable = _studio_job("studio-tuzi", JobStatus.PENDING).model_copy(update={
        "kind": JobKind.IMAGE,
        "params": JobParams(
            provider_task_protocol="tuzi_async",
            provider_task_ids=["async-1"],
        ),
    })
    jobs_lib.save_job(resumable)
    async def fake_resume(job_id: str) -> None:
        if job_id == "studio-tuzi":
            resumed.set()

    monkeypatch.setattr(routes, "_run_studio_job_safely", fake_resume)

    with TestClient(build_app()):
        assert resumed.wait(1)


def test_lifespan_reclaims_orphans_on_startup(isolated_data_root):
    """server 启动（lifespan 进入）即回收，不等任何请求。"""
    jobs_lib.save_job(_studio_job("studio-orphan", JobStatus.PENDING))
    with TestClient(build_app()):
        assert jobs_lib.read_job("studio-orphan").status == JobStatus.FAILED
