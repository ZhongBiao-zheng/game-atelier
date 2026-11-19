"""插件关闭即不加载（像创意工坊）：随应用发布的每个官方插件逐个核对验收口径。

关闭时：界面包取不到、服务端模块不在进程里、路由不放行、Agent 工具不注册、项目里不能新批准。
启用后这些入口恢复；再关闭时已加载的服务端模块被卸载。
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import plugin_registry, plugin_server
from character_workflow.lib.canvas_projects import create_canvas_project
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import use_plugins_root
from viewer_server.server_app import build_app

REPO = Path(__file__).resolve().parent.parent
OFFICIAL = sorted(path.parent.name for path in (REPO / "plugins").glob("*/manifest.json"))
# 官方插件刚启用时（默认设置下）允许藏起的 Agent 工具：PS 联动的脚本执行在开关打开前不出现。
ALLOWED_HIDDEN_TOOLS = {"ps-bridge": {"execute"}}


def test_every_official_plugin_is_covered():
    assert {"frames", "pixel", "sprite-sheet"} <= set(OFFICIAL)


@pytest.fixture(params=OFFICIAL)
def official(request, tmp_path, monkeypatch):
    plugin_id = request.param
    root = tmp_path / "plugins"
    use_plugins_root(monkeypatch, root, app_version=plugin_registry.app_version())
    source = REPO / "plugins" / plugin_id

    def skip(directory: str, names: list[str]) -> set[str]:
        # 只跳过源码目录（ui/、tests/），保留构建好的 package/ui。
        top = {"ui", "tests"} if Path(directory) == source else set()
        return {name for name in names if name in top or name in {"__pycache__", "node_modules"}}

    shutil.copytree(source, root / plugin_id, ignore=skip)
    client = TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")
    yield plugin_id, client
    plugin_server.unload(plugin_id)


def _lock(plugin_id: str) -> dict:
    return json.loads((plugin_registry.plugins_root() / plugin_id / "package" / "manifest.lock.json")
                      .read_text(encoding="utf-8"))


def _assert_not_loaded(plugin_id: str, client: TestClient, project_id: str) -> None:
    lock = _lock(plugin_id)
    module = plugin_server._module_name(plugin_id)
    assert module not in sys.modules
    for item in lock["files"]:
        assert client.get(f"/api/plugins/{plugin_id}/package/{item['path']}").status_code == 404
    for route in (lock["contributes"].get("server") or {}).get("routes", []):
        assert plugin_server.declared_access(plugin_id, route["method"], route["path"]) is None
        response = client.post(f"/api/plugins/{plugin_id}/routes{route['path']}",
                               json={"project_id": project_id, "node_id": "n"})
        assert response.status_code in {403, 404}
    assert not [name for name, spec in runtime.plugin_tools().items() if spec["plugin_id"] == plugin_id]
    assert client.put(f"/api/canvas/projects/{project_id}/plugin-grants/{plugin_id}", json={}).status_code >= 400
    assert module not in sys.modules, "被拒绝的请求不应加载服务端模块"


def test_disabled_official_plugin_loads_nothing_and_disabling_unloads_it(official):
    plugin_id, client = official
    project_id = create_canvas_project("插件关闭").project_id
    lock = _lock(plugin_id)

    _assert_not_loaded(plugin_id, client, project_id)

    assert client.post(f"/api/plugins/{plugin_id}/enable", json={}).status_code == 200
    for item in lock["files"]:
        assert client.get(f"/api/plugins/{plugin_id}/package/{item['path']}").status_code == 200
    declared = {tool["name"] for tool in lock["contributes"].get("agent_tools", [])}
    registered = {spec["tool"] for spec in runtime.plugin_tools().values() if spec["plugin_id"] == plugin_id}
    hidden = plugin_server.hidden_agent_tools(plugin_id)
    # 插件此刻可以藏起的工具必须登记在这张表里（ADR-0043），新增一项等于过一次审；其余官方插件不许藏任何工具。
    assert hidden == ALLOWED_HIDDEN_TOOLS.get(plugin_id, set())
    assert registered == declared - hidden
    if lock["contributes"].get("server"):
        plugin_server._handlers(plugin_registry.find(plugin_id))
        assert plugin_server._module_name(plugin_id) in sys.modules

    assert client.post(f"/api/plugins/{plugin_id}/disable", json={}).status_code == 200
    _assert_not_loaded(plugin_id, client, project_id)
