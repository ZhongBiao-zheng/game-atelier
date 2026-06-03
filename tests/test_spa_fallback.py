"""SPA fallback: GET 任何非 /api/* 路径 → 返回 web/dist/index.html (200)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    # 模拟 web/dist 存在 + index.html
    dist = tmp_path / "web" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><body>spa</body></html>")
    (dist / "assets").mkdir()  # ensure StaticFiles mount activates
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    app = build_app(dist_dir=dist)
    return TestClient(app)


def test_spa_fallback_serves_index_for_client_route(client):
    """GET /character/foo → index.html (200), 不是 404."""
    resp = client.get("/character/foo")
    assert resp.status_code == 200
    assert "spa" in resp.text


def test_spa_fallback_serves_index_for_studio(client):
    resp = client.get("/studio")
    assert resp.status_code == 200
    assert "spa" in resp.text


def test_api_routes_still_404_on_unknown(client):
    """SPA fallback 不能吃掉 /api/* — 未知 API path 仍返回 404."""
    resp = client.get("/api/this-does-not-exist")
    assert resp.status_code == 404
    # 必须不是 index.html
    assert "spa" not in resp.text


def test_static_assets_served_normally(client, tmp_path):
    asset = tmp_path / "web" / "dist" / "assets"
    (asset / "main.js").write_text("console.log('ok')")
    resp = client.get("/assets/main.js")
    assert resp.status_code == 200
    assert "console.log" in resp.text


def test_path_traversal_blocked(client):
    """URL-encoded absolute path must not escape dist_dir."""
    resp = client.get("/%2Fetc%2Fpasswd")
    assert resp.status_code == 200
    # Must serve index.html (SPA fallback), not /etc/passwd content
    assert "spa" in resp.text
    # Sanity: no root/passwd content
    assert "root:" not in resp.text


def test_missing_dist_returns_readable_503_not_bare_404(tmp_path, monkeypatch):
    """web/dist 不存在时，开窗应看到可读提示页 (503)，不是裸 404。"""
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    missing = tmp_path / "no" / "such" / "dist"
    app = build_app(dist_dir=missing)
    client = TestClient(app)

    resp = client.get("/")
    assert resp.status_code == 503
    assert "Web UI 未构建" in resp.text
    assert "make build" in resp.text

    # /api/* 仍应是 404，不被提示页吃掉
    api = client.get("/api/this-does-not-exist")
    assert api.status_code == 404
    assert "Web UI 未构建" not in api.text
