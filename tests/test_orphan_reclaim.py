"""孤儿 PENDING studio job 回收 — studio job 只在 viewer-server 进程内跑，
server 重启时还 pending 的必然已死；不回收 = 前端永久转圈 + 永久轮询。"""
from fastapi.testclient import TestClient

from character_workflow.lib import jobs as jobs_lib
from character_workflow.lib.schemas import Job, JobParams, JobStatus
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


def test_lifespan_reclaims_orphans_on_startup(isolated_data_root):
    """server 启动（lifespan 进入）即回收，不等任何请求。"""
    jobs_lib.save_job(_studio_job("studio-orphan", JobStatus.PENDING))
    with TestClient(build_app()):
        assert jobs_lib.read_job("studio-orphan").status == JobStatus.FAILED
