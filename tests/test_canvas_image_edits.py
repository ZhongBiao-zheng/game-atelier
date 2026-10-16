
import pytest
import io
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


def test_regular_inpaint_runs_through_saved_node_and_preserves_source(isolated_data_root, monkeypatch):
    from character_workflow.lib import callers
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job
    from character_workflow.lib.schemas import JobStatus

    pid, version, doc = setup_source()
    mask = Image.new("L", (1024, 1024), 255)
    mask.paste(0, (300, 300, 700, 700))
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG")
    job, saved = submit_saved_edit(pid, "source", doc.revision, 1, buffer.getvalue())
    assert job.params.image_edit["mode"] == "inpaint"
    assert job.params.size == "1024x1024"
    assert job.params.n == 1
    edit_node = next(n for n in saved.nodes if n.type == "image_edit")
    assert [(e.source_node_id, e.target_node_id) for e in saved.connections] == [
        ("source", edit_node.id), (edit_node.id, job.canvas_run.result_node_id),
    ]
    def generate(**kwargs):
        assert kwargs["params"]["mask_image"]
        output = kwargs["output_dir"] / "mock.png"
        Image.new("RGB", (1024, 1024), "blue").save(output)
        return [str(output)]
    monkeypatch.setattr(callers, "dispatch", generate)
    result = run_canvas_job(job.job_id)
    assert result.status == JobStatus.DONE
    assert read_canvas_document(pid).nodes[0].data.current_version_id == version.version_id
    with Image.open(result.output_paths[0]) as output:
        assert output.getpixel((0, 0)) == (255, 0, 0, 255)
        assert output.getpixel((500, 500)) == (0, 0, 255, 255)
        assert 0 < output.getpixel((300, 500))[2] < 255


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
