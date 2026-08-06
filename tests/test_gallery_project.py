"""GET /api/gallery/project: 项目作品 = assignments 反查角色 → 三槽图，过滤隐藏、最新在前。"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _make_image(p: Path, mtime_offset: float = 0):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    if mtime_offset:
        target = time.time() + mtime_offset
        os.utime(p, (target, target))


def _create_project(client, name="魔幻") -> str:
    r = client.post("/api/projects", json={"name": name})
    assert r.status_code == 200
    return r.json()["projects"][0]["id"]


def test_404_for_unknown_project(client):
    assert client.get("/api/gallery/project?project=nope").status_code == 404


def test_only_member_characters_included(client, tmp_path):
    chars = tmp_path / "characters"
    (chars / "member").mkdir()
    (chars / "member" / "spec.md").write_text("# 成员甲\n", encoding="utf-8")
    _make_image(chars / "member" / "portrait" / "a.png")
    _make_image(chars / "outsider" / "portrait" / "b.png")
    pid = _create_project(client)
    client.post("/api/characters/member/project", json={"project_id": pid})

    items = client.get(f"/api/gallery/project?project={pid}").json()["items"]
    assert [i["path"] for i in items] == ["characters/member/portrait/a.png"]
    assert items[0]["character_id"] == "member"
    assert items[0]["character_name"] == "成员甲"
    assert items[0]["asset_slot"] == "portrait"


def test_hidden_excluded_and_sorted_newest_first(client, tmp_path):
    chars = tmp_path / "characters"
    _make_image(chars / "m" / "portrait" / "old.png", mtime_offset=-100)
    _make_image(chars / "m" / "promo" / "new.png", mtime_offset=-1)
    _make_image(chars / "m" / "turnaround" / "hide.png", mtime_offset=-2)
    pid = _create_project(client)
    client.post("/api/characters/m/project", json={"project_id": pid})
    client.post("/api/gallery/hidden", json={"path": "characters/m/turnaround/hide.png", "hidden": True})

    items = client.get(f"/api/gallery/project?project={pid}").json()["items"]
    assert [i["filename"] for i in items] == ["new.png", "old.png"]


def test_empty_project_returns_empty_items(client):
    pid = _create_project(client)
    assert client.get(f"/api/gallery/project?project={pid}").json() == {"items": []}
