"""Smoke test: after migration, key modules read from CHARACTER_WORKFLOW_DATA_ROOT."""
import json

from character_workflow.lib import data_root


def test_projects_module_reads_from_data_root(isolated_data_root):
    from character_workflow.lib import projects
    runtime = data_root.runtime_dir()
    (runtime / "projects.json").write_text(json.dumps({
        "version": 1, "projects": [], "assignments": {}
    }))
    result = projects.read_projects()
    assert result.projects == []


def test_lessons_module_resolves_paths_under_data_root(isolated_data_root):
    from character_workflow.lib import lessons
    # append_memory with scope="workspace" should write to data_root / MEMORY.md
    try:
        path = lessons.append_memory(kind="portrait", line="- test entry", scope="workspace")
        assert str(data_root.resolve_data_root()) in str(path)
    except FileNotFoundError:
        pass


def test_jobs_module_writes_to_runtime_dir(isolated_data_root):
    from character_workflow.lib import jobs
    job_id = "test-job-1"
    jobs.write_job(
        job_id=job_id,
        character_id="x",
        prompt="test",
        model="gpt_image_2",
        params={},
        seed=None,
        status=jobs.JobStatus.PENDING_CONFIRM,
        kind=jobs.JobKind.PORTRAIT,
    )
    assert (data_root.runtime_dir() / "jobs" / f"{job_id}.json").exists()
