import pytest

from character_workflow.lib.jobs import (
    write_job, update_job_status, read_job,
)
from character_workflow.lib.schemas import JobStatus


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
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


def test_update_status_to_done_can_clear_old_error(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
    )
    update_job_status("job-001", status=JobStatus.FAILED, error="stale timeout")

    updated = update_job_status("job-001", status=JobStatus.DONE, error=None)

    assert updated.status == JobStatus.DONE
    assert updated.error is None


def test_read_returns_full_job(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={}, seed=None,
    )
    job = read_job("job-001")
    assert job.job_id == "job-001"
    assert job.status == JobStatus.PENDING_CONFIRM


def test_write_job_fills_alias_from_preferred_when_missing(runtime):
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="lov", provider="seedream", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    job = write_job(
        job_id="job-alias-auto", character_id="c1", prompt="p",
        model="m", params={}, seed=None,
    )
    assert job.alias == "lov"
    assert job.provider == "seedream"


def test_write_job_alias_null_when_no_key_matches(runtime):
    job = write_job(
        job_id="job-alias-none", character_id="c1", prompt="p",
        model="m", params={}, seed=None,
    )
    assert job.alias is None
    assert job.provider is None


def test_write_job_explicit_alias_overrides_default(runtime):
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="lov", provider="seedream", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.add_key(keys.KeySpec(
        alias="oa", provider="openai", access_key="x", secret_key=None,
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("lov")
    job = write_job(
        job_id="job-alias-explicit", character_id="c1", prompt="p",
        model="m", params={}, seed=None, alias="oa",
    )
    assert job.alias == "oa"
    assert job.provider == "openai"
