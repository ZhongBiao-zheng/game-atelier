"""EvoLink native upload editing through the actual Canvas/Job boundaries (no network)."""
import io

import pytest
from PIL import Image

from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, replace_canvas_node_media,
)
from character_workflow.lib.canvas_runs import (
    finalize_canvas_run, resume_mj_edit_run, run_canvas_job,
)
from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.schemas import CanvasImageEditOptions, JobStatus
from tests.test_generation_recipe import NOW, _media_node, _save_nodes, png
from tests.canvas_edit_helpers import submit_saved_edit


def source():
    write_keys_db(KeysDB(keys=[KeySpec(alias="Evo", provider="evolink", access_key="test",
        base_url="https://api.evolink.ai/v1", created_at=NOW,
        models=[ModelSpec(id="mj-v8.2", name="MJ", modality="image", protocol="evolink")])]))
    pid = create_canvas_project("Evo native edit").project_id
    draft = {"mode": "image", "prompt": "A red ball", "alias": "Evo", "model": "mj-v8.2",
             "params": {"n": 4}, "updated_at": NOW}
    doc = _save_nodes(pid, [_media_node("source", draft)], [])
    version, doc, _ = replace_canvas_node_media(pid, "source", "source.png", ".png",
        png((20, 40, 60), (96, 64)), "image", doc.revision)
    mask = Image.new("L", (96, 64), 255)
    mask.paste(0, (20, 20, 40, 40))
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG")
    return pid, version, doc, buffer.getvalue()


@pytest.mark.parametrize("mode", ["inpaint", "outpaint"])
def test_external_source_creates_one_native_job_and_four_materials(monkeypatch, mode):
    from character_workflow.lib.callers import evolink

    pid, version, doc, mask = source()
    options = CanvasImageEditOptions(mode=mode, source_version_id=version.version_id,
        **({"width": 192, "height": 80, "x": 48, "y": 8} if mode == "outpaint" else {}))
    job, _ = submit_saved_edit(pid, "source", doc.revision, 1, mask, options)
    assert job.params.n == 4
    assert job.params.regional_edit is None
    assert len(job.params.reference_images) == 1
    assert "task_id" not in job.params.image_edit
    with Image.open(job.params.mask_image) as frozen_mask:
        assert frozen_mask.size == (96, 64)
        assert frozen_mask.getpixel((25, 25)) == (0 if mode == "inpaint" else 255)
    calls = []

    def render(**kwargs):
        calls.append(kwargs)
        paths = []
        for i in range(4):
            path = kwargs["output_dir"] / f"{i}.png"
            Image.new("RGB", (192, 80) if mode == "outpaint" else (96, 64), "red").save(path)
            paths.append(str(path))
        kwargs["params"].update(evolink_state={"task_id": "one-order", "terminal": "completed"},
                                provider_task_protocol="evolink", provider_task_ids=["one-order"])
        kwargs["on_params_changed"]()
        return paths

    monkeypatch.setattr(evolink, "render", render)
    result = run_canvas_job(job.job_id)
    assert result.status == JobStatus.DONE
    assert len(calls) == 1
    assert len(result.output_paths) == 4
    assert read_job(job.job_id).params.evolink_state["task_id"] == "one-order"
    saved = read_canvas_document(pid)
    assert saved.nodes[0].data.current_version_id == version.version_id
    assert len(saved.connections) == 2
    assert all(c.role == "material" for c in saved.connections)
    assert len(result.canvas_run.candidates) == 4
    assert all(c.version_id in saved.content_versions for c in result.canvas_run.candidates)
    # Native results are not overwritten by the common-model compositor.
    with Image.open(result.output_paths[0]) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)


@pytest.mark.parametrize("terminal", [None, "completed"])
def test_paused_native_order_resumes_same_job_without_new_order(terminal):
    pid, version, doc, mask = source()
    job, _ = submit_saved_edit(pid, "source", doc.revision, 4, mask,
                                 CanvasImageEditOptions(source_version_id=version.version_id))
    job.status = JobStatus.FAILED
    job.params.evolink_state = {"task_id": "accepted", "poll_paused": True, "terminal": terminal}
    save_job(job)
    _, failed_doc = finalize_canvas_run(pid, job.job_id)
    resumed, _ = resume_mj_edit_run(pid, job.canvas_run.run_id, failed_doc.revision)
    assert resumed.job_id == job.job_id
    assert resumed.params.evolink_state["task_id"] == "accepted"
    assert resumed.status == JobStatus.PENDING


@pytest.mark.parametrize("state", [
    {"uncertain": True},
    {"task_id": "id", "uncertain": True},
    {"task_id": "id", "terminal": "failed", "poll_paused": True},
])
def test_uncertain_or_terminal_failure_cannot_resume(state):
    pid, version, doc, mask = source()
    job, _ = submit_saved_edit(pid, "source", doc.revision, 4, mask,
                                 CanvasImageEditOptions(source_version_id=version.version_id))
    job.status = JobStatus.FAILED
    job.params.evolink_state = state
    save_job(job)
    _, failed_doc = finalize_canvas_run(pid, job.job_id)
    with pytest.raises(ValueError, match="没有可续查"):
        resume_mj_edit_run(pid, job.canvas_run.run_id, failed_doc.revision)


def test_unsupported_reference_rejected_before_order():
    pid, version, doc, mask = source()
    with pytest.raises(ValueError, match="额外参考"):
        submit_saved_edit(pid, "source", doc.revision, 4, mask,
            CanvasImageEditOptions(source_version_id=version.version_id, reference_node_id="source"))
