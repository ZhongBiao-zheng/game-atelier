"""像素化插件（plugins/pixel）的路由端到端：真实插件包。"""
from __future__ import annotations

import base64
import io
import shutil
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import plugin_grants, plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media, save_canvas_document, save_canvas_upload_batch,
)
from character_workflow.lib.schemas import CanvasDocument, CanvasResultStack
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import use_plugins_root
from viewer_server.server_app import build_app

REPO = Path(__file__).resolve().parent.parent


def frame_png(shift: int) -> bytes:
    rng = np.random.default_rng(11)
    array = np.zeros((128, 96, 4), np.uint8)
    array[24:104, 16:80, :3] = np.clip(rng.integers(60, 230, (80, 64, 3)) + shift, 0, 255)
    array[24:104, 16:80, 3] = 255
    buffer = io.BytesIO()
    Image.fromarray(array, "RGBA").save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "plugins"
    use_plugins_root(monkeypatch, root)
    shutil.copytree(REPO / "plugins" / "pixel", root / "pixel", ignore=shutil.ignore_patterns("__pycache__", "tests", "ui"))
    plugin_registry.set_enabled("pixel", True)
    project_id = create_canvas_project("像素化").project_id
    document = read_canvas_document(project_id)
    node_ids = ["frame-1", "frame-2", "frame-3"]

    def nodes(versions):
        built = [_media_node("image", node_id, f"角色 · {index}", {"x": 0, "y": 0}, version.version_id)
                 for index, (node_id, version) in enumerate(zip(node_ids, versions, strict=True), start=1)]
        stack = CanvasResultStack(run_id="plugin:frames:test", member_node_ids=node_ids[1:])
        built[0] = built[0].model_copy(update={"data": built[0].data.model_copy(update={"result_stack": stack})})
        return built

    save_canvas_upload_batch(project_id, [(".png", frame_png(shift), "image") for shift in (0, 4, 8)],
                             document.revision, nodes_factory=nodes)
    document = read_canvas_document(project_id)
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": "pixel-1", "type": "plugin", "title": "像素化", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 320, "height": 280},
        "data": {"plugin_id": "pixel", "node_type": "pixelate", "plugin_version": "0.1.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    raw["connections"].append({"id": "c-1", "role": "input", "source_node_id": "frame-1", "target_node_id": "pixel-1"})
    save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)
    plugin_grants.grant(project_id, "pixel")
    yield project_id
    plugin_server.unload("pixel")


@pytest.fixture
def client(project, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def stack_versions(project_id: str) -> list[str]:
    nodes = {node.id: node for node in read_canvas_document(project_id).nodes}
    return [nodes[node_id].data.current_version_id for node_id in ("frame-1", "frame-2", "frame-3")]


def post(client, project_id, route, params, versions=None):
    return client.post(f"/api/plugins/pixel/routes/{route}", json={
        "project_id": project_id, "node_id": "pixel-1", "inputs": versions or stack_versions(project_id), "params": params})


def image_of(project_id: str, node_id: str) -> Image.Image:
    node = next(node for node in read_canvas_document(project_id).nodes if node.id == node_id)
    path, _ = resolve_canvas_media(project_id, node.data.current_version_id)
    return Image.open(path).convert("RGBA")


SETTINGS = {"size_mode": "long_edge", "long_edge": 32, "palette": {"kind": "auto", "colors": 6}}


def test_preview_and_palette_describe_the_shared_palette(client, project):
    palette = post(client, project, "palette", SETTINGS)
    assert palette.status_code == 200, palette.text
    colors = palette.json()["result"]["colors"]
    assert 1 <= len(colors) <= 6
    preview = post(client, project, "preview", {**SETTINGS, "frame": 2}).json()["result"]
    assert preview["size"] == [24, 32] and preview["colors"] == colors
    image = Image.open(io.BytesIO(base64.b64decode(preview["url"].split(",", 1)[1])))
    assert image.size == (24, 32)


def test_pixelate_a_result_stack_into_a_new_stack_with_one_palette(client, project):
    response = post(client, project, "pixelate", {**SETTINGS, "upscale": 4, "keep_original_size": True})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["frame_count"] == 3 and result["size"] == [24, 32]
    big = [image_of(project, node_id) for node_id in [result["node_id"], *result["member_node_ids"]]]
    assert [image.size for image in big] == [(96, 128)] * 3
    allowed = {tuple(int(value[i:i + 2], 16) for i in (1, 3, 5)) for value in result["colors"]}
    for image in big:
        array = np.asarray(image)
        assert {tuple(pixel) for pixel in array[array[..., 3] > 0][:, :3].tolist()} <= allowed
        assert set(np.unique(array[..., 3]).tolist()) <= {0, 255}
    original = read_canvas_document(project)
    cover = next(node for node in original.nodes if node.id == result["original_node_id"])
    assert image_of(project, cover.id).size == (24, 32)
    assert len(cover.data.result_stack.member_node_ids) == 2


def test_single_image_comes_back_as_one_node(client, project):
    single = stack_versions(project)[:1]
    response = post(client, project, "pixelate", SETTINGS, versions=single)
    assert response.status_code == 200, response.text
    assert "member_node_ids" not in response.json()["result"]


def test_bad_settings_are_readable(client, project):
    response = post(client, project, "pixelate", {**SETTINGS, "long_edge": 2})
    assert response.status_code == 422 and "长边要在 8 到 512 之间" in response.text


def test_agent_pixelates_by_node_ids(project):
    assert "plugin_pixel_pixelate" in runtime.plugin_tools()
    result, created = plugin_server.call("pixel", "POST", "/pixelate", project_id=project, origin="agent",
                                         params={**SETTINGS, "image_node_ids": ["frame-1", "frame-2"]})
    assert result["frame_count"] == 2 and len(created) == 2
