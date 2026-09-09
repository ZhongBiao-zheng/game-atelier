from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient as AnonymousClient

from tests.local_client import LocalTestClient
from tests.test_canvas_layer_decomposition import PNG, _project_with_decomposition_node
from character_workflow.lib import canvas_layer_exports
from character_workflow.lib.canvas_projects import (
    save_canvas_document, resolve_canvas_media, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasLayerStackLayer, LayerDecompositionBoundingBox
from viewer_server.server_app import build_app


def _completed_stack():
    project, document, version = _project_with_decomposition_node()
    first, document, _ = save_canvas_upload(
        project.project_id, "first.png", ".png", PNG, "image", document.revision,
    )
    second, document, _ = save_canvas_upload(
        project.project_id, "second.png", ".png", PNG, "image", document.revision,
    )
    stack = document.nodes[1]
    layer = CanvasLayerStackLayer(
        id="hidden-layer", version_id=first.version_id, z_index=1, name="../背景:一",
        description="", visible=False,
        bounding_box=LayerDecompositionBoundingBox(
            absolute=(0, 0, 1, 1), normalized=(0, 0, 1000, 1000),
        ),
    )
    stack = stack.model_copy(update={"data": stack.data.model_copy(update={
        "base_version_id": version.version_id, "base_visible": False,
        "layers": [layer, layer.model_copy(update={
            "id": "second", "z_index": 2, "version_id": second.version_id,
        })],
    })})
    document = save_canvas_document(project.project_id, document.model_copy(update={
        "nodes": [document.nodes[0], stack],
    }), document.revision)
    return project, document, version


def test_download_all_layers_keeps_hidden_and_duplicate_names_and_cleans_temp(monkeypatch):
    project, document, version = _completed_stack()
    created = []
    original = canvas_layer_exports.export_canvas_layers

    def capture(*args):
        result = original(*args)
        created.append(result[0])
        return result

    monkeypatch.setattr(canvas_layer_exports, "export_canvas_layers", capture)
    response = LocalTestClient(build_app(), base_url="http://127.0.0.1").get(
        f"/api/canvas/projects/{project.project_id}/nodes/layer-stack/layers/download",
    )
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"
    original_bytes = resolve_canvas_media(project.project_id, version.version_id)[0].read_bytes()
    with ZipFile(BytesIO(response.content)) as archive:
        assert archive.namelist() == ["001-背景.png", "002--背景-一.png", "003--背景-一.png"]
        assert all(archive.read(name) == original_bytes for name in archive.namelist())
    assert created and not created[0].exists()


@pytest.mark.parametrize("target, expected", [("missing", 404), ("source-image", 404), ("layer-stack", 422)])
def test_download_rejects_missing_wrong_type_and_unfinished_nodes(target, expected):
    project, _, _ = _project_with_decomposition_node()
    response = LocalTestClient(build_app(), base_url="http://127.0.0.1").get(
        f"/api/canvas/projects/{project.project_id}/nodes/{target}/layers/download",
    )
    assert response.status_code == expected


def test_download_rejects_missing_file_and_anonymous_access():
    project, _, version = _completed_stack()
    path, _ = resolve_canvas_media(project.project_id, version.version_id)
    path.unlink()
    url = f"/api/canvas/projects/{project.project_id}/nodes/layer-stack/layers/download"
    assert LocalTestClient(build_app(), base_url="http://127.0.0.1").get(url).status_code == 404
    assert AnonymousClient(build_app(), base_url="http://127.0.0.1").get(url).status_code == 401


@pytest.mark.parametrize("range_header, status", [("bytes=999999-", 416), ("bytes=invalid", 400)])
def test_download_cleans_archive_after_invalid_range(monkeypatch, range_header, status):
    project, _, _ = _completed_stack()
    created = []
    original = canvas_layer_exports.export_canvas_layers

    def capture(*args):
        result = original(*args)
        created.append(result[0])
        return result

    monkeypatch.setattr(canvas_layer_exports, "export_canvas_layers", capture)
    response = LocalTestClient(build_app(), base_url="http://127.0.0.1").get(
        f"/api/canvas/projects/{project.project_id}/nodes/layer-stack/layers/download",
        headers={"Range": range_header},
    )
    assert response.status_code == status
    assert created and not created[0].exists()


@pytest.mark.asyncio
async def test_download_cleans_archive_after_send_failure(tmp_path):
    from viewer_server.routes import _LayerArchiveResponse

    target = tmp_path / "download.zip"
    target.write_bytes(b"test archive")

    async def fail_send(message):
        raise ConnectionError("download interrupted")

    with pytest.raises(ConnectionError):
        await _LayerArchiveResponse(target)(
            {"type": "http", "method": "GET", "headers": []}, None, fail_send,
        )
    assert not target.exists()
