"""项目对插件的批准：按项目隔离，能力增加要重新批准。"""
from __future__ import annotations

import json

import pytest

from character_workflow.lib import plugin_registry
from character_workflow.lib.canvas_projects import canvas_project_dir
from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import use_plugins_root, write_plugin
from viewer_server.connection_capabilities import local_capability
from viewer_server.server_app import build_app


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    write_plugin(path)
    return path


@pytest.fixture
def client(root, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def project(client) -> str:
    return client.post("/api/canvas/projects", json={"name": "批准测试"}).json()["project_id"]


def grants(client, project_id: str) -> dict:
    response = client.get(f"/api/canvas/projects/{project_id}/plugin-grants")
    assert response.status_code == 200, response.text
    return response.json()["grants"]


def test_nothing_is_granted_by_default(client):
    plugin_registry.set_enabled("demo", True)
    assert grants(client, project(client)) == {}


def test_granting_requires_an_enabled_plugin(client):
    project_id = project(client)
    response = client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "PLUGIN_DISABLED"
    assert client.put(f"/api/canvas/projects/{project_id}/plugin-grants/ghost", json={}).status_code == 409


def test_grant_is_scoped_to_one_project(client):
    plugin_registry.set_enabled("demo", True)
    first, second = project(client), project(client)
    granted = client.put(f"/api/canvas/projects/{first}/plugin-grants/demo", json={})
    assert granted.status_code == 200
    assert granted.json()["grants"]["demo"]["capabilities"] == ["node.read_self", "node.write_self"]
    assert "demo" in grants(client, first)
    assert grants(client, second) == {}
    stored = json.loads((canvas_project_dir(first) / "plugin-grants.json").read_text(encoding="utf-8"))
    assert stored["grants"]["demo"]["digest"].startswith("sha256:")
    assert not (canvas_project_dir(second) / "plugin-grants.json").exists()


def test_disabling_the_plugin_suspends_the_grant_and_enabling_restores_it(client):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    plugin_registry.set_enabled("demo", False)
    assert grants(client, project_id) == {}
    plugin_registry.set_enabled("demo", True)
    assert "demo" in grants(client, project_id)


def test_update_keeps_the_grant_unless_capabilities_grow(client, root):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    # 新版本、能力变少：摘要变了，批准沿用。
    write_plugin(root, version="1.1.0", capabilities=["node.read_self"])
    assert grants(client, project_id)["demo"]["capabilities"] == ["node.read_self"]
    # 沿用时把记录更新到新摘要：批准始终对得上当前这份包。
    stored = json.loads((canvas_project_dir(project_id) / "plugin-grants.json").read_text(encoding="utf-8"))
    assert stored["grants"]["demo"]["digest"] == plugin_registry.find("demo").lock.digest
    assert stored["grants"]["demo"]["capabilities"] == ["node.read_self"]
    # 新版本、能力变多：要重新批准。
    write_plugin(root, version="1.2.0", capabilities=["node.read_self", "node.write_self", "resource.create"])
    assert grants(client, project_id) == {}
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    assert "resource.create" in grants(client, project_id)["demo"]["capabilities"]


def test_revoke(client):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    revoked = client.delete(f"/api/canvas/projects/{project_id}/plugin-grants/demo")
    assert revoked.status_code == 200 and revoked.json()["grants"] == {}
    assert client.delete(f"/api/canvas/projects/{project_id}/plugin-grants/demo").status_code == 200


def test_unknown_project_is_404(client):
    assert client.get("/api/canvas/projects/nope/plugin-grants").status_code == 404
    assert client.put("/api/canvas/projects/nope/plugin-grants/demo", json={}).status_code == 404


def test_corrupt_grants_file_means_nothing_granted(client):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    (canvas_project_dir(project_id) / "plugin-grants.json").write_text("{broken", encoding="utf-8")
    assert grants(client, project_id) == {}
    (canvas_project_dir(project_id) / "plugin-grants.json").write_text(
        json.dumps({"grants": {"demo": {"capabilities": "all"}}}), encoding="utf-8")
    assert grants(client, project_id) == {}


def test_grant_routes_are_registered_as_read_and_edit():
    assert local_capability("GET", "/api/canvas/projects/p1/plugin-grants") == "read"
    assert local_capability("PUT", "/api/canvas/projects/p1/plugin-grants/demo") == "edit"
    assert local_capability("DELETE", "/api/canvas/projects/p1/plugin-grants/demo") == "edit"


def test_grants_do_not_travel_in_project_packages(client):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    from character_workflow.lib import canvas_packages
    names = {path.name for path in canvas_packages._metadata_files(canvas_project_dir(project_id))}
    assert "plugin-grants.json" not in names


def test_grant_is_bound_to_the_package_digest(client, root, monkeypatch):
    """摘要对不上、又不是随应用发布的包时，批准不沿用（B2 安全验收 M2）。"""
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    client.put(f"/api/canvas/projects/{project_id}/plugin-grants/demo", json={})
    write_plugin(root, version="1.1.0")  # 能力不变，摘要变了
    original = plugin_registry.scan

    def as_installed():
        return [type(record)(record.plugin_id, record.package_dir,
                             record.lock.model_copy(update={"source": "installed"}) if record.lock else None,
                             record.availability, record.reason) for record in original()]
    monkeypatch.setattr(plugin_registry, "scan", as_installed)
    assert grants(client, project_id) == {}
    monkeypatch.setattr(plugin_registry, "scan", original)
    assert "demo" in grants(client, project_id)


def test_missing_digest_in_old_record_is_treated_as_mismatch(client, root):
    plugin_registry.set_enabled("demo", True)
    project_id = project(client)
    path = canvas_project_dir(project_id) / "plugin-grants.json"
    path.write_text(json.dumps({"grants": {"demo": {"capabilities": ["node.read_self", "node.write_self"]}}}),
                    encoding="utf-8")
    assert "demo" in grants(client, project_id)  # 随应用发布、能力未增加：沿用
    assert json.loads(path.read_text(encoding="utf-8"))["grants"]["demo"]["digest"].startswith("sha256:")
