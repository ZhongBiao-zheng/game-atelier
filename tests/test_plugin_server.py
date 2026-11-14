"""插件服务端模块：懒加载、服务端独立校验、Agent 工具。"""
from __future__ import annotations

import asyncio
import io
import shutil
import sys
import threading
from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import plugin_grants, plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import manifest, use_plugins_root, write_plugin
from viewer_server.connection_capabilities import local_capability
from viewer_server.server_app import build_app

REPO = Path(__file__).resolve().parent.parent
MODULE = "atelier_plugin_demo"
CAPS = ["node.read_self", "resource.read_inputs", "resource.create", "server.call"]
SERVER = '''
import asyncio, io, threading
from PIL import Image

def register(api):
    @api.route("POST", "/echo")
    def echo(ctx, params):
        try:
            asyncio.get_running_loop(); on_loop = True
        except RuntimeError:
            on_loop = False
        return {"params": params, "origin": ctx.origin, "node_id": ctx.node_id, "on_event_loop": on_loop,
                "inputs": [{"title": item.title, "size": [item.width, item.height], "exists": item.path.is_file()}
                           for item in ctx.inputs]}

    @api.route("POST", "/make")
    def make(ctx, params):
        buffer = io.BytesIO(); Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(buffer, "PNG")
        return ctx.create_image(buffer.getvalue(), "结果")

    @api.route("POST", "/boom")
    def boom(ctx, params):
        raise RuntimeError("secret /Users/someone/path")

    @api.route("POST", "/invalid")
    def invalid(ctx, params):
        raise ValueError("列数必须大于 0")

    @api.route("POST", "/peek")
    def peek(ctx, params):
        return {"title": ctx.image_of_node(params["image_node_id"]).title}
'''
ROUTES = [{"method": "POST", "path": path, "access": access}
          for path, access in (("/echo", "read"), ("/make", "edit"), ("/boom", "read"),
                               ("/invalid", "read"), ("/peek", "read"))]


def demo(root, capabilities=CAPS, routes=ROUTES, source=SERVER, **overrides):
    base = manifest()
    write_plugin(root, server_source=source, capabilities=capabilities,
                 contributes={**base["contributes"], "server": {"module": "server", "routes": routes}}, **overrides)


def png(color=(0, 200, 0, 255), size=(16, 16)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return buffer.getvalue()


def project_with_image(name="服务端测试", body: bytes | None = None):
    created = create_canvas_project(name)
    document = read_canvas_document(created.project_id)
    version, saved, _ = save_canvas_upload(
        created.project_id, "a.png", "png", body or png(), "image", document.revision,
        node_factory=lambda v: _media_node("image", "image-1", "角色", {"x": 0, "y": 0}, v.version_id))
    return created.project_id, version.version_id, saved


def add_plugin_node(project_id, document, *, connect=True, plugin_id="demo", node_id="sheet-1"):
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": node_id, "type": "plugin", "title": "演示", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 320, "height": 240},
        "data": {"plugin_id": plugin_id, "node_type": "demo", "plugin_version": "1.0.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    if connect:
        raw["connections"].append({"id": f"c-{node_id}", "role": "input", "source_node_id": "image-1",
                                   "target_node_id": node_id})
    return save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    yield path
    plugin_server.unload("demo")
    plugin_server.unload("sprite-sheet")


@pytest.fixture
def client(root, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


@pytest.fixture
def ready(root):
    """已启用、已批准、节点连着一张图的完整场景。"""
    demo(root)
    plugin_registry.set_enabled("demo", True)
    project_id, version_id, document = project_with_image()
    add_plugin_node(project_id, document)
    plugin_grants.grant(project_id, "demo")
    return project_id, version_id


def post(client, route, project_id, *, node_id="sheet-1", inputs=(), params=None, plugin="demo"):
    return client.post(f"/api/plugins/{plugin}/routes/{route}", json={
        "project_id": project_id, "node_id": node_id, "inputs": list(inputs), "params": params or {}})


def test_server_module_is_imported_on_first_call_and_unloaded_on_disable(client, ready):
    project_id, version_id = ready
    assert MODULE not in sys.modules
    assert client.get("/api/plugins").status_code == 200
    assert MODULE not in sys.modules, "列出插件不应加载服务端模块"
    assert post(client, "echo", project_id, inputs=[version_id]).status_code == 200
    assert MODULE in sys.modules
    assert client.post("/api/plugins/demo/disable", json={}).status_code == 200
    assert MODULE not in sys.modules


def test_happy_path_resolves_connected_input_without_leaking_paths(client, ready):
    project_id, version_id = ready
    response = post(client, "echo", project_id, inputs=[version_id], params={"a": 1})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["params"] == {"a": 1} and result["origin"] == "surface" and result["node_id"] == "sheet-1"
    assert result["inputs"] == [{"title": "角色", "size": [16, 16], "exists": True}]
    assert "uploads" not in response.text and "canvases" not in response.text


def test_handlers_run_off_the_event_loop(client, ready):
    project_id, _ = ready
    assert post(client, "echo", project_id).json()["result"]["on_event_loop"] is False


def test_capability_follows_the_manifest(root):
    demo(root)
    assert local_capability("POST", "/api/plugins/demo/routes/echo") is None, "未启用时不可达"
    plugin_registry.set_enabled("demo", True)
    assert local_capability("POST", "/api/plugins/demo/routes/echo") == "read"
    assert local_capability("POST", "/api/plugins/demo/routes/make") == "edit"
    assert local_capability("POST", "/api/plugins/demo/routes/undeclared") is None
    assert local_capability("POST", "/api/plugins/demo/routes/echo/../make") is None
    assert local_capability("GET", "/api/plugins/demo/routes/echo") is None
    assert local_capability("POST", "/api/plugins/ghost/routes/echo") is None


def test_disabled_plugin_and_undeclared_route_are_forbidden(client, root):
    demo(root)
    project_id, version_id, document = project_with_image()
    add_plugin_node(project_id, document, connect=False)
    assert post(client, "echo", project_id).status_code == 403
    plugin_registry.set_enabled("demo", True)
    assert post(client, "nothing", project_id).status_code == 403
    assert MODULE not in sys.modules


def test_ungranted_project_is_refused_before_any_plugin_code_runs(client, root):
    demo(root)
    plugin_registry.set_enabled("demo", True)
    project_id, version_id, document = project_with_image()
    add_plugin_node(project_id, document)
    response = post(client, "echo", project_id, inputs=[version_id])
    assert response.status_code == 403 and response.json()["detail"]["code"] == "PLUGIN_NOT_GRANTED"
    assert MODULE not in sys.modules


def test_grant_in_one_project_does_not_cover_another(client, ready):
    other, other_version, document = project_with_image("另一个项目")
    add_plugin_node(other, document)
    response = post(client, "echo", other, inputs=[other_version])
    assert response.status_code == 403 and response.json()["detail"]["code"] == "PLUGIN_NOT_GRANTED"


def test_surface_needs_the_server_call_capability(client, root):
    demo(root, capabilities=["node.read_self", "resource.read_inputs"])
    plugin_registry.set_enabled("demo", True)
    project_id, version_id, document = project_with_image()
    add_plugin_node(project_id, document)
    plugin_grants.grant(project_id, "demo")
    response = post(client, "echo", project_id)
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CAPABILITY_DENIED"


def test_inputs_must_be_connected_to_the_calling_node(client, ready):
    project_id, version_id = ready
    other, other_version, _ = project_with_image("另一个项目")
    # 另一个项目的版本
    cross = post(client, "echo", project_id, inputs=[other_version])
    assert cross.status_code == 403 and cross.json()["detail"]["code"] == "INVALID_HANDLE"
    # 同项目里存在、但没连到这个节点的图
    document = read_canvas_document(project_id)
    loose, saved, _ = save_canvas_upload(
        project_id, "b.png", "png", png((0, 0, 255, 255)), "image", document.revision,
        node_factory=lambda v: _media_node("image", "image-2", "没连的", {"x": 0, "y": 300}, v.version_id))
    unconnected = post(client, "echo", project_id, inputs=[loose.version_id])
    assert unconnected.status_code == 403 and unconnected.json()["detail"]["code"] == "INVALID_HANDLE"
    for bogus in ("../../.config/keys.json", "", "version-nope"):
        assert post(client, "echo", project_id, inputs=[bogus]).status_code == 403


def test_node_must_be_this_plugins_node(client, ready):
    project_id, version_id = ready
    for node_id in ("image-1", "ghost"):
        response = post(client, "echo", project_id, node_id=node_id, inputs=[version_id])
        assert response.status_code == 403 and response.json()["detail"]["code"] == "INVALID_TARGET"


def test_another_plugins_node_is_rejected(client, ready, root):
    project_id, version_id = ready
    document = read_canvas_document(project_id)
    add_plugin_node(project_id, document, connect=False, plugin_id="someone-else", node_id="theirs")
    response = post(client, "echo", project_id, node_id="theirs")
    assert response.status_code == 403 and response.json()["detail"]["code"] == "INVALID_TARGET"


def test_surface_cannot_read_arbitrary_nodes(client, ready):
    project_id, _ = ready
    response = post(client, "peek", project_id, params={"image_node_id": "image-1"})
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CAPABILITY_DENIED"


def test_create_image_adds_a_plain_image_node(client, ready):
    project_id, version_id = ready
    before = read_canvas_document(project_id)
    response = post(client, "make", project_id, inputs=[version_id])
    assert response.status_code == 200, response.text
    after = read_canvas_document(project_id)
    created = next(node for node in after.nodes if node.id == response.json()["result"]["node_id"])
    assert created.type == "image" and created.title == "结果"
    assert created.position.x == 400 + 320 + 60
    assert after.content_versions[created.data.current_version_id].kind == "image"
    assert len(after.nodes) == len(before.nodes) + 1 and after.connections == before.connections


def test_create_image_needs_its_capability(client, root):
    demo(root, capabilities=["node.read_self", "server.call"])
    plugin_registry.set_enabled("demo", True)
    project_id, version_id, document = project_with_image()
    add_plugin_node(project_id, document)
    plugin_grants.grant(project_id, "demo")
    before = len(read_canvas_document(project_id).nodes)
    response = post(client, "make", project_id)
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CAPABILITY_DENIED"
    assert len(read_canvas_document(project_id).nodes) == before


def test_handler_errors_do_not_leak_details(client, ready):
    project_id, _ = ready
    crashed = post(client, "boom", project_id)
    assert crashed.status_code == 500
    assert crashed.json()["detail"] == {"message": "插件处理失败", "code": "PLUGIN_FAILED"}
    invalid = post(client, "invalid", project_id)
    assert invalid.status_code == 422 and invalid.json()["detail"]["message"] == "列数必须大于 0"


def test_request_body_is_strict(client, ready):
    project_id, _ = ready
    response = client.post("/api/plugins/demo/routes/echo", json={
        "project_id": project_id, "node_id": "sheet-1", "inputs": [], "params": {}, "path": "/etc/passwd"})
    assert response.status_code == 422


def test_broken_server_module_fails_closed(client, root):
    demo(root, source="raise RuntimeError('import-time failure')")
    plugin_registry.set_enabled("demo", True)
    project_id, _, document = project_with_image()
    add_plugin_node(project_id, document)
    plugin_grants.grant(project_id, "demo")
    response = post(client, "echo", project_id)
    assert response.status_code == 500 and response.json()["detail"]["code"] == "PLUGIN_BROKEN"
    assert MODULE not in sys.modules


def test_updated_plugin_reloads_its_server_module(client, ready, root):
    project_id, _ = ready
    assert post(client, "echo", project_id).json()["result"]["origin"] == "surface"
    demo(root, version="1.1.0", source=SERVER.replace('"origin": ctx.origin', '"origin": "v2"'))
    assert post(client, "echo", project_id).json()["result"]["origin"] == "v2"


# ── Agent 工具：用真实的精灵表调整插件 ──────────────────────────────────────────

def sprite_strip() -> bytes:
    image = Image.new("RGBA", (64, 16), (0, 0, 0, 0))
    for index in range(4):
        image.paste(Image.new("RGBA", (8, 12), (229, 83, 75, 255)), (index * 16 + 4, 2))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def sprite(root):
    shutil.copytree(REPO / "plugins" / "sprite-sheet", root / "sprite-sheet",
                    ignore=shutil.ignore_patterns("__pycache__", "tests", "ui"))
    project_id, _, _ = project_with_image("精灵表", sprite_strip())
    return project_id


def test_plugin_tools_follow_enablement(sprite):
    assert runtime.plugin_tools() == {}
    names = [tool.name for tool in runtime.build_tools()]
    assert not any(name.startswith("plugin_") for name in names)
    plugin_registry.set_enabled("sprite-sheet", True)
    assert set(runtime.plugin_tools()) == {"plugin_sprite_sheet_detect", "plugin_sprite_sheet_repack"}
    names = [tool.name for tool in runtime.build_tools()]
    assert "plugin_sprite_sheet_detect" in names and "get_canvas" in names
    assert "atelier_plugin_sprite_sheet" not in sys.modules, "组装工具列表只读清单"


def test_read_only_plugin_tool_skips_confirmation_and_write_tool_follows_the_mode(sprite):
    plugin_registry.set_enabled("sprite-sheet", True)
    assert runtime.needs_confirmation("plugin_sprite_sheet_detect", "review") is False
    assert runtime.needs_confirmation("plugin_sprite_sheet_repack", "review") is True
    assert runtime.needs_confirmation("plugin_sprite_sheet_repack", "auto") is False
    assert runtime.needs_confirmation("plugin_unknown_tool", "review") is True


def test_agent_tool_requires_project_grant(sprite):
    plugin_registry.set_enabled("sprite-sheet", True)
    text, created = runtime.run_tool_safely(sprite, "plugin_sprite_sheet_detect", {"image_node_id": "image-1"})
    assert "PLUGIN_NOT_GRANTED" in text and created == []


def test_agent_detects_and_repacks(sprite):
    plugin_registry.set_enabled("sprite-sheet", True)
    plugin_grants.grant(sprite, "sprite-sheet")
    result, created = runtime.execute_tool(sprite, "plugin_sprite_sheet_detect", {"image_node_id": "image-1"})
    assert (result["columns"], result["rows"], len(result["frames"])) == (4, 1, 4) and created == []
    result, created = runtime.execute_tool(
        sprite, "plugin_sprite_sheet_repack", {"image_node_id": "image-1", "columns": 2, "spacing": 1})
    assert result["meta"]["size"] == {"w": 8 + 1 + 8, "h": 12 + 1 + 12}
    document = read_canvas_document(sprite)
    node = next(item for item in document.nodes if item.id == created[0])
    assert node.type == "image" and node.title == "角色 精灵表"


def test_repack_can_put_frame_data_on_the_canvas_as_a_text_node(sprite):
    plugin_registry.set_enabled("sprite-sheet", True)
    plugin_grants.grant(sprite, "sprite-sheet")
    result, created = runtime.execute_tool(
        sprite, "plugin_sprite_sheet_repack", {"image_node_id": "image-1", "columns": 4, "frame_data": True})
    assert len(created) == 2 and result["frame_data_node_id"] == created[1]
    document = read_canvas_document(sprite)
    text_node = next(item for item in document.nodes if item.id == created[1])
    assert text_node.type == "text" and text_node.title == "角色 帧数据"
    import json as _json
    data = _json.loads(document.content_versions[text_node.data.current_version_id].text)
    assert len(data["frames"]) == 4 and data["meta"]["columns"] == 4
    assert data["frames"][0] == {"x": 0, "y": 0, "w": 8, "h": 12, "anchor_x": 4, "anchor_y": 12}


def test_surface_repack_end_to_end_through_the_route(client, sprite):
    """界面那条路：经分发路由调用 /detect 与 /repack，素材由服务端按连线核对。"""
    plugin_registry.set_enabled("sprite-sheet", True)
    document = read_canvas_document(sprite)
    version_id = next(node for node in document.nodes if node.id == "image-1").data.current_version_id
    raw = document.model_dump(mode="json")
    raw["nodes"].append({
        "id": "sheet-1", "type": "plugin", "title": "精灵表", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 360, "height": 300},
        "data": {"plugin_id": "sprite-sheet", "node_type": "sheet", "plugin_version": "0.1.0",
                 "data_schema_version": 1, "payload": {}, "generation_draft": None}})
    raw["connections"].append({"id": "c1", "role": "input", "source_node_id": "image-1", "target_node_id": "sheet-1"})
    save_canvas_document(sprite, CanvasDocument.model_validate(raw), document.revision)
    plugin_grants.grant(sprite, "sprite-sheet")
    found = post(client, "detect", sprite, inputs=[version_id], plugin="sprite-sheet")
    assert found.status_code == 200, found.text
    frames = found.json()["result"]["frames"]
    assert len(frames) == 4
    placed = post(client, "repack", sprite, inputs=[version_id], plugin="sprite-sheet",
                  params={"frames": frames, "columns": 2, "spacing": 1, "align": "center", "frame_data": True})
    assert placed.status_code == 200, placed.text
    after = read_canvas_document(sprite)
    kinds = {node.id: node.type for node in after.nodes}
    assert kinds[placed.json()["result"]["node_id"]] == "image"
    assert kinds[placed.json()["result"]["frame_data_node_id"]] == "text"
    # 没连图就调用：服务端给出用户看得懂的原因。
    empty = post(client, "detect", sprite, plugin="sprite-sheet")
    assert empty.status_code == 422 and empty.json()["detail"]["message"] == "请先连接一张图片"


def test_agent_tool_errors_become_text(sprite):
    plugin_registry.set_enabled("sprite-sheet", True)
    plugin_grants.grant(sprite, "sprite-sheet")
    text, _ = runtime.run_tool_safely(sprite, "plugin_sprite_sheet_detect", {"image_node_id": "nope"})
    assert "找不到这张图片" in text
    text, _ = runtime.run_tool_safely(sprite, "plugin_sprite_sheet_repack", {"image_node_id": "image-1", "columns": 0})
    assert "排布参数不对" in text
    plugin_registry.set_enabled("sprite-sheet", False)
    text, _ = runtime.run_tool_safely(sprite, "plugin_sprite_sheet_detect", {"image_node_id": "image-1"})
    assert "未知工具" in text


def test_agent_call_does_not_run_on_the_event_loop_thread(sprite):
    """Agent 工具经 asyncio.to_thread 执行；这里确认直接调用路径本身不依赖事件循环。"""
    plugin_registry.set_enabled("sprite-sheet", True)
    plugin_grants.grant(sprite, "sprite-sheet")
    seen = {}

    def work():
        seen["thread"] = threading.current_thread().name
        seen["result"] = runtime.execute_tool(sprite, "plugin_sprite_sheet_detect", {"image_node_id": "image-1"})[0]

    async def main():
        await asyncio.to_thread(work)
    asyncio.run(main())
    assert len(seen["result"]["frames"]) == 4 and seen["thread"] != threading.main_thread().name
