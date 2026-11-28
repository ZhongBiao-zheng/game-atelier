"""宿主插件的 Agent 工具、仅 Agent 可调的路由、藏起工具、每次确认、预览图（ADR-0043）。

用一个临时目录里的演示宿主插件测平台行为，不依赖 PS 联动。
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib import data_root, plugin_registry, plugin_server
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.plugin_manifest import PluginManifest
from character_workflow.lib.private_json import read_private_json
from tests.canvas_agent_approval_helpers import confirmation_required
from tests.local_client import LocalTestClient
from tests.plugin_fixtures import manifest, use_plugins_root, write_plugin
from viewer_server.server_app import build_app

PLUGIN_ID = "agentdemo"
RUN = "plugin_agentdemo_run"
LOOK = "plugin_agentdemo_look"
SERVER = '''
import base64
from character_workflow.lib import data_root

def register(api):
    @api.hidden_agent_tools
    def hidden():
        marker = data_root.config_dir() / "agentdemo-hide"
        if marker.exists() and marker.read_text() == "boom":
            raise RuntimeError("broken filter")
        return {"run"} if marker.exists() else set()

    @api.route("POST", "/look")
    def look(ctx, params):
        jpeg = base64.b64encode(b"\\xff\\xd8\\xff\\xe0look").decode()
        return {"caller": ctx.caller, "preview": {"mime_type": "image/jpeg", "data_base64": jpeg}}

    @api.route("POST", "/run")
    def run(ctx, params):
        return {"ran": params.get("code"), "caller": ctx.caller}
'''
CONTRIBUTES = {
    "server": {"module": "server", "routes": [
        {"method": "POST", "path": "/look", "access": "read"},
        {"method": "POST", "path": "/run", "access": "edit", "agent_only": True},
    ]},
    "agent_tools": [
        {"name": "look", "description": "看一眼", "parameters": {"type": "object", "properties": {}},
         "read_only": True, "route": "/look"},
        {"name": "run", "description": "执行", "parameters": {"type": "object", "properties": {"code": {"type": "string"}}},
         "read_only": False, "route": "/run", "always_confirm": True, "summary_field": "code"},
    ],
}
HOST_SHAPE = {"ui": None, "capabilities": [], "runtime": "host"}


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / "plugins"
    use_plugins_root(monkeypatch, root)
    monkeypatch.setattr(plugin_registry, "HOST_PLUGIN_IDS", plugin_registry.HOST_PLUGIN_IDS | {PLUGIN_ID})
    write_plugin(root, PLUGIN_ID, files={}, server_source=SERVER, **HOST_SHAPE, contributes=CONTRIBUTES)
    plugin_registry.set_enabled(PLUGIN_ID, True)
    yield root
    plugin_server.unload(PLUGIN_ID)


def hide(value: str | None) -> None:
    marker = data_root.config_dir() / "agentdemo-hide"
    marker.parent.mkdir(parents=True, exist_ok=True)
    if value is None:
        marker.unlink(missing_ok=True)
    else:
        marker.write_text(value, encoding="utf-8")


# ── 清单 ─────────────────────────────────────────────────────────────


def test_host_plugins_may_declare_agent_tools():
    PluginManifest.model_validate(manifest(PLUGIN_ID, **HOST_SHAPE, contributes=CONTRIBUTES))


@pytest.mark.parametrize("change", ["agent_only", "always_confirm", "summary_field"])
def test_host_only_agent_fields_are_rejected_on_sandbox_plugins(change):
    contributes = {
        **manifest()["contributes"],
        "server": {"module": "server", "routes": [
            {"method": "POST", "path": "/run", "access": "edit", "agent_only": change == "agent_only"}]},
        "agent_tools": [{"name": "run", "description": "执行", "parameters": {}, "read_only": False, "route": "/run",
                         "always_confirm": change == "always_confirm",
                         "summary_field": "code" if change == "summary_field" else None}],
    }
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(manifest(contributes=contributes))


# ── 工具列表与藏起 ───────────────────────────────────────────────────


def test_hidden_tools_are_left_out_and_a_broken_filter_hides_all(host):
    assert {LOOK, RUN} <= set(runtime.plugin_tools())
    hide("on")
    assert LOOK in runtime.plugin_tools() and RUN not in runtime.plugin_tools()
    hide("boom")
    assert not {LOOK, RUN} & set(runtime.plugin_tools())
    hide(None)
    assert RUN in runtime.plugin_tools()


def test_a_hidden_tool_cannot_be_called_by_the_canvas_agent(host):
    hide("on")
    project_id = create_canvas_project("宿主工具").project_id
    with pytest.raises(CanvasToolError):
        runtime._execute_plugin_tool(project_id, RUN, {"code": "x"})


# ── 仅 Agent 路由 ────────────────────────────────────────────────────


def test_agent_only_routes_are_invisible_to_the_browser_entry(host, tmp_path):
    project_id = create_canvas_project("宿主工具").project_id
    assert plugin_server.declared_access(PLUGIN_ID, "POST", "/run") is None
    assert plugin_server.declared_access(PLUGIN_ID, "POST", "/look") == "read"
    with pytest.raises(plugin_server.PluginError) as host_entry:
        plugin_server.call(PLUGIN_ID, "POST", "/run", project_id=project_id, origin="host", params={})
    assert host_entry.value.code == "CAPABILITY_DENIED"
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    response = client.post(f"/api/plugins/{PLUGIN_ID}/routes/run", json={"project_id": project_id, "params": {}})
    assert response.status_code == 403
    result, _ = plugin_server.call(PLUGIN_ID, "POST", "/run", project_id=project_id, origin="agent",
                                   params={"code": "x"}, caller="画布 Agent")
    assert result == {"ran": "x", "caller": "画布 Agent"}


# ── 每次确认与预览图 ─────────────────────────────────────────────────


def test_always_confirm_tools_ask_even_in_auto_mode_and_show_the_field(host):
    project_id = create_canvas_project("宿主工具").project_id
    assert confirmation_required(project_id, RUN, {"code": "a\n  b"}, "auto") is True
    assert confirmation_required(project_id, LOOK, {}, "auto") is False
    assert runtime.summarize_call(RUN, {"code": "a\n  b"}) == "（插件：演示插件）执行\na\n  b"


def test_a_preview_in_a_plugin_tool_result_is_attached_as_an_image(host):
    project_id = create_canvas_project("宿主工具").project_id
    result, _ = runtime._execute_plugin_tool(project_id, LOOK, {})
    assert "preview" not in result and result["caller"] == "画布 Agent"
    (ref,) = result[vision.ATTACH_KEY]
    assert vision.preview_data_url(ref).startswith("data:image/jpeg;base64,")


# ── canvas-agent 插件工具接口 ─────────────────────────────────────────


def test_plugin_tool_endpoints_refuse_browser_sessions_and_unlisted_plugins(host, tmp_path):
    project_id = create_canvas_project("宿主工具").project_id
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    assert client.post("/api/canvas-agent/plugin-tools", json={}).status_code == 403
    store = client.app.state.connection_store
    store.enable_agent("http://127.0.0.1")
    credential = read_private_json(data_root.agent_credential_file())
    anonymous = LocalTestClient.__mro__[1](client.app, base_url="http://127.0.0.1")
    session = anonymous.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"], "instance_id": store.instance_id})
    headers = {"Authorization": f"Bearer {session.json()['session_token']}", "Content-Type": "application/json"}
    listed = anonymous.post("/api/canvas-agent/plugin-tools", json={}, headers=headers)
    assert listed.status_code == 200 and listed.json()["tools"] == []
    called = anonymous.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/look",
                            json={"project_id": project_id, "arguments": {}}, headers=headers)
    assert called.status_code == 404


def test_a_rejected_always_confirm_call_never_runs_and_the_model_hears_it(host):
    from character_workflow.lib.canvas_agent_sessions import create_canvas_agent_session, mutate_canvas_agent_session
    from character_workflow.lib.schemas import CanvasAgentApproval
    project_id = create_canvas_project("宿主工具").project_id
    session = create_canvas_agent_session(project_id, "拒绝")
    approval = CanvasAgentApproval(call_id="call-run", tool=RUN, arguments='{"code": "app.quit()"}',
                                   summary=runtime.summarize_call(RUN, {"code": "app.quit()"}))
    mutate_canvas_agent_session(project_id, session.session_id, lambda current, now: {
        "status": "awaiting_approval", "pending_approvals": [approval]})
    from unittest import mock
    with mock.patch.object(plugin_server, "call", wraps=plugin_server.call) as call:
        done = runtime.resolve_approvals(project_id, session.session_id, {"call-run": False})
    call.assert_not_called()
    assert done.history[-1] == {"type": "function_call_output", "call_id": "call-run", "output": "用户拒绝了这个操作。"}
    assert done.messages[-1].text.startswith("已拒绝\n（插件：演示插件）执行\napp.quit()")


def test_a_browser_session_cannot_call_a_plugin_tool_through_the_canvas_agent_entry(host, tmp_path):
    project_id = create_canvas_project("宿主工具").project_id
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    response = client.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/run",
                           json={"project_id": project_id, "arguments": {"code": "x"}})
    assert response.status_code == 403


def _png_preview(data: bytes) -> dict:
    import base64
    return {"mime_type": "image/png", "data_base64": base64.b64encode(data).decode()}


def test_agent_images_are_capped_by_count_and_bytes(isolated_data_root, monkeypatch):
    import os
    monkeypatch.setattr(vision, "MAX_PREVIEWS", 3)
    monkeypatch.setattr(vision, "MAX_PREVIEW_TOTAL", 25)
    # 同一时刻连续写入（Windows 上 mtime 刻度粗时就是这样）：时钟停住，每张写完把所有文件 mtime 拉成一样。
    frozen = 1_800_000_000_000_000_000
    monkeypatch.setattr(vision.time, "time_ns", lambda: frozen)
    monkeypatch.setattr(vision, "_last_preview_seq", 0)
    directory = data_root.runtime_dir() / "agent-images"
    refs = []
    for _ in range(5):
        refs.append(vision.store_preview(_png_preview(b"x" * 10)))
        for path in directory.iterdir():
            os.utime(path, ns=(frozen, frozen))
    files = sorted(path.name for path in directory.iterdir())
    assert len(files) == 2  # 每张 10 字节，总量上限 25：最多留两张
    assert {ref.removeprefix(vision.PREVIEW_PREFIX) for ref in refs[-2:]} == set(files)
    (directory / "keys.json").write_text("{}", encoding="utf-8")
    vision.store_preview(_png_preview(b"y"))
    assert not (directory / "keys.json").exists(), "目录里只留服务端生成的文件名"


def test_agent_images_expire_after_a_day_by_their_write_order_not_file_times(isolated_data_root, monkeypatch):
    import os
    now = [1_800_000_000_000_000_000]
    monkeypatch.setattr(vision.time, "time_ns", lambda: now[0])
    monkeypatch.setattr(vision, "_last_preview_seq", 0)
    old = vision.store_preview(_png_preview(b"old"))
    now[0] += vision.PREVIEW_TTL_S * 1_000_000_000 - 1
    recent = vision.store_preview(_png_preview(b"recent"))
    directory = data_root.runtime_dir() / "agent-images"
    for path in directory.iterdir():
        os.utime(path, ns=(now[0], now[0]))  # 文件时间一律「刚写」，过期只看写入序号
    now[0] += 2
    vision.store_preview(_png_preview(b"new"))
    assert vision.preview_data_url(old) is None
    assert vision.preview_data_url(recent) is not None
