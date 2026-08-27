"""Empty media nodes can be filled without creating a second canvas node."""
from __future__ import annotations

import base64

import pytest

from character_workflow.lib.canvas_projects import (
    CanvasMediaReplaceError,
    create_canvas_project,
    read_canvas_document,
    replace_canvas_node_media,
    save_canvas_document,
)
from character_workflow.lib.schemas import CanvasDocument


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _empty_image_document(project_id: str) -> CanvasDocument:
    current = read_canvas_document(project_id)
    return CanvasDocument.model_validate({
        **current.model_dump(mode="json"),
        "nodes": [{
            "id": "image-empty",
            "title": "空图片",
            "type": "image",
            "position": {"x": 100, "y": 100},
            "data": {
                "current_version_id": None,
                "generation_draft": None,
                "active_run_id": None,
                "display": {"fit": "contain", "free_resize": False},
            },
        }],
    })


def test_empty_media_node_accepts_same_kind_upload(isolated_data_root):
    project = create_canvas_project("节点上传")
    saved = save_canvas_document(
        project.project_id,
        _empty_image_document(project.project_id),
        expected_revision=0,
    )

    version, updated, filename = replace_canvas_node_media(
        project.project_id,
        "image-empty",
        "reference.png",
        ".png",
        _PNG,
        "image",
        expected_revision=saved.revision,
    )

    assert filename == "reference.png"
    assert version.kind == "image"
    assert updated.revision == saved.revision + 1
    assert updated.nodes[0].data.current_version_id == version.version_id
    assert updated.content_versions[version.version_id] == version
    assert (isolated_data_root / "canvases" / project.project_id / version.path).read_bytes() == _PNG


def test_empty_media_node_rejects_cross_kind_upload(isolated_data_root):
    project = create_canvas_project("节点上传类型")
    saved = save_canvas_document(
        project.project_id,
        _empty_image_document(project.project_id),
        expected_revision=0,
    )

    with pytest.raises(CanvasMediaReplaceError, match="上传文件必须与节点的媒体类型一致"):
        replace_canvas_node_media(
            project.project_id,
            "image-empty",
            "voice.mp3",
            ".mp3",
            b"ID3audio",
            "audio",
            expected_revision=saved.revision,
        )

    assert read_canvas_document(project.project_id).revision == saved.revision
    assert not any((isolated_data_root / "canvases" / project.project_id / "uploads").iterdir())
