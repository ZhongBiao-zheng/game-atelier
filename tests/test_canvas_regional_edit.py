import io
from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib import callers
from character_workflow.lib.canvas_image_edits import preview_regional_edit
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.canvas_runs import (
    resume_regional_edit_run, run_canvas_job, submit_mask_edit_run,
)
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import CanvasImageEditOptions, JobStatus
from tests.test_canvas_image_edits import setup_source


def selection():
    image = Image.new("L", (1024, 1024), 255)
    image.paste(0, (100, 100, 120, 120))
    image.paste(0, (800, 800, 820, 820))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def prepare(count=1):
    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(source_version_id=version.version_id, feather=8)
    preview = preview_regional_edit(pid, "source", "openai", "gpt-image-1", selection(), options)
    options.plan_id = preview["plan_id"]
    job, saved = submit_mask_edit_run(pid, "source", doc.revision, count, selection(), options)
    return pid, version, job, saved, preview


def test_preview_freezes_plan_and_rejects_stale_settings_before_provider_call(isolated_data_root):
    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(source_version_id=version.version_id, feather=8)
    preview = preview_regional_edit(pid, "source", "openai", "gpt-image-1", selection(), options)
    assert len(preview["regions"]) == 2
    assert preview["regions"][0]["preview"].startswith("data:image/png;base64,")
    options.plan_id = preview["plan_id"]
    options.feather = 16
    with pytest.raises(ValueError, match="规划"):
        submit_mask_edit_run(pid, "source", doc.revision, 1, selection(), options)


def test_regions_times_candidates_no_cartesian_explosion_and_one_result_node(isolated_data_root, monkeypatch):
    pid, source, job, _doc, preview = prepare(count=2)
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        assert kwargs["n"] == 1
        assert kwargs["params"]["n"] == 1
        assert kwargs["params"]["reference_images"][0] != job.params.reference_images[0]
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    result = run_canvas_job(job.job_id)
    assert result.status == JobStatus.DONE
    assert len(calls) == len(preview["regions"]) * 2 == 4
    assert len(result.output_paths) == 2
    assert len(read_canvas_document(pid).nodes) == 2
    assert all(t["status"] == "succeeded" for t in result.params.regional_edit["tasks"])
    for path in result.output_paths:
        with Image.open(path) as output:
            assert output.getpixel((110, 110)) == (0, 0, 255, 255)
            assert output.getpixel((810, 810)) == (0, 0, 255, 255)
            assert output.getpixel((500, 500)) == (255, 0, 0, 255)
    assert read_canvas_document(pid).nodes[0].data.current_version_id == source.version_id


def test_partial_failure_keeps_patches_and_retries_only_failed_region(isolated_data_root, monkeypatch):
    pid, _source, job, _doc, _ = prepare()
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            raise ValueError("供应商拒绝这一区域")
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    result = run_canvas_job(job.job_id)
    assert result.status == JobStatus.PARTIAL
    tasks = result.params.regional_edit["tasks"]
    assert [t["status"] for t in tasks] == ["succeeded", "failed"]
    assert Path(tasks[0]["path"]).is_file()  # not inside the runner's deleted TemporaryDirectory
    with Image.open(result.output_paths[0]) as output:
        assert output.getpixel((110, 110)) == (0, 0, 255, 255)
        assert output.getpixel((810, 810)) == (255, 0, 0, 255)
    document = read_canvas_document(pid)
    resumed, _ = resume_regional_edit_run(pid, job.canvas_run.run_id, document.revision)
    assert resumed.job_id == job.job_id
    complete = run_canvas_job(job.job_id)
    assert complete.status == JobStatus.DONE
    assert len(calls) == 3
    assert read_job(job.job_id).params.regional_edit["tasks"][0]["path"] == tasks[0]["path"]


def test_unknown_submission_is_never_automatically_reposted(isolated_data_root, monkeypatch):
    import requests
    _pid, _source, job, _doc, _ = prepare()
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        raise requests.Timeout("response lost")
    monkeypatch.setattr(callers, "dispatch", generate)
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    latest = read_job(job.job_id)
    assert all(t["status"] == "uncertain" for t in latest.params.regional_edit["tasks"])
    run_canvas_job(job.job_id)
    assert len(calls) == 2
