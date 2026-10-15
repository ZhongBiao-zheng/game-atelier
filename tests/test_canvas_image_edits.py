import io

import pytest
from PIL import Image

from character_workflow.lib.canvas_projects import create_canvas_project, replace_canvas_node_media
from character_workflow.lib.canvas_runs import submit_mask_edit_run
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
    job, saved = submit_mask_edit_run(pid, "source", doc.revision, 1, b"", options)
    assert job.params.image_edit["width"] == 1536
    assert job.params.size == "1536x1024"
    assert job.prompt
    assert saved.nodes[0].data.current_version_id == version.version_id
    assert job.canvas_run.result_node_id != "source"
    assert len(saved.connections) == 1
    assert saved.connections[0].role == "input"
    with Image.open(job.params.mask_image) as mask:
        assert mask.size == (1536, 1024)
        assert mask.getpixel((0, 0)) == 0
        assert mask.getpixel((256, 0)) == 255


def test_edit_rejects_stale_source_before_submit(isolated_data_root):
    pid, _version, doc = setup_source()
    with pytest.raises(ValueError, match="源图版本"):
        submit_mask_edit_run(pid, "source", doc.revision, 1, b"",
                             CanvasImageEditOptions(source_version_id="stale"))


def test_local_edit_sets_fixed_source_dimensions(isolated_data_root):
    pid, version, doc = setup_source()
    buffer = io.BytesIO()
    Image.new("L", (1024, 1024), 0).save(buffer, format="PNG")
    job, _ = submit_mask_edit_run(pid, "source", doc.revision, 1, buffer.getvalue(),
                                  CanvasImageEditOptions(source_version_id=version.version_id))
    assert job.params.size_mode == "custom"
    assert job.params.size == "1024x1024"
    assert job.canvas_run.snapshot.normalized_params["image_edit"]["mode"] == "inpaint"
