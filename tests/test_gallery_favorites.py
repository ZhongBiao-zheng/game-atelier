"""POST/GET /api/gallery/favorites: 路径键收藏清单，镜像 gallery-hidden，但不过滤 recent。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def _make_image(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")


def test_favorites_empty_by_default(client):
    assert client.get("/api/gallery/favorites").json() == {"paths": []}


def test_favorite_add_and_remove(client, tmp_path):
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "v1.png")
    resp = client.post(
        "/api/gallery/favorites",
        json={"path": "characters/char-a/portrait/v1.png", "favorite": True},
    )
    assert resp.status_code == 200
    assert resp.json()["paths"] == ["characters/char-a/portrait/v1.png"]
    assert client.get("/api/gallery/favorites").json()["paths"] == [
        "characters/char-a/portrait/v1.png"
    ]
    resp = client.post(
        "/api/gallery/favorites",
        json={"path": "characters/char-a/portrait/v1.png", "favorite": False},
    )
    assert resp.json()["paths"] == []


def test_favorite_accepts_absolute_path(client, tmp_path):
    image = tmp_path / "characters" / "char-a" / "portrait" / "v1.png"
    _make_image(image)
    resp = client.post("/api/gallery/favorites", json={"path": str(image), "favorite": True})
    assert resp.json()["paths"] == ["characters/char-a/portrait/v1.png"]


def test_favorite_does_not_filter_recent(client, tmp_path):
    """收藏只是标记——不像 hidden 那样从首页作品展示剔除。"""
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "v1.png")
    client.post(
        "/api/gallery/favorites",
        json={"path": "characters/char-a/portrait/v1.png", "favorite": True},
    )
    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["filename"] for i in items] == ["v1.png"]


def test_favorites_sidecar_corrupted_falls_back_empty(client, tmp_path):
    runtime = tmp_path / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "gallery-favorites.json").write_text("not-json", encoding="utf-8")
    assert client.get("/api/gallery/favorites").json() == {"paths": []}
