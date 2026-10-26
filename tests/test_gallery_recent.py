"""GET /api/gallery/recent: 从所有 character 的 portrait/promo/turnaround 中随机取 N 张."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    chars = tmp_path / "characters"
    chars.mkdir()
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def _make_image(p: Path, mtime_offset: float = 0):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    if mtime_offset:
        target_mtime = time.time() + mtime_offset
        os.utime(p, (target_mtime, target_mtime))


def _studio_job(root: Path, *, status=JobStatus.DONE, outputs=("v1.png",)):
    job = Job(
        job_id="job-x", namespace="studio", character_id="studio",
        prompt="p", submitted_at="2026-09-09T00:00:00Z", model="m",
        params=JobParams(), status=status, error=None, output_paths=[str(root / "studio" / "job-x" / name) for name in outputs],
    )
    save_job(job)
    return job


def test_empty_returns_empty_list(client):
    resp = client.get("/api/gallery/recent")
    assert resp.status_code == 200
    assert resp.json() == {"items": []}










def test_skips_studio_namespace(client, tmp_path):
    """studio 目录里没有任务登记的文件不算作品。"""
    chars = tmp_path / "characters"
    studio = tmp_path / "studio"
    _make_image(chars / "char-a" / "portrait" / "char.png", mtime_offset=-2)
    _make_image(studio / "job-x" / "v1.png", mtime_offset=-1)
    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    assert items == []


def test_studio_items_included_when_toggle_on(client, tmp_path):
    """混排任务正式登记的 studio 产物，深链使用真实 job_id。"""
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "char.png")
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    _studio_job(tmp_path)

    items = client.get("/api/gallery/recent").json()["items"]
    assert len(items) == 1
    studio_item = next(i for i in items if i["source"] == "studio")
    assert studio_item["character_id"] is None
    assert studio_item["asset_slot"] is None
    assert studio_item["path"] == "studio/job-x/v1.png"
    assert studio_item["job_id"] == "job-x"


def test_studio_items_respect_hidden(client, tmp_path):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    _make_image(tmp_path / "studio" / "job-x" / "v2.png")
    _studio_job(tmp_path, outputs=("v1.png", "v2.png"))
    client.post("/api/gallery/hidden", json={"path": "studio/job-x/v1.png", "hidden": True})

    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["path"] for i in items] == ["studio/job-x/v2.png"]


def test_studio_only_data_root_returns_studio_items(client, tmp_path):
    """characters/ 目录不存在时开关开启仍能返回 studio 图（早退 bug 回归）。"""
    (tmp_path / "characters").rmdir()
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    _studio_job(tmp_path)
    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["path"] for i in items] == ["studio/job-x/v1.png"]


def test_studio_orphan_and_unregistered_files_are_not_artworks(client, tmp_path):
    _make_image(tmp_path / "studio" / "studio-zz-001" / "v1.png")
    _make_image(tmp_path / "studio" / "job-x" / "unregistered.png")
    _studio_job(tmp_path, outputs=())
    assert client.get("/api/gallery/recent").json()["items"] == []


@pytest.mark.parametrize("status", list(JobStatus))
def test_studio_gallery_requires_completed_results(client, tmp_path, status):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    _studio_job(tmp_path, status=status)
    items = client.get("/api/gallery/recent").json()["items"]
    assert len(items) == (1 if status in (JobStatus.DONE, JobStatus.PARTIAL) else 0)


def test_studio_registered_paths_must_be_existing_contained_images(client, tmp_path):
    good = tmp_path / "studio" / "job-x" / "v1.png"
    _make_image(good)
    _make_image(tmp_path / "outside.png")
    (good.parent / "directory.png").mkdir()
    (good.parent / "escape.png").symlink_to(tmp_path / "outside.png")
    job = _studio_job(tmp_path)
    save_job(job.model_copy(update={"output_paths": [
        "studio/job-x/v1.png", str(good), str(good.parent / "missing.png"),
        str(good.parent / "directory.png"), str(good.parent / "escape.png"),
        str(tmp_path / "outside.png"),
    ]}))
    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["path"] for i in items] == ["studio/job-x/v1.png"]


@pytest.mark.parametrize("override", [{"namespace": "canvas"}, {"kind": JobKind.VIDEO}])
def test_studio_gallery_does_not_borrow_other_job_kinds(client, tmp_path, override):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    job = _studio_job(tmp_path)
    save_job(job.model_copy(update=override))
    assert client.get("/api/gallery/recent").json()["items"] == []






def test_hidden_accepts_absolute_path_and_unhide(client, tmp_path):
    """前端从 job.output_paths 拿到的是绝对路径——后端必须归一成相对路径存。"""
    image = tmp_path / "studio" / "job-x" / "kv.png"
    _make_image(image)
    _studio_job(tmp_path, outputs=("kv.png",))

    resp = client.post("/api/gallery/hidden", json={"path": str(image), "hidden": True})
    assert resp.json()["paths"] == ["studio/job-x/kv.png"]
    assert client.get("/api/gallery/recent").json()["items"] == []
    assert client.get("/api/gallery/hidden").json()["paths"] == [
        "studio/job-x/kv.png"
    ]

    # 取消隐藏后重新出现在作品展示
    resp = client.post("/api/gallery/hidden", json={"path": str(image), "hidden": False})
    assert resp.json()["paths"] == []
    items = client.get("/api/gallery/recent").json()["items"]
    assert [i["filename"] for i in items] == ["kv.png"]


def test_hidden_sidecar_corrupted_falls_back_empty(client, tmp_path):
    """sidecar 损坏不挂 recent / hidden 端点，按空清单处理。"""
    _make_image(tmp_path / "studio" / "job-x" / "x.png")
    _studio_job(tmp_path, outputs=("x.png",))
    runtime = tmp_path / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "gallery-hidden.json").write_text("not-json", encoding="utf-8")
    assert client.get("/api/gallery/hidden").json() == {"paths": []}
    assert len(client.get("/api/gallery/recent").json()["items"]) == 1




def test_gallery_image_endpoint_rejects_traversal(client, tmp_path):
    resp = client.get("/api/gallery/image?path=../../../etc/passwd")
    assert resp.status_code == 400


def test_gallery_image_endpoint_serves_valid_path(client, tmp_path):
    _make_image(tmp_path / "studio" / "job-x" / "x.png")
    _studio_job(tmp_path, outputs=("x.png",))
    resp = client.get("/api/gallery/image?path=studio/job-x/x.png")
    assert resp.status_code == 200


def test_gallery_image_endpoint_serves_studio(client, tmp_path):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    resp = client.get("/api/gallery/image?path=studio/job-x/v1.png")
    assert resp.status_code == 200


def test_gallery_image_endpoint_404_for_missing_file(client, tmp_path):
    resp = client.get("/api/gallery/image?path=studio/foo/missing.png")
    assert resp.status_code == 404
