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


def prepare(count=1, replacement=False):
    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(source_version_id=version.version_id, feather=8)
    if replacement:
        from tests.test_generation_recipe import _save_nodes
        extra = doc.nodes[0].model_dump(mode="json")
        extra["id"] = "replacement"
        doc = _save_nodes(pid, [doc.nodes[0].model_dump(mode="json"), extra], [],
                          {k: v.model_dump(mode="json") for k, v in doc.content_versions.items()})
        options.reference_node_id = "replacement"
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
    from character_workflow.lib.canvas_projects import resolve_canvas_media
    old_version = result.canvas_run.candidates[0].version_id
    resumed, _ = resume_regional_edit_run(pid, job.canvas_run.run_id, document.revision)
    assert resumed.job_id == job.job_id
    assert resolve_canvas_media(pid, old_version)[0].is_file()
    complete = run_canvas_job(job.job_id)
    assert complete.status == JobStatus.DONE
    assert len(calls) == 3
    assert read_job(job.job_id).params.regional_edit["tasks"][0]["path"] == tasks[0]["path"]
    assert resolve_canvas_media(pid, old_version)[0].is_file()


def test_raw_output_dimensions_are_validated_before_resizing(isolated_data_root, monkeypatch):
    _pid, _source, job, _doc, _ = prepare()
    def generate(**kwargs):
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (16, 16), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    tasks = read_job(job.job_id).params.regional_edit["tasks"]
    assert all(t["status"] == "failed" and t["actual_size"] == [16, 16] for t in tasks)


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


def test_completed_patches_resume_after_composition_crash_without_new_calls(isolated_data_root, monkeypatch):
    from character_workflow.lib.callers import regional_edit
    pid, _source, job, _doc, _ = prepare()
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    stitch = regional_edit.stitch_regions
    monkeypatch.setattr(regional_edit, "stitch_regions", lambda *_: (_ for _ in ()).throw(OSError("disk error")))
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    assert all(t["status"] == "succeeded" for t in read_job(job.job_id).params.regional_edit["tasks"])
    monkeypatch.setattr(regional_edit, "stitch_regions", stitch)
    resume_regional_edit_run(pid, job.canvas_run.run_id, read_canvas_document(pid).revision)
    assert run_canvas_job(job.job_id).status == JobStatus.DONE
    assert len(calls) == 2


def test_region_jobs_cannot_bypass_resume_via_generic_retry(isolated_data_root, monkeypatch):
    from character_workflow.lib.jobs import clone_job_for_retry
    _pid, _source, job, _doc, _ = prepare()
    monkeypatch.setattr(callers, "dispatch", lambda **_: (_ for _ in ()).throw(ValueError("rejected")))
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    with pytest.raises(ValueError, match="区域"):
        clone_job_for_retry(job.job_id)


def test_known_order_resumes_query_and_unknown_provider_errors_do_not_repost(isolated_data_root, monkeypatch):
    from character_workflow.lib.callers.tuzi_async import TASK_PROTOCOL, TuziAsyncPendingError
    pid, _source, job, _doc, _ = prepare()
    submitted = []
    def generate(**kwargs):
        request = kwargs["params"]
        if not request.get("provider_task_ids"):
            submitted.append(True)
            request.update(provider_task_ids=["accepted"], provider_task_protocol=TASK_PROTOCOL)
            kwargs["on_params_changed"]()
            raise TuziAsyncPendingError("query paused")
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    resume_regional_edit_run(pid, job.canvas_run.run_id, read_canvas_document(pid).revision)
    assert run_canvas_job(job.job_id).status == JobStatus.DONE
    assert len(submitted) == 2


def test_unclassified_provider_error_is_uncertain(isolated_data_root, monkeypatch):
    from character_workflow.lib.callers.openai_image import OpenAIImageError
    _pid, _source, job, _doc, _ = prepare()
    monkeypatch.setattr(callers, "dispatch", lambda **_: (_ for _ in ()).throw(OpenAIImageError("invalid response")))
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    assert all(t["status"] == "uncertain" for t in read_job(job.job_id).params.regional_edit["tasks"])


def test_package_roundtrip_preserves_patches_and_historical_results(isolated_data_root, monkeypatch):
    from character_workflow.lib.canvas_packages import export_canvas_projects, inspect_canvas_package, commit_canvas_package
    from character_workflow.lib.canvas_projects import resolve_canvas_media
    from character_workflow.lib.jobs import list_jobs
    pid, _source, job, _doc, _ = prepare(replacement=True)
    calls = []
    def generate(**kwargs):
        assert len(kwargs["params"]["reference_images"]) == 2
        assert all(Path(p).is_file() for p in kwargs["params"]["reference_images"])
        calls.append(True)
        if len(calls) == 2:
            raise ValueError("rejected")
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    partial = run_canvas_job(job.job_id)
    path, _ = export_canvas_projects([pid])
    imported = commit_canvas_package(inspect_canvas_package(path).token)[0]
    restored = next(j for j in list_jobs() if j.canvas_project_id == imported.project_id)
    # Removing the original proves the new project is self-contained.
    Path(partial.params.regional_edit["tasks"][0]["path"]).unlink()
    resume_regional_edit_run(imported.project_id, restored.canvas_run.run_id,
                             read_canvas_document(imported.project_id).revision)
    complete = run_canvas_job(restored.job_id)
    assert complete.status == JobStatus.DONE
    assert len(calls) == 3
    versions = read_canvas_document(imported.project_id).content_versions
    results = [v for v in versions.values() if v.origin.kind == "job_output"]
    assert len(results) == 2
    for version in results:
        assert resolve_canvas_media(imported.project_id, version.version_id)[0].is_file()
    second, _ = export_canvas_projects([imported.project_id])
    assert inspect_canvas_package(second).projects


def test_repeat_resume_after_partial_result_and_compose_failure(isolated_data_root, monkeypatch):
    from character_workflow.lib.callers import regional_edit
    pid, _source, job, _doc, _ = prepare()
    calls = []
    def generate(**kwargs):
        calls.append(True)
        if len(calls) == 2:
            raise ValueError("rejected")
        path = kwargs["output_dir"] / "result.png"
        Image.new("RGBA", (1024, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    assert run_canvas_job(job.job_id).status == JobStatus.PARTIAL
    resume_regional_edit_run(pid, job.canvas_run.run_id, read_canvas_document(pid).revision)
    stitch = regional_edit.stitch_regions
    monkeypatch.setattr(regional_edit, "stitch_regions", lambda *_: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(Exception):
        run_canvas_job(job.job_id)
    monkeypatch.setattr(regional_edit, "stitch_regions", stitch)
    resume_regional_edit_run(pid, job.canvas_run.run_id, read_canvas_document(pid).revision)
    assert run_canvas_job(job.job_id).status == JobStatus.DONE
    assert len(calls) == 3


def test_region_task_state_rejects_untrusted_candidate_paths():
    from character_workflow.lib.regional_image_edit import validate_regional_tasks
    for candidate in ("/tmp/escape", "../../outside", -1, 4, True):
        with pytest.raises(ValueError, match="区域"):
            validate_regional_tasks({"tasks": [{"candidate": candidate, "region_id": "1", "status": "pending"}]}, ["1"], 1)


def test_package_validation_rejects_tampered_regional_candidate(isolated_data_root, monkeypatch):
    import json
    from character_workflow.lib import canvas_packages
    pid, _source, _job, _doc, _ = prepare()
    monkeypatch.setattr(callers, "dispatch", lambda **_: (_ for _ in ()).throw(ValueError("rejected")))
    with pytest.raises(Exception):
        run_canvas_job(_job.job_id)
    original = canvas_packages._portable_job
    def tamper(*args):
        data = json.loads(original(*args))
        data["params"]["regional_edit"]["tasks"][0]["candidate"] = "/tmp/escape"
        return json.dumps(data).encode()
    monkeypatch.setattr(canvas_packages, "_portable_job", tamper)
    with pytest.raises(canvas_packages.CanvasPackageError, match="区域"):
        path, _ = canvas_packages.export_canvas_projects([pid])
        canvas_packages.inspect_canvas_package(path)
