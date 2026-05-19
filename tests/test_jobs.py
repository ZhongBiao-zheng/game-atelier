import pytest

from skill.character_workflow.lib.jobs import (
    write_job, update_job_status, read_job,
)
from skill.character_workflow.lib.schemas import JobStatus


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    return runtime


def test_write_default_is_pending_confirm(runtime):
    job = write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={"size": "1024x1024"}, seed=42,
    )
    assert job.status == JobStatus.PENDING_CONFIRM
    assert (runtime / "jobs" / "job-001.json").exists()


def test_write_with_explicit_pending(runtime):
    job = write_job(
        job_id="job-002", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
        status=JobStatus.PENDING,
    )
    assert job.status == JobStatus.PENDING


def test_update_status_to_done(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
    )
    updated = update_job_status(
        "job-001", status=JobStatus.DONE,
        output_paths=["/tmp/a.png", "/tmp/b.png"],
    )
    assert updated.status == JobStatus.DONE
    assert updated.output_paths == ["/tmp/a.png", "/tmp/b.png"]


def test_update_status_to_failed_records_error(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
    )
    updated = update_job_status("job-001", status=JobStatus.FAILED, error="API timeout")
    assert updated.status == JobStatus.FAILED
    assert updated.error == "API timeout"


def test_read_returns_full_job(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
    )
    job = read_job("job-001")
    assert job.job_id == "job-001"
    assert job.status == JobStatus.PENDING_CONFIRM
