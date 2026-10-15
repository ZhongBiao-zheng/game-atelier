import io

import pytest
from PIL import Image

from character_workflow.lib.canvas_projects import create_canvas_project, replace_canvas_node_media
from tests.canvas_edit_helpers import submit_saved_edit
from character_workflow.lib.schemas import CanvasImageEditOptions
from tests.test_generation_recipe import NOW, _media_node, _save_nodes, _write_keys, png


def setup_source():
    _write_keys()
    pid = create_canvas_project("编辑测试").project_id
    draft = {"mode": "image", "prompt": "", "model": "gpt-image-1", "alias": "openai",
             "updated_at": NOW, "params": {}}
    doc = _save_nodes(pid, [_media_node("source", draft)], [])
    version, doc, _ = replace_canvas_node_media(pid, "source", "s.png", ".png",
                                               png((255, 0, 0), (1024, 1024)), "image", doc.revision)
    return pid, version, doc


def test_outpaint_freezes_geometry_and_keeps_source_untouched(isolated_data_root):
    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(mode="outpaint", source_version_id=version.version_id,
                                    width=1536, height=1024, x=256, y=0)
    job, saved = submit_saved_edit(pid, "source", doc.revision, 1, b"", options)
    assert job.params.image_edit["width"] == 1536
    assert job.params.size == "1536x1024"
    assert job.prompt
    assert saved.nodes[0].data.current_version_id == version.version_id
    assert job.canvas_run.result_node_id != "source"
    assert len(saved.connections) == 2
    assert all(edge.role == "material" for edge in saved.connections)
    # Round-trip the persisted document, not just the unvalidated model_copy response.
    from character_workflow.lib.canvas_projects import read_canvas_document
    assert read_canvas_document(pid).revision == saved.revision
    with Image.open(job.params.mask_image) as mask:
        assert mask.size == (1536, 1024)
        assert mask.getpixel((0, 0)) == 0
        assert mask.getpixel((256, 0)) == 255


def test_edit_rejects_stale_source_before_submit(isolated_data_root):
    pid, _version, doc = setup_source()
    with pytest.raises(ValueError, match="源图版本"):
        submit_saved_edit(pid, "source", doc.revision, 1, b"",
                             CanvasImageEditOptions(source_version_id="stale"))


def test_local_edit_sets_fixed_source_dimensions(isolated_data_root):
    pid, version, doc = setup_source()
    buffer = io.BytesIO()
    Image.new("L", (1024, 1024), 0).save(buffer, format="PNG")
    job, _ = submit_saved_edit(pid, "source", doc.revision, 1, buffer.getvalue(),
                                  CanvasImageEditOptions(source_version_id=version.version_id))
    assert job.params.size_mode == "custom"
    assert job.params.size == "1024x1024"
    assert job.canvas_run.snapshot.normalized_params["image_edit"]["mode"] == "inpaint"


def test_resume_native_edit_reuses_frozen_job_and_checks_revision(isolated_data_root):
    from character_workflow.lib.canvas_runs import finalize_canvas_run, resume_mj_edit_run
    from character_workflow.lib.jobs import save_job
    from character_workflow.lib.schemas import JobStatus

    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(mode="outpaint", source_version_id=version.version_id,
                                    width=1536, height=1024, x=256, y=0)
    job, _ = submit_saved_edit(pid, "source", doc.revision, 1, b"", options)
    job = job.model_copy(update={"model": "midjourney", "status": JobStatus.FAILED,
                                 "error": "查询中断"})
    job.params.mj_edit_state = {"task_id": "accepted", "uncertain": False, "poll_paused": True}
    save_job(job)
    _, failed_doc = finalize_canvas_run(pid, job.job_id)
    with pytest.raises(RuntimeError, match="revision_conflict"):
        resume_mj_edit_run(pid, job.canvas_run.run_id, doc.revision)
    resumed, result = resume_mj_edit_run(pid, job.canvas_run.run_id, failed_doc.revision)
    assert resumed.job_id == job.job_id
    assert resumed.params.mj_edit_state["task_id"] == "accepted"
    assert resumed.canvas_run.snapshot == job.canvas_run.snapshot
    assert resumed.status == JobStatus.PENDING
    assert all(candidate.status == "pending" for candidate in resumed.canvas_run.candidates)
    assert result.nodes[0].data.current_version_id == version.version_id
    with pytest.raises(ValueError, match="没有可续查"):
        resume_mj_edit_run(pid, job.canvas_run.run_id, result.revision)


def test_complete_outpaint_run_registers_candidates_without_modifying_source(isolated_data_root, monkeypatch):
    from character_workflow.lib import callers
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job
    from character_workflow.lib.schemas import JobStatus

    pid, version, doc = setup_source()
    options = CanvasImageEditOptions(mode="outpaint", source_version_id=version.version_id,
                                    width=1536, height=1024, x=256, y=0)
    job, _ = submit_saved_edit(pid, "source", doc.revision, 2, b"", options)
    calls = []
    def generate(**kwargs):
        calls.append(kwargs["params"])
        path = kwargs["output_dir"] / "mock-output.png"
        Image.new("RGBA", (1536, 1024), "blue").save(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", generate)
    result = run_canvas_job(job.job_id)
    assert result.status == JobStatus.DONE
    assert len(calls) == len(result.output_paths) == 2
    assert all(candidate.status == "succeeded" for candidate in result.canvas_run.candidates)
    saved = read_canvas_document(pid)
    assert saved.nodes[0].data.current_version_id == version.version_id
    for path in result.output_paths:
        with Image.open(path) as image:
            assert image.size == (1536, 1024)
            assert image.getpixel((0, 0)) == (0, 0, 255, 255)
            assert image.getpixel((256, 0)) == (255, 0, 0, 255)
