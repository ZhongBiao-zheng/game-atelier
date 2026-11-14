"""插件管理接口（ADR-0037）。"""
from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient as AnonymousClient

from tests.local_client import LocalTestClient as TestClient
from tests.plugin_fixtures import UI_HTML, use_plugins_root, write_plugin
from viewer_server.connection_capabilities import local_capability
from viewer_server.server_app import build_app


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    return path


@pytest.fixture
def client(root, tmp_path):
    return TestClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")


def test_listing_reports_app_version_and_plugins(client, root):
    write_plugin(root)
    body = client.get("/api/plugins").json()
    assert body["app_version"] == "5.137.0"
    assert [(item["id"], item["enabled"]) for item in body["plugins"]] == [("demo", False)]


def test_listing_survives_a_broken_plugin(client, root):
    write_plugin(root)
    (root / "broken" / "package").mkdir(parents=True)
    (root / "broken" / "package" / "manifest.lock.json").write_text("nope", encoding="utf-8")
    response = client.get("/api/plugins")
    assert response.status_code == 200
    assert {item["id"]: item["availability"] for item in response.json()["plugins"]} == {
        "broken": "invalid", "demo": "ok",
    }


def test_enable_then_disable(client, root):
    write_plugin(root)
    enabled = client.post("/api/plugins/demo/enable", json={})
    assert enabled.status_code == 200 and enabled.json()["plugins"][0]["enabled"] is True
    disabled = client.post("/api/plugins/demo/disable", json={})
    assert disabled.status_code == 200 and disabled.json()["plugins"][0]["enabled"] is False


def test_enable_unknown_and_incompatible(client, root):
    write_plugin(root, app_version={"min": "9.0.0"})
    missing = client.post("/api/plugins/ghost/enable", json={})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "PLUGIN_NOT_FOUND"
    blocked = client.post("/api/plugins/demo/enable", json={})
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == {"message": "需要 Atelier 9.0.0 以上", "code": "PLUGIN_UNAVAILABLE"}


def test_package_file_is_served_only_when_enabled(client, root):
    write_plugin(root)
    assert client.get("/api/plugins/demo/package/ui/index.html").status_code == 404
    client.post("/api/plugins/demo/enable", json={})
    response = client.get("/api/plugins/demo/package/ui/index.html")
    assert response.status_code == 200
    assert hashlib.sha256(response.content).hexdigest() == hashlib.sha256(UI_HTML).hexdigest()
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/plugins/demo/package/manifest.lock.json").status_code == 404
    assert client.get("/api/plugins/demo/package/ui/%2e%2e/%2e%2e/%2e%2e/pyproject.toml").status_code == 404


def test_plugin_routes_need_a_local_session(root, tmp_path):
    write_plugin(root)
    anonymous = AnonymousClient(app=build_app(dist_dir=tmp_path / "dist"), base_url="http://127.0.0.1")
    assert anonymous.get("/api/plugins").status_code == 401


def test_capabilities_are_registered():
    assert local_capability("GET", "/api/plugins") == "read"
    assert local_capability("GET", "/api/plugins/demo/package/ui/index.html") == "read"
    assert local_capability("POST", "/api/plugins/demo/enable") == "manage"
    assert local_capability("POST", "/api/plugins/demo/disable") == "manage"
    # 没登记的插件路径仍然拒绝：B3 的服务端模块路由要走清单声明，不能靠前缀放行。
    assert local_capability("POST", "/api/plugins/demo/detect") is None
    assert local_capability("GET", "/api/plugins/demo") is None


def test_host_page_forbids_network_loads_in_child_frames(client, tmp_path):
    """宿主页面响应头：子框架不能发起任何网络加载，沙箱帧也就无法把自己导航走（安全验收 S2）。"""
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    (dist / "assets" / "index.js").write_text("1", encoding="utf-8")
    served = TestClient(app=build_app(dist_dir=dist), base_url="http://127.0.0.1")
    for path in ("/", "/canvas/some-project", "/settings/plugins", "/index.html"):
        response = served.get(path)
        assert response.status_code == 200
        assert response.headers["content-security-policy"] == "frame-src 'none'", path
    assert "content-security-policy" not in served.get("/assets/index.js").headers
