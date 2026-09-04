# tests/test_experience_api.py
"""GET/POST /api/experience: 读写 projects/<slug>/worldview.md（项目经验），不碰 MEMORY.md。"""
from __future__ import annotations

import pytest
from tests.local_client import LocalTestClient as TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def _make_project(client) -> str:
    pf = client.post("/api/projects", json={"name": "宝可梦风格"}).json()
    return pf["projects"][0]["id"]


def test_get_experience_returns_info_and_empty_worldview(client):
    pid = _make_project(client)
    out = client.get(f"/api/experience?project={pid}").json()
    assert out["project"]["id"] == pid
    assert out["project"]["name"] == "宝可梦风格"
    assert out["project"]["character_count"] == 0
    assert isinstance(out["worldview_md"], str)


def test_post_then_get_roundtrip(client):
    pid = _make_project(client)
    revision = client.get(f"/api/experience?project={pid}").json()["revision"]
    assert client.post(
        "/api/experience", json={"project": pid, "worldview_md": "暖色调，避免直呼 IP",
                                  "expected_revision": revision}
    ).json()["ok"] is True
    assert client.get(f"/api/experience?project={pid}").json()["worldview_md"] == "暖色调，避免直呼 IP"


def test_unknown_project_404(client):
    assert client.get("/api/experience?project=p-nope").status_code == 404
    assert client.post(
        "/api/experience", json={"project": "p-nope", "worldview_md": "x", "expected_revision": "0" * 64}
    ).status_code == 404


def test_get_does_not_leak_memory_md(client, tmp_path):
    pid = _make_project(client)
    slug = client.get("/api/projects").json()["projects"][0]["slug"]
    (tmp_path / "projects" / slug / "MEMORY.md").write_text(
        "## game-atelier\n### Portrait\n- 出图技巧不该上 Web", encoding="utf-8"
    )
    out = client.get(f"/api/experience?project={pid}").json()
    assert "出图技巧不该上 Web" not in str(out)
