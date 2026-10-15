"""Saved edit configurations carry their frozen source and editable mask across projects."""
import io
import json

import pytest
from PIL import Image
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app

from character_workflow.lib.canvas_packages import (
    commit_canvas_package, export_canvas_projects, inspect_canvas_package,
)
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media,
)
from tests.test_canvas_paste_routes import _paste, _source_canvas


@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def saved_edit(client):
    project_id, _image, _text, source_version = _source_canvas()
    document = read_canvas_document(project_id)
    mask = Image.new("L", (6, 4), 255)
    mask.paste(0, (1, 1, 3, 3))
    stream = io.BytesIO()
    mask.save(stream, format="PNG")
    response = client.post(f"/api/canvas/projects/{project_id}/image-edits", data={
        "payload": json.dumps({
            "expected_revision": document.revision,
            "source_node_id": "node-image", "source_version_id": source_version,
            "generation_draft": None, "options": {"mode": "inpaint"},
            "editor_state": {
                "native": False, "strokes": [{"tool": "rectangle", "size": 4,
                    "points": [{"x": 1, "y": 1}, {"x": 3, "y": 3}]}],
                "frame": {"width": 9, "height": 6, "x": 1, "y": 1}, "frame_ratio": "",
            },
        }),
    }, files={"mask_file": ("mask.png", stream.getvalue(), "image/png")})
    assert response.status_code in (200, 201), response.text
    body = response.json()
    node = next(n for n in body["document"]["nodes"] if n["id"] == body["node_id"])
    return project_id, node


def test_cross_canvas_edit_copy_keeps_mask_origin_and_frozen_versions(client):
    project_id, node = saved_edit(client)
    old_data = node["data"]
    target = create_canvas_project("编辑副本")
    response = _paste(client, target.project_id, {
        "source_project_id": project_id,
        "nodes": [{**node, "id": "copied-edit"}], "connections": [],
    })
    assert response.status_code == 200, response.text
    document = response.json()
    copied = document["nodes"][0]["data"]
    assert copied["source_node_id"] is None
    assert copied["active_run_id"] is None
    assert copied["source_version_id"] != old_data["source_version_id"]
    assert copied["mask_version_id"] != old_data["mask_version_id"]
    assert copied["editor_state"] == old_data["editor_state"]
    mask = document["content_versions"][copied["mask_version_id"]]
    assert mask["origin"]["kind"] == "user_mask"
    assert mask["origin"]["source_version_id"] == copied["source_version_id"]
    original_path, _ = resolve_canvas_media(project_id, old_data["mask_version_id"])
    copied_path, _ = resolve_canvas_media(target.project_id, copied["mask_version_id"])
    assert copied_path.read_bytes() == original_path.read_bytes()
    # No generation history is needed to export a pasted edit.
    archive, _ = export_canvas_projects([target.project_id])
    assert inspect_canvas_package(archive).projects


def test_saved_but_never_generated_edit_roundtrips_in_project_package(client):
    project_id, node = saved_edit(client)
    archive, _ = export_canvas_projects([project_id])
    imported = commit_canvas_package(inspect_canvas_package(archive).token)[0]
    restored = read_canvas_document(imported.project_id)
    edit = next(n for n in restored.nodes if n.id == node["id"])
    assert edit.model_dump(mode="json")["data"] == node["data"]
    assert len(restored.connections) == 1
    assert restored.connections[0].role == "material"
    assert restored.connections[0].target_node_id == edit.id
    for field in ("source_version_id", "mask_version_id"):
        original_path, _ = resolve_canvas_media(project_id, node["data"][field])
        restored_path, _ = resolve_canvas_media(imported.project_id, getattr(edit.data, field))
        assert restored_path.read_bytes() == original_path.read_bytes()


def test_project_package_preserves_edit_config_and_multiple_result_histories():
    from character_workflow.lib.canvas_runs import submit_image_edit_run
    from character_workflow.lib.jobs import list_jobs
    from tests.test_canvas_edit_nodes import complete, node, save_edit, selection
    from tests.test_canvas_image_edits import setup_source

    project_id, source, document = setup_source()
    saved, edit_id = save_edit(project_id, document, source, mask=selection())
    first, _ = submit_image_edit_run(project_id, edit_id, saved.revision, 1)
    _, saved = complete(project_id, first)
    draft = node(saved, edit_id).data.generation_draft.model_copy(update={"prompt": "second edit"})
    saved, _ = save_edit(project_id, saved, source, node_id=edit_id,
                         mask=selection(128), generation_draft=draft)
    second, _ = submit_image_edit_run(project_id, edit_id, saved.revision, 1)
    _, saved = complete(project_id, second)

    archive, _ = export_canvas_projects([project_id])
    imported = commit_canvas_package(inspect_canvas_package(archive).token)[0]
    restored = read_canvas_document(imported.project_id)
    assert node(restored, edit_id).data == node(saved, edit_id).data
    imported_jobs = [job for job in list_jobs() if job.canvas_project_id == imported.project_id]
    assert len(imported_jobs) == 2
    assert len({job.canvas_run.result_node_id for job in imported_jobs}) == 2
    for job in imported_jobs:
        snapshot = job.canvas_run.snapshot
        assert snapshot.surface_node_id == edit_id
        assert snapshot.mask_version_id in restored.content_versions
        assert all(item.version_id in restored.content_versions for item in snapshot.inputs)
        assert any(edge.source_node_id == edit_id and edge.target_node_id == job.canvas_run.result_node_id
                   and edge.role == "material" for edge in restored.connections)
