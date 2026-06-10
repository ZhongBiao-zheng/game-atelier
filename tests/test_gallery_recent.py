"""GET /api/gallery/recent: 从所有 character 的 portrait/promo/turnaround 中随机取 N 张."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import AssetSlot, Job, JobParams, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
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


def test_returns_images_in_randomized_order(client, tmp_path, monkeypatch):
    from viewer_server import routes

    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "old.png", mtime_offset=-100)
    _make_image(chars / "char-b" / "portrait" / "new.png", mtime_offset=-1)
    _make_image(chars / "char-c" / "promo" / "mid.png", mtime_offset=-50)
    monkeypatch.setattr(
        routes.random,
        "shuffle",
        lambda items: items.sort(key=lambda x: x["character_id"], reverse=True),
    )

    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    assert [i["character_id"] for i in items] == ["char-c", "char-b", "char-a"]
    # 每个 item 字段
    assert items[0]["asset_slot"] == "promo"
    assert items[0]["filename"] == "mid.png"


def test_includes_matching_job_id_for_detail_route(client, tmp_path):
    image = tmp_path / "characters" / "char-a" / "promo" / "kv.png"
    _make_image(image)
    save_job(Job(
        job_id="job-promo-1",
        character_id="char-a",
        prompt="p",
        submitted_at="2026-05-29T00:00:00Z",
        model="m",
        params=JobParams(),
        seed=None,
        output_paths=[str(image.resolve())],
        status=JobStatus.DONE,
        error=None,
        asset_slot=AssetSlot.PROMO,
    ))

    resp = client.get("/api/gallery/recent")

    assert resp.status_code == 200
    assert resp.json()["items"][0]["job_id"] == "job-promo-1"


def test_respects_limit_param(client, tmp_path):
    chars = tmp_path / "characters"
    for i in range(5):
        _make_image(chars / f"char-{i}" / "portrait" / "img.png", mtime_offset=-i)
    resp = client.get("/api/gallery/recent?limit=3")
    items = resp.json()["items"]
    assert len(items) == 3


def test_skips_studio_namespace(client, tmp_path):
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


def test_hidden_paths_excluded_from_recent(client, tmp_path):
    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "show.png")
    _make_image(chars / "char-a" / "portrait" / "hide.png")

    resp = client.post(
        "/api/gallery/hidden",
        json={"path": "characters/char-a/portrait/hide.png", "hidden": True},
    )
    assert resp.status_code == 200
    assert resp.json()["paths"] == ["characters/char-a/portrait/hide.png"]

    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["filename"] for i in items] == ["show.png"]


def test_hidden_accepts_absolute_path_and_unhide(client, tmp_path):
    """前端从 job.output_paths 拿到的是绝对路径——后端必须归一成相对路径存。"""
    image = tmp_path / "characters" / "char-a" / "portrait" / "kv.png"
    _make_image(image)

    resp = client.post("/api/gallery/hidden", json={"path": str(image), "hidden": True})
    assert resp.json()["paths"] == ["characters/char-a/portrait/kv.png"]
    assert client.get("/api/gallery/recent").json()["items"] == []
    assert client.get("/api/gallery/hidden").json()["paths"] == [
        "characters/char-a/portrait/kv.png"
    ]

    # 取消隐藏后重新出现在作品展示
    resp = client.post("/api/gallery/hidden", json={"path": str(image), "hidden": False})
    assert resp.json()["paths"] == []
    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["filename"] for i in items] == ["kv.png"]


def test_hidden_sidecar_corrupted_falls_back_empty(client, tmp_path):
    """sidecar 损坏不挂 recent / hidden 端点，按空清单处理。"""
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "x.png")
    runtime = tmp_path / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "gallery-hidden.json").write_text("not-json", encoding="utf-8")
    assert client.get("/api/gallery/hidden").json() == {"paths": []}
    assert len(client.get("/api/gallery/recent").json()["items"]) == 1


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
