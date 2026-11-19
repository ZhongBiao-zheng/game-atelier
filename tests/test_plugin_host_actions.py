"""宿主插件的调用型动作、画布入口与项目状态（ADR-0041）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from character_workflow.lib import plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    canvas_project_dir, create_canvas_project, read_canvas_document, save_canvas_upload,
)
from character_workflow.lib.plugin_manifest import PluginManifest
from tests.plugin_fixtures import manifest, use_plugins_root, write_plugin
from tests.test_plugin_server import png

HOST_ID = "hostdemo"
HOST_SHAPE = {"ui": None, "capabilities": [], "runtime": "host"}
SERVER = '''
import io
from PIL import Image

def register(api):
    @api.route("POST", "/make")
    def make(ctx, params):
        buffer = io.BytesIO(); Image.new("RGBA", (30, 20), (1, 2, 3, 255)).save(buffer, "PNG")
        return ctx.create_image(buffer.getvalue(), "宿主图片")

    @api.route("POST", "/peek")
    def peek(ctx, params):
        media = ctx.image_of_node(params["node_id"])
        return {"title": media.title, "version_id": media.version_id, "exists": media.path.is_file()}

    @api.route("POST", "/remember")
    def remember(ctx, params):
        def add(data):
            data = dict(data or {})
            data[params["key"]] = params["value"]
            return data
        ctx.update_state(add)
        return {"state": ctx.read_state()}

    @api.route("POST", "/read")
    def read(ctx, params):
        return {"state": ctx.read_state()}
'''
ROUTES = [{"method": "POST", "path": path, "access": access}
          for path, access in (("/make", "edit"), ("/peek", "read"), ("/remember", "edit"), ("/read", "read"))]
HOST_CONTRIBUTES = {
    "image_actions": [{"id": "send", "label": "发出去", "icon": "grid", "action": {"kind": "host_call"}}],
    "canvas_actions": [{"id": "fetch", "label": "取回来", "icon": "grid", "action": {"kind": "host_call"}}],
    "server": {"module": "server", "routes": ROUTES},
}


def host_manifest(**contributes) -> dict:
    return manifest(HOST_ID, **HOST_SHAPE, contributes={**HOST_CONTRIBUTES, **contributes})


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / "plugins"
    use_plugins_root(monkeypatch, root)
    monkeypatch.setattr(plugin_registry, "HOST_PLUGIN_IDS", plugin_registry.HOST_PLUGIN_IDS | {HOST_ID})
    write_plugin(root, HOST_ID, files={}, server_source=SERVER, **HOST_SHAPE, contributes=HOST_CONTRIBUTES)
    plugin_registry.set_enabled(HOST_ID, True)
    yield root
    plugin_server.unload(HOST_ID)


def call(project_id: str, path: str, params: dict | None = None, origin: str = "host") -> dict:
    result, _ = plugin_server.call(HOST_ID, "POST", path, project_id=project_id, origin=origin, params=params)
    return result


def project_with_image() -> tuple[str, str]:
    project_id = create_canvas_project("宿主动作").project_id
    document = read_canvas_document(project_id)
    version, _, _ = save_canvas_upload(
        project_id, "a.png", "png", png(), "image", document.revision,
        node_factory=lambda v: _media_node("image", "image-1", "原图", {"x": 0, "y": 0}, v.version_id))
    return project_id, version.version_id


# ── 清单 ─────────────────────────────────────────────────────────────


def test_host_plugin_declares_host_call_image_actions_and_canvas_actions():
    parsed = PluginManifest.model_validate(host_manifest())
    assert parsed.contributes.image_actions[0].action.kind == "host_call"
    assert [action.id for action in parsed.contributes.canvas_actions] == ["fetch"]


@pytest.mark.parametrize("contributes", [
    {"image_actions": [{"id": "send", "label": "发", "icon": "grid", "action": {"kind": "host_call"}}]},
    {"canvas_actions": [{"id": "fetch", "label": "取", "icon": "grid", "action": {"kind": "host_call"}}]},
])
def test_sandbox_plugin_cannot_declare_host_only_entries(contributes):
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(manifest(contributes={**manifest()["contributes"], **contributes}))


@pytest.mark.parametrize("field", ["text_actions", "video_actions"])
def test_host_call_is_only_implemented_on_the_image_toolbar(field):
    action = {"id": "send", "label": "发", "icon": "grid", "action": {"kind": "host_call"}}
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(host_manifest(**{field: [action]}))


def test_canvas_action_ids_are_unique_and_only_call_the_plugin():
    fetch = HOST_CONTRIBUTES["canvas_actions"][0]
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(host_manifest(canvas_actions=[fetch, fetch]))
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(host_manifest(canvas_actions=[
            {**fetch, "action": {"kind": "create_node", "node_type": "x"}}]))


# ── 宿主入口的 ctx ───────────────────────────────────────────────────


def test_host_entry_creates_image_nodes_without_a_project_grant(host):
    project_id, _ = project_with_image()
    node_id = call(project_id, "/make")["node_id"]
    node = next(item for item in read_canvas_document(project_id).nodes if item.id == node_id)
    assert node.type == "image" and node.title == "宿主图片" and node.data.current_version_id


def test_host_entry_reads_any_image_in_the_project_by_node_id(host):
    project_id, version_id = project_with_image()
    assert call(project_id, "/peek", {"node_id": "image-1"}) == {
        "title": "原图", "version_id": version_id, "exists": True}
    with pytest.raises(plugin_server.PluginError) as missing:
        call(project_id, "/peek", {"node_id": "image-404"})
    assert missing.value.code == "INVALID_TARGET"


# ── 项目状态 ─────────────────────────────────────────────────────────


def _state_file(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "plugins" / HOST_ID / "state.json"


def test_host_plugin_state_is_read_modify_written_inside_the_project(host):
    project_id, _ = project_with_image()
    assert call(project_id, "/read") == {"state": None}
    assert call(project_id, "/remember", {"key": "a", "value": 1}) == {"state": {"a": 1}}
    assert call(project_id, "/remember", {"key": "b", "value": "图"}) == {"state": {"a": 1, "b": "图"}}
    saved = json.loads(_state_file(project_id).read_text(encoding="utf-8"))
    assert saved["plugin_id"] == HOST_ID and saved["revision"] == 2 and saved["plugin_version"] == "1.0.0"
    assert saved["data"] == {"a": 1, "b": "图"}


def test_plugin_state_over_one_mib_is_refused_and_nothing_is_written(host):
    project_id, _ = project_with_image()
    with pytest.raises(plugin_server.PluginError) as too_big:
        call(project_id, "/remember", {"key": "big", "value": "x" * (1024 * 1024)})
    assert too_big.value.status == 413
    assert not _state_file(project_id).exists()


def test_broken_plugin_state_is_an_error_not_an_empty_state(host):
    project_id, _ = project_with_image()
    path = _state_file(project_id)
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(plugin_server.PluginError) as broken:
        call(project_id, "/read")
    assert broken.value.code == "PLUGIN_STATE_BROKEN" and broken.value.status == 500
    assert path.read_text(encoding="utf-8") == "{not json"


def test_only_the_host_entry_can_touch_plugin_state(host):
    project_id, _ = project_with_image()
    request = plugin_server.PluginRequest(HOST_ID, project_id, "agent", frozenset())
    with pytest.raises(plugin_server.PluginError) as denied:
        request.read_state()
    assert denied.value.code == "CAPABILITY_DENIED"
    with pytest.raises(plugin_server.PluginError):
        request.update_state(lambda data: {"x": 1})
