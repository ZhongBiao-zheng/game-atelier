"""Smoke test: after migration, key modules read from GAME_ATELIER_DATA_ROOT."""

from character_workflow.lib import data_root






def test_jobs_module_writes_to_runtime_dir(isolated_data_root):
    from character_workflow.lib import jobs
    job_id = "test-job-1"
    jobs.write_job(
        job_id=job_id,
        character_id="x",
        prompt="test",
        model="gpt_image_2",
        params={},
        status=jobs.JobStatus.PENDING_CONFIRM,
    )
    assert (data_root.runtime_dir() / "jobs" / f"{job_id}.json").exists()
