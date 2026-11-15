"""序列帧插件（plugins/frames）的路由端到端：真实插件包 + 真实视频夹具。"""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import plugin_grants, plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import use_plugins_root
from viewer_server.server_app import build_app

REPO = Path(__file__).resolve().parent.parent
VIDEO = (Path(__file__).parent / "fixtures" / "video" / "h264-24f.mp4").read_bytes()  # 第 k 帧白块在 x=4k


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "plugins"
    use_plugins_root(monkeypatch, root)
    shutil.copytree(REPO / "plugins" / "frames", root / "frames",
                    ignore=shutil.ignore_patterns("__pycache__", "tests", "ui"))
    plugin_registry.set_enabled("frames", True)
    project_id = create_canvas_project("抽帧").project_id
    document = read_canvas_document(project_id)
    _, document, _ = save_canvas_upload(
        project_id, "walk.mp4", ".mp4", VIDEO, "video", document.revision,
        node_factory=lambda v: _media_node("video", "video-1", "走路", {"x": 0, "y": 0}, v.version_id))
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": "extract-1", "type": "plugin", "title": "视频抽帧", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 360, "height": 280},
        "data": {"plugin_id": "frames", "node_type": "extract", "plugin_version": "0.1.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    raw["connections"].append({"id": "c-1", "role": "input", "source_node_id": "video-1", "target_node_id": "extract-1"})
    save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)
    plugin_grants.grant(project_id, "frames")
    yield project_id
    plugin_server.unload("frames")


@pytest.fixture
def client(project, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def video_version(project_id: str) -> str:
    return next(node for node in read_canvas_document(project_id).nodes if node.id == "video-1").data.current_version_id


def post(client, project_id, route, params):
    return client.post(f"/api/plugins/frames/routes/{route}", json={
        "project_id": project_id, "node_id": "extract-1", "inputs": [video_version(project_id)], "params": params})


def image_of(project_id: str, node_id: str) -> Image.Image:
    node = next(node for node in read_canvas_document(project_id).nodes if node.id == node_id)
    path, _ = resolve_canvas_media(project_id, node.data.current_version_id)
    return Image.open(path).convert("RGB")


def block_x(image: Image.Image) -> float:
    green = np.asarray(image)[:, :, 1].astype(float)
    weights = (green * (green > 128)).sum(axis=0)
    return float(weights.dot(np.arange(image.width)) / weights.sum()) - 1.5


def test_probe_and_preview_describe_exactly_the_frames_to_extract(client, project):
    probe = post(client, project, "probe", {})
    assert probe.status_code == 200, probe.text
    assert probe.json()["result"] == {"width": 96, "height": 64, "fps": 24.0, "frame_count": 24,
                                      "duration_ms": 1000, "title": "走路"}
    preview = post(client, project, "preview", {"start": 0, "end": None, "mode": "count", "count": 4})
    result = preview.json()["result"]
    assert result["frames"] == [0, 8, 15, 23]
    assert len(result["thumbnails"]) == 4 and all(url.startswith("data:image/jpeg;base64,") for url in result["thumbnails"])


def test_extract_lands_the_frames_as_a_result_stack(client, project):
    response = post(client, project, "extract", {"start": 2, "end": 20, "mode": "step", "step": 6, "long_edge": 48})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["frames"] == [2, 8, 14, 20] and result["size"] == [48, 32]
    document = read_canvas_document(project)
    nodes = {node.id: node for node in document.nodes}
    cover = nodes[result["node_id"]]
    assert cover.data.result_stack.member_node_ids == result["member_node_ids"]
    assert [nodes[node_id].title for node_id in [cover.id, *result["member_node_ids"]]] == [
        "走路 帧", "走路 帧 · 2", "走路 帧 · 3", "走路 帧 · 4"]
    images = [image_of(project, node_id) for node_id in [cover.id, *result["member_node_ids"]]]
    assert [image.size for image in images] == [(48, 32)] * 4
    # 帧号精确：第 k 帧的白块在原尺寸 x=4k，缩到一半后在 2k。
    assert [block_x(image) for image in images] == pytest.approx([4, 16, 28, 40], abs=1.2)


def test_extract_can_also_compose_a_sheet_and_frame_data(client, project):
    result = post(client, project, "extract", {
        "start": 0, "end": None, "mode": "count", "count": 4, "sheet": True, "columns": 2, "frame_data": True,
    }).json()["result"]
    sheet = image_of(project, result["sheet_node_id"])
    assert sheet.size == (2 * 96 + 2, 2 * 64 + 2)
    nodes = {node.id: node for node in read_canvas_document(project).nodes}
    assert nodes[result["frame_data_node_id"]].type == "text"
    # 结果组默认收起：精灵表紧挨插件节点，结果组让开它往右放，两者都不压插件节点。
    plugin_right = nodes["extract-1"].position.x + 360
    assert plugin_right < nodes[result["sheet_node_id"]].position.x < nodes[result["node_id"]].position.x


def test_invalid_plans_come_back_as_readable_reasons(client, project):
    response = post(client, project, "extract", {"start": 0, "end": None, "mode": "count", "count": 66})
    assert response.status_code == 422
    assert "帧数要在 1 到 65 之间" in response.text
    before = read_canvas_document(project).revision
    assert post(client, project, "extract", {"start": 30, "mode": "count", "count": 2}).status_code == 422
    assert read_canvas_document(project).revision == before


def test_agent_extracts_by_video_node_id(project):
    names = set(runtime.plugin_tools())
    assert {"plugin_frames_probe", "plugin_frames_extract"} <= names
    result, created = plugin_server.call("frames", "POST", "/extract", project_id=project, origin="agent",
                                         params={"video_node_id": "video-1", "mode": "rate", "rate": 6})
    assert result["frames"] == [0, 4, 8, 12, 16, 20]
    assert len(created) == 6
    with pytest.raises(plugin_server.PluginError):
        plugin_server.call("frames", "POST", "/probe", project_id=project, origin="agent",
                           params={"video_node_id": "extract-1"})


# ── 补间 ─────────────────────────────────────────────────────────────────────

def add_tween_node(project_id: str, source: str) -> None:
    document = read_canvas_document(project_id)
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": "tween-1", "type": "plugin", "title": "补间", "position": {"x": 400, "y": 600}, "z_index": 0,
        "size": {"width": 360, "height": 280},
        "data": {"plugin_id": "frames", "node_type": "tween", "plugin_version": "0.1.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    raw["connections"].append({"id": "c-tween", "role": "input", "source_node_id": source, "target_node_id": "tween-1"})
    save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)


def stack_versions(project_id: str, cover_id: str) -> list[str]:
    nodes = {node.id: node for node in read_canvas_document(project_id).nodes}
    cover = nodes[cover_id]
    return [nodes[node_id].data.current_version_id for node_id in [cover_id, *cover.data.result_stack.member_node_ids]]


def post_tween(client, project_id, route, versions, params):
    return client.post(f"/api/plugins/frames/routes/{route}", json={
        "project_id": project_id, "node_id": "tween-1", "inputs": versions, "params": params})


def test_tween_takes_a_whole_result_stack_through_one_connection(client, project):
    group = post(client, project, "extract", {"start": 0, "end": 3, "mode": "step", "step": 1}).json()["result"]
    add_tween_node(project, group["node_id"])
    versions = stack_versions(project, group["node_id"])
    assert len(versions) == 4

    preview = post_tween(client, project, "tween_preview", versions, {"method": "flow", "pair": 1})
    assert preview.status_code == 200, preview.text
    assert preview.json()["result"]["pairs"] == 3
    assert preview.json()["result"]["url"].startswith("data:image/")

    response = post_tween(client, project, "tween", versions, {"method": "flow", "between": 3, "output": "all"})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["frame_count"] == 4 + 3 * 3
    nodes = {node.id: node for node in read_canvas_document(project).nodes}
    frames = [image_of(project, node_id) for node_id in [result["node_id"], *result["member_node_ids"]]]
    # 原帧是第 0–3 帧（白块 x=0/4/8/12），中间各补 3 帧：白块应依次右移约 1 像素。
    positions = [block_x(frame) for frame in frames]
    assert positions == pytest.approx(list(range(13)), abs=1.0)
    assert nodes[result["node_id"]].title == "走路 帧 补间"


def test_tween_refuses_versions_outside_the_connected_stack(client, project):
    group = post(client, project, "extract", {"start": 0, "end": 12, "mode": "step", "step": 6}).json()["result"]
    other = post(client, project, "extract", {"start": 0, "end": 6, "mode": "step", "step": 6}).json()["result"]
    add_tween_node(project, group["node_id"])
    stranger = stack_versions(project, other["node_id"])[1]
    response = post_tween(client, project, "tween", [stack_versions(project, group["node_id"])[0], stranger],
                          {"method": "crossfade", "between": 1})
    assert response.status_code == 403 and response.json()["detail"]["code"] == "INVALID_HANDLE"


def test_agent_tweens_by_image_node_ids(project, client):
    group = post(client, project, "extract", {"start": 0, "end": 8, "mode": "step", "step": 8}).json()["result"]
    result, created = plugin_server.call("frames", "POST", "/tween", project_id=project, origin="agent", params={
        "image_node_ids": [group["node_id"], *group["member_node_ids"]], "method": "crossfade", "between": 2,
        "output": "new"})
    assert result["frame_count"] == 2 and len(created) == 2
    assert "plugin_frames_tween" in runtime.plugin_tools()


def test_tween_draft_prepares_a_first_last_video_without_running_it(client, project):
    from character_workflow.lib import keys
    from character_workflow.lib.jobs import list_jobs
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="ark", provider="seedance", access_key="test-only-not-a-real-key", modalities=["video"],
        models=[keys.ModelSpec(id="doubao-seedance-1-0-pro-250528", name="Seedance 1.0 Pro", modality="video",
                               protocol="seedance")],
        created_at="2026-11-15T00:00:00Z")]))
    group = post(client, project, "extract", {"start": 0, "end": 12, "mode": "step", "step": 6}).json()["result"]
    add_tween_node(project, group["node_id"])
    versions = stack_versions(project, group["node_id"])
    response = post_tween(client, project, "tween_draft", versions, {"pair": 1, "prompt": "平滑过渡"})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    # 96×64（1.5）最接近 4:3；Seedance 1.0 最短 2 秒。
    assert (result["model"], result["duration"], result["resolution"], result["ratio"]) == (
        "doubao-seedance-1-0-pro-250528", 2, "480p", "4:3")
    document = read_canvas_document(project)
    slots = {edge.slot: edge.source_node_id for edge in document.connections if edge.target_node_id == result["node_id"]}
    assert slots == {"first_frame": group["member_node_ids"][0], "last_frame": group["member_node_ids"][1]}
    assert list_jobs() == []
