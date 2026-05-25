"""GET /api/gallery/recent: 从所有 character 的 portrait/promo/turnaround 中按 mtime 取最新 N 张."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    chars = tmp_path / "characters"
    chars.mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _make_image(p: Path, mtime_offset: float = 0):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    if mtime_offset:
        target_mtime = time.time() + mtime_offset
        os.utime(p, (target_mtime, target_mtime))


def test_empty_returns_empty_list(client):
    resp = client.get("/api/gallery/recent")
    assert resp.status_code == 200
    assert resp.json() == {"items": []}


def test_returns_images_sorted_by_mtime(client, tmp_path):
    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "old.png", mtime_offset=-100)
    _make_image(chars / "char-b" / "portrait" / "new.png", mtime_offset=-1)
    _make_image(chars / "char-c" / "promo" / "mid.png", mtime_offset=-50)
    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    # 时间倒序
    assert [i["character_id"] for i in items] == ["char-b", "char-c", "char-a"]
    # 每个 item 字段
    assert items[0]["asset_slot"] == "portrait"
    assert items[0]["filename"] == "new.png"


def test_respects_limit_param(client, tmp_path):
    chars = tmp_path / "characters"
    for i in range(5):
        _make_image(chars / f"char-{i}" / "portrait" / "img.png", mtime_offset=-i)
    resp = client.get("/api/gallery/recent?limit=3")
    items = resp.json()["items"]
    assert len(items) == 3


def test_skips_studio_namespace(client, tmp_path):
    """studio/ 目录的图不进 home gallery (Pass 1.4 Decision: home = 角色作品集)."""
    chars = tmp_path / "characters"
    studio = tmp_path / "studio"
    _make_image(chars / "char-a" / "portrait" / "char.png", mtime_offset=-2)
    _make_image(studio / "job-x" / "v1.png", mtime_offset=-1)
    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["character_id"] == "char-a"


def test_handles_missing_file_gracefully(client, tmp_path):
    """单文件 stat 失败不挂整个 endpoint (Failure mode F3)."""
    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "good.png", mtime_offset=-1)
    # 模拟坏文件场景：创建一个 dangling symlink
    bad = chars / "char-a" / "portrait" / "broken.png"
    bad.symlink_to(tmp_path / "nonexistent")
    resp = client.get("/api/gallery/recent")
    assert resp.status_code == 200
    items = resp.json()["items"]
    # good.png 必须返回；broken.png 跳过
    assert any(i["filename"] == "good.png" for i in items)


def test_gallery_image_endpoint_rejects_traversal(client, tmp_path):
    resp = client.get("/api/gallery/image?path=../../../etc/passwd")
    assert resp.status_code == 400


def test_gallery_image_endpoint_serves_valid_path(client, tmp_path):
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "x.png")
    resp = client.get("/api/gallery/image?path=characters/char-a/portrait/x.png")
    assert resp.status_code == 200


def test_gallery_image_endpoint_serves_studio(client, tmp_path):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    resp = client.get("/api/gallery/image?path=studio/job-x/v1.png")
    assert resp.status_code == 200


def test_gallery_image_endpoint_404_for_missing_file(client, tmp_path):
    resp = client.get("/api/gallery/image?path=characters/foo/portrait/missing.png")
    assert resp.status_code == 404
