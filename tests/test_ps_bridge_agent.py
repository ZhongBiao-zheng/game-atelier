"""PS 联动第 2 批：Agent 通道（ADR-0043）。执行器换成假实现，不碰真实 Photoshop。"""
from __future__ import annotations

import base64
import io
import sys

import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib import data_root, plugin_server
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.private_json import read_private_json
from tests.local_client import LocalTestClient
from tests.test_ps_bridge_plugin import PLUGIN_ID, ps  # noqa: F401  (fixture)
from viewer_server.server_app import build_app

EXECUTE = "plugin_ps_bridge_execute"
SCRIPT = "var doc = app.activeDocument;\nreturn {name: doc.name};"


def _png(size=(64, 48)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def agent_ps(ps, monkeypatch):  # noqa: F811
    """在第 1 批的假 Photoshop 上加 inspect / preview / execute 三个动作。"""
    original = ps.call

    def call(request_dir, config, timeout_s):
        action = config["action"]
        if action in ("inspect", "execute"):
            ps.calls.append(dict(config))
            if ps.failure is not None:
                return ps.failure
            state = {"ok": True, "version": "26.0.0", "documents": [{"id": 7, "name": "海报.psd"}],
                     "active_document": "海报.psd", "active_document_id": 7, "layers": [], "layers_truncated": False}
            return {**state, "value": {"name": "海报.psd"}} if action == "execute" else state
        if action == "preview":
            ps.calls.append(dict(config))
            with open(config["out_png"], "wb") as handle:
                handle.write(_png())
            return {"ok": True, "document": {"id": 7, "name": "海报.psd"}}
        return original(request_dir, config, timeout_s)

    monkeypatch.setattr(ps, "call", call)
    return ps


def agent_module():
    return sys.modules[f"{plugin_server._module_name(PLUGIN_ID)}.agent"]


def allow_scripts(allowed: bool) -> None:
    plugin_server.call(PLUGIN_ID, "POST", "/settings", project_id=None, origin="host",
                       params={"allow_scripts": allowed})


def run_tool(project_id: str, tool: str, arguments: dict) -> dict:
    result, _ = runtime._execute_plugin_tool(project_id, tool, arguments)
    return result


# ── 开关与工具列表 ───────────────────────────────────────────────────


def test_execute_is_hidden_until_scripts_are_allowed(agent_ps):
    names = set(runtime.plugin_tools())
    assert {"plugin_ps_bridge_inspect", "plugin_ps_bridge_import", "plugin_ps_bridge_place",
            "plugin_ps_bridge_preview"} <= names
    assert EXECUTE not in names
    project_id = create_canvas_project("PS").project_id
    with pytest.raises(CanvasToolError):
        run_tool(project_id, EXECUTE, {"code": SCRIPT})
    allow_scripts(True)
    assert {name for name in runtime.plugin_tools() if name.startswith("plugin_ps_bridge_")} == {
        "plugin_ps_bridge_inspect", "plugin_ps_bridge_import", "plugin_ps_bridge_place",
        "plugin_ps_bridge_preview", EXECUTE}
    allow_scripts(False)
    assert EXECUTE not in runtime.plugin_tools()


def test_the_switch_is_also_checked_inside_the_plugin(agent_ps):
    project_id = create_canvas_project("PS").project_id
    with pytest.raises(plugin_server.PluginError) as error:
        plugin_server.call(PLUGIN_ID, "POST", "/execute", project_id=project_id, origin="agent",
                           params={"code": SCRIPT})
    assert (error.value.code, error.value.status) == ("PS_SCRIPTS_DISABLED", 403)
    assert agent_ps.calls == []


# ── 执行、确认与日志 ─────────────────────────────────────────────────


def test_execute_always_needs_confirmation_and_shows_the_whole_script(agent_ps):
    allow_scripts(True)
    project_id = create_canvas_project("PS").project_id
    assert runtime.confirmation_required(project_id, EXECUTE, {"code": SCRIPT}, "auto") is True
    assert runtime.confirmation_required(project_id, "plugin_ps_bridge_import", {"scope": "merged"}, "auto") is False
    assert runtime.confirmation_required(project_id, "plugin_ps_bridge_inspect", {}, "review") is False
    summary = runtime.summarize_call(EXECUTE, {"code": SCRIPT})
    assert summary.endswith(SCRIPT) and summary.startswith("（插件：PS 联动）")


def test_execute_runs_the_script_and_logs_who_ran_what(agent_ps):
    allow_scripts(True)
    project_id = create_canvas_project("PS").project_id
    result = run_tool(project_id, EXECUTE, {"code": SCRIPT, "document_id": 7})
    assert result["value"] == {"name": "海报.psd"} and result["active_document"] == "海报.psd"
    assert agent_ps.calls[-1]["code"] == SCRIPT and agent_ps.calls[-1]["document_id"] == 7
    entry = agent_module().recent_log()[0]
    assert entry["caller"] == "画布 Agent" and entry["code"] == SCRIPT and entry["ok"] is True
    assert entry["project_id"] == project_id and entry["document_id"] == 7


def test_a_failed_script_is_logged_with_the_photoshop_error(agent_ps):
    allow_scripts(True)
    agent_ps.failure = {"ok": False, "error": "Error: ReferenceError: foo is undefined", "line": 2}
    project_id = create_canvas_project("PS").project_id
    with pytest.raises(CanvasToolError) as error:
        run_tool(project_id, EXECUTE, {"code": SCRIPT})
    assert "foo is undefined" in error.value.message and "第 2 行" in error.value.message
    entry = agent_module().recent_log()[0]
    assert entry["ok"] is False and "foo is undefined" in entry["error"]


def test_scripts_longer_than_the_confirm_card_are_refused(agent_ps):
    allow_scripts(True)
    project_id = create_canvas_project("PS").project_id
    with pytest.raises(CanvasToolError) as error:
        run_tool(project_id, EXECUTE, {"code": "x" * (agent_module().MAX_CODE_CHARS + 1)})
    assert error.value.status == 422 and agent_ps.calls == []


def test_execute_log_rotates_and_reads_newest_first(agent_ps, monkeypatch):
    module = agent_module()
    monkeypatch.setattr(module, "LOG_MAX_BYTES", 600)
    for index in range(12):
        module._append_log({"at": str(index), "code": "x" * 80})
    assert module._rotated().exists()
    assert [entry["at"] for entry in module.recent_log(3)] == ["11", "10", "9"]
    assert len(module.recent_log()) <= module.LOG_SHOWN


# ── 读文档与预览 ─────────────────────────────────────────────────────


def test_inspect_returns_documents_and_layers(agent_ps):
    project_id = create_canvas_project("PS").project_id
    result = run_tool(project_id, "plugin_ps_bridge_inspect", {})
    assert result["documents"] == [{"id": 7, "name": "海报.psd"}] and result["active_document_id"] == 7


def test_preview_reaches_the_model_as_an_attached_image(agent_ps):
    project_id = create_canvas_project("PS").project_id
    result = run_tool(project_id, "plugin_ps_bridge_preview", {"document_id": 7})
    assert "preview" not in result
    (ref,) = result[vision.ATTACH_KEY]
    assert ref.startswith(vision.PREVIEW_PREFIX)
    url = runtime._media_data_url(project_id, ref)
    assert url is not None and url.startswith("data:image/jpeg;base64,")
    with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as image:
        assert image.size == (64, 48)


def test_preview_refs_only_resolve_inside_the_preview_folder(isolated_data_root):
    assert vision.preview_data_url(vision.PREVIEW_PREFIX + "../keys.json") is None
    assert vision.preview_data_url(vision.PREVIEW_PREFIX + "0" * 32 + ".jpg") is None
    assert vision.store_preview({"mime_type": "text/html", "data_base64": "PGI+"}) is None


# ── 浏览器与外部 Agent 的入口 ─────────────────────────────────────────


def _client(tmp_path) -> LocalTestClient:
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def test_a_browser_session_cannot_reach_execute_by_any_path(agent_ps, tmp_path):
    allow_scripts(True)
    project_id = create_canvas_project("PS").project_id
    client = _client(tmp_path)
    via_plugin = client.post(f"/api/plugins/{PLUGIN_ID}/routes/execute",
                             json={"project_id": project_id, "params": {"code": SCRIPT}})
    assert via_plugin.status_code == 403
    via_canvas_agent = client.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/execute",
                                   json={"project_id": project_id, "arguments": {"code": SCRIPT}})
    assert via_canvas_agent.status_code == 403
    with pytest.raises(plugin_server.PluginError) as host_entry:
        plugin_server.call(PLUGIN_ID, "POST", "/execute", project_id=project_id, origin="host",
                           params={"code": SCRIPT})
    assert host_entry.value.code == "CAPABILITY_DENIED"
    assert agent_ps.calls == [] and agent_module().recent_log() == []


def _agent_headers(client: LocalTestClient) -> tuple[LocalTestClient, dict]:
    store = client.app.state.connection_store
    store.enable_agent("http://127.0.0.1")
    credential = read_private_json(data_root.agent_credential_file())
    anonymous = LocalTestClient.__mro__[1](client.app, base_url="http://127.0.0.1")
    session = anonymous.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": store.instance_id})
    assert session.status_code == 200, session.text
    return anonymous, {"Authorization": f"Bearer {session.json()['session_token']}",
                       "Content-Type": "application/json"}


def test_external_agents_list_and_call_ps_tools_with_their_grant(agent_ps, tmp_path):
    project_id = create_canvas_project("PS").project_id
    anonymous, headers = _agent_headers(_client(tmp_path))
    listed = anonymous.post("/api/canvas-agent/plugin-tools", json={}, headers=headers)
    assert listed.status_code == 200, listed.text
    assert {tool["tool"] for tool in listed.json()["tools"]} == {"inspect", "import", "place", "preview"}
    hidden = anonymous.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/execute",
                            json={"project_id": project_id, "arguments": {"code": SCRIPT}}, headers=headers)
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "TOOL_NOT_AVAILABLE"

    allow_scripts(True)
    listed = anonymous.post("/api/canvas-agent/plugin-tools", json={}, headers=headers)
    assert "execute" in {tool["tool"] for tool in listed.json()["tools"]}
    ran = anonymous.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/execute",
                         json={"project_id": project_id, "arguments": {"code": SCRIPT}}, headers=headers)
    assert ran.status_code == 200, ran.text
    assert ran.json()["value"] == {"name": "海报.psd"}
    assert agent_module().recent_log()[0]["caller"] == "外部 Agent"
    preview = anonymous.post(f"/api/canvas-agent/plugin-tools/{PLUGIN_ID}/preview",
                             json={"project_id": project_id, "arguments": {}}, headers=headers)
    assert preview.status_code == 200 and preview.json()["preview"]["mime_type"] == "image/jpeg"


def test_only_whitelisted_plugins_reach_canvas_mcp(agent_ps, tmp_path):
    anonymous, headers = _agent_headers(_client(tmp_path))
    project_id = create_canvas_project("PS").project_id
    response = anonymous.post("/api/canvas-agent/plugin-tools/storyboard/models",
                              json={"project_id": project_id, "arguments": {}}, headers=headers)
    assert response.status_code == 404


def test_settings_switch_round_trips_through_the_settings_route(agent_ps):
    assert plugin_server.call(PLUGIN_ID, "POST", "/settings", project_id=None, origin="host",
                              params={})[0] == {"allow_scripts": False}
    allow_scripts(True)
    assert plugin_server.call(PLUGIN_ID, "POST", "/settings", project_id=None, origin="host",
                              params={})[0] == {"allow_scripts": True}
