"""POST/GET /api/gallery/ratings: 路径键评分（0.5~5，0=清除），镜像 favorites 但值为 dict。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _img(tmp_path: Path) -> str:
    p = tmp_path / "characters" / "char-a" / "portrait" / "v1.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    return "characters/char-a/portrait/v1.png"


def test_ratings_empty_by_default(client):
    assert client.get("/api/gallery/ratings").json() == {"ratings": {}}


def test_rating_set_get_clear(client, tmp_path):
    rel = _img(tmp_path)
    assert client.post(
        "/api/gallery/ratings", json={"path": rel, "rating": 3.5}
    ).json()["ratings"] == {rel: 3.5}
    assert client.get("/api/gallery/ratings").json()["ratings"] == {rel: 3.5}
    # rating=0 清除
    assert client.post(
        "/api/gallery/ratings", json={"path": rel, "rating": 0}
    ).json()["ratings"] == {}


def test_rating_accepts_absolute_path(client, tmp_path):
    _img(tmp_path)
    image = tmp_path / "characters" / "char-a" / "portrait" / "v1.png"
    out = client.post("/api/gallery/ratings", json={"path": str(image), "rating": 5}).json()
    assert out["ratings"] == {"characters/char-a/portrait/v1.png": 5.0}


def test_rating_rejects_out_of_range(client, tmp_path):
    rel = _img(tmp_path)
    assert client.post("/api/gallery/ratings", json={"path": rel, "rating": 6}).status_code == 422


def test_rating_rejects_non_half_step(client, tmp_path):
    rel = _img(tmp_path)
    assert client.post("/api/gallery/ratings", json={"path": rel, "rating": 3.3}).status_code == 422


def test_ratings_sidecar_corrupted_falls_back_empty(client, tmp_path):
    runtime = tmp_path / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "gallery-ratings.json").write_text("not-json", encoding="utf-8")
    assert client.get("/api/gallery/ratings").json() == {"ratings": {}}
