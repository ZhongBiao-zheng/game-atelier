"""插件服务端的视频素材（P1）与结果组（P2）。见 .scratch/plugin-system/PLAN-frames.md §5。"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib import plugin_grants, plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import manifest, use_plugins_root, write_plugin
from tests.test_plugin_server import png
from viewer_server.server_app import build_app

VIDEO = (Path(__file__).parent / "fixtures" / "video" / "h264-24f.mp4").read_bytes()
CAPS = ["node.read_self", "resource.read_inputs", "resource.create", "server.call"]
SERVER = '''
import io
from PIL import Image

def _png(index):
    buffer = io.BytesIO(); Image.new("RGBA", (40, 20), (index * 3 % 256, 0, 0, 255)).save(buffer, "PNG")
    return buffer.getvalue()

def register(api):
    @api.route("POST", "/inputs")
    def inputs(ctx, params):
        return {"inputs": [{"kind": item.kind, "size": [item.width, item.height],
                            "duration_ms": item.duration_ms, "exists": item.path.is_file()}
                           for item in ctx.inputs]}

    @api.route("POST", "/peek")
    def peek(ctx, params):
        media = ctx.media_of_node(params["node_id"], tuple(params["kinds"]))
        return {"kind": media.kind, "title": media.title}

    @api.route("POST", "/group")
    def group(ctx, params):
        return ctx.create_image_group([_png(index) for index in range(params["count"])], "角色 帧")
'''
ROUTES = [{"method": "POST", "path": path, "access": access}
          for path, access in (("/inputs", "read"), ("/peek", "read"), ("/group", "edit"))]


def write_demo(root: Path, *, modalities=("video",), capabilities=CAPS) -> None:
    base = manifest()
    node = {**base["contributes"]["nodes"][0], "input_modalities": list(modalities), "max_inputs": 2}
    write_plugin(root, server_source=SERVER, capabilities=capabilities,
                 contributes={"nodes": [node], "server": {"module": "server", "routes": ROUTES}})


def project_with_media() -> tuple[str, dict[str, str]]:
    """一张图（image-1）+ 一个视频（video-1），各自的当前版本 id。"""
    project_id = create_canvas_project("素材测试").project_id
    versions = {}
    for node_id, name, ext, body, kind in (
            ("image-1", "a.png", "png", png(), "image"),
            ("video-1", "a.mp4", ".mp4", VIDEO, "video")):
        document = read_canvas_document(project_id)
        version, _, _ = save_canvas_upload(
            project_id, name, ext, body, kind, document.revision,
            node_factory=lambda v, node_id=node_id, kind=kind: _media_node(
                kind, node_id, node_id, {"x": 0, "y": 0}, v.version_id))
        versions[node_id] = version.version_id
    return project_id, versions


def add_plugin_node(project_id: str, sources=("video-1",)) -> None:
    document = read_canvas_document(project_id)
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": "plugin-1", "type": "plugin", "title": "演示", "position": {"x": 400, "y": 600}, "z_index": 0,
        "size": {"width": 320, "height": 240},
        "data": {"plugin_id": "demo", "node_type": "demo", "plugin_version": "1.0.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    raw["connections"].extend({"id": f"c-{source}", "role": "input", "source_node_id": source,
                               "target_node_id": "plugin-1"} for source in sources)
    save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    yield path
    plugin_server.unload("demo")


@pytest.fixture
def client(root, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def setup(root, *, modalities=("video",), sources=("video-1",), capabilities=CAPS):
    write_demo(root, modalities=modalities, capabilities=capabilities)
    plugin_registry.set_enabled("demo", True)
    project_id, versions = project_with_media()
    add_plugin_node(project_id, sources)
    plugin_grants.grant(project_id, "demo")
    return project_id, versions


def post(client, route, project_id, *, inputs=(), params=None):
    return client.post(f"/api/plugins/demo/routes/{route}", json={
        "project_id": project_id, "node_id": "plugin-1", "inputs": list(inputs), "params": params or {}})


def test_connected_video_reaches_the_server_module_as_a_video_input(client, root):
    project_id, versions = setup(root)
    response = post(client, "inputs", project_id, inputs=[versions["video-1"]])
    assert response.status_code == 200, response.text
    assert response.json()["result"]["inputs"] == [
        {"kind": "video", "size": [96, 64], "duration_ms": None, "exists": True}]


@pytest.mark.parametrize(("narrowed", "allowed", "refused"), [
    (("image",), "image-1", "video-1"),
    (("video",), "video-1", "image-1"),
])
def test_input_kind_must_still_be_declared_when_called(client, root, narrowed, allowed, refused):
    # 保存画布时已按清单拒绝新连线；这里是插件更新后收窄了输入类型、旧连线还在的情形。
    project_id, versions = setup(root, modalities=("image", "video"), sources=("image-1", "video-1"))
    write_demo(root, modalities=narrowed)
    assert post(client, "inputs", project_id, inputs=[versions[allowed]]).status_code == 200
    response = post(client, "inputs", project_id, inputs=[versions[refused]])
    assert response.status_code == 403 and response.json()["detail"]["code"] == "INVALID_HANDLE"


def test_agent_reads_media_by_node_and_kind(root):
    project_id, _ = setup(root)
    result, _ = plugin_server.call("demo", "POST", "/peek", project_id=project_id, origin="agent",
                                   params={"node_id": "video-1", "kinds": ["video"]})
    assert result == {"kind": "video", "title": "video-1"}
    with pytest.raises(plugin_server.PluginError) as wrong_kind:
        plugin_server.call("demo", "POST", "/peek", project_id=project_id, origin="agent",
                           params={"node_id": "image-1", "kinds": ["video"]})
    assert wrong_kind.value.code == "INVALID_TARGET"


def test_surface_cannot_read_media_by_node_id(client, root):
    project_id, _ = setup(root)
    response = post(client, "peek", project_id, params={"node_id": "video-1", "kinds": ["video"]})
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CAPABILITY_DENIED"


def test_image_group_lands_as_a_result_stack_in_one_commit(client, root):
    project_id, _ = setup(root)
    before = read_canvas_document(project_id)
    response = post(client, "group", project_id, params={"count": 5})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    after = read_canvas_document(project_id)
    assert after.revision == before.revision + 1, "整组只提交一次"
    nodes = {node.id: node for node in after.nodes}
    cover = nodes[result["node_id"]]
    members = [nodes[node_id] for node_id in result["member_node_ids"]]
    assert cover.type == "image" and len(members) == 4
    assert cover.data.result_stack.run_id.startswith("plugin:demo:")
    assert cover.data.result_stack.member_node_ids == result["member_node_ids"]
    assert [node.title for node in [cover, *members]] == [
        "角色 帧", "角色 帧 · 2", "角色 帧 · 3", "角色 帧 · 4", "角色 帧 · 5"]
    # 成员与封面顶端对齐、按前端 RESULT_STACK_GAP 的 16 一字排开；40×20 的帧按比例锁成 320×160。
    assert {node.position.y for node in [cover, *members]} == {cover.position.y}
    xs = [node.position.x for node in [cover, *members]]
    assert [round(b - a) for a, b in zip(xs, xs[1:])] == [336] * 4
    assert cover.position.x >= nodes["plugin-1"].position.x + 320, "整组放在插件节点右侧"


@pytest.mark.parametrize("count", [0, 66])
def test_image_group_size_is_bounded_before_anything_is_written(client, root, count):
    project_id, _ = setup(root)
    before = read_canvas_document(project_id)
    response = post(client, "group", project_id, params={"count": count})
    assert response.status_code in {413, 422}
    assert read_canvas_document(project_id).revision == before.revision


def test_image_group_needs_the_create_capability(client, root):
    project_id, _ = setup(root, capabilities=["node.read_self", "resource.read_inputs", "server.call"])
    response = post(client, "group", project_id, params={"count": 2})
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CAPABILITY_DENIED"
