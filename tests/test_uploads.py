"""POST /api/uploads + /api/raw 放行 .runtime/uploads/ 前缀 / source_image 白名单。

Phase 4 / T15 — 美宣图源图上传通道。
"""
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    (runtime / "uploads").mkdir()
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    chars = tmp_path / "characters" / "holy"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 圣灵祭祀")
    (chars / "source").mkdir()
    (chars / "promo").mkdir()
    # config.json — /api/raw fallback 路径检查在没有 job_id 时用
    (runtime / "config.json").write_text(
        json.dumps({"image_storage_root": str(tmp_path / "downloads")})
    )
    monkeypatch.chdir(tmp_path)
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(build_app())


# ── POST /api/uploads ────────────────────────────────────────────────

def test_upload_png_to_runtime_uploads(client, runtime):
    r = client.post(
        "/api/uploads",
        files={"file": ("ref.png", io.BytesIO(PNG_MAGIC), "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "path" in body
    assert "filename" in body
    p = Path(body["path"])
    assert p.exists()
    assert p.parent == runtime / "uploads"
    assert p.suffix == ".png"
    assert p.read_bytes() == PNG_MAGIC


def test_upload_rejects_unknown_extension(client):
    r = client.post(
        "/api/uploads",
        files={"file": ("malware.exe", io.BytesIO(b"MZ\x90"), "application/octet-stream")},
    )
    assert r.status_code == 422
    assert "extension" in r.json()["detail"].lower()


def test_upload_rejects_oversized_file(client):
    # 上限 10MB；构造 11MB 触发拒绝
    big = b"\x89PNG" + b"\x00" * (11 * 1024 * 1024)
    r = client.post(
        "/api/uploads",
        files={"file": ("huge.png", io.BytesIO(big), "image/png")},
    )
    assert r.status_code == 413
    assert "too large" in r.json()["detail"].lower()


def test_upload_filename_uniqueness(client, runtime):
    """多次上传同名文件不互相覆盖。"""
    r1 = client.post(
        "/api/uploads",
        files={"file": ("ref.png", io.BytesIO(PNG_MAGIC), "image/png")},
    )
    r2 = client.post(
        "/api/uploads",
        files={"file": ("ref.png", io.BytesIO(PNG_MAGIC), "image/png")},
    )
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["path"] != r2.json()["path"]


def test_upload_accepts_jpg_webp(client):
    for ext, mime in [("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp")]:
        r = client.post(
            "/api/uploads",
            files={"file": (f"x.{ext}", io.BytesIO(b"\xff\xd8\xff" + b"\x00" * 32), mime)},
        )
        assert r.status_code == 200, f"{ext}: {r.text}"


# ── GET /api/raw 扩展 ────────────────────────────────────────────────

def test_raw_allows_runtime_uploads_without_job_id(client, runtime):
    """上传刚落盘的图，没有 job_id，前端 preview 时不应 403。"""
    p = runtime / "uploads" / "preview.png"
    p.write_bytes(PNG_MAGIC)
    r = client.get(f"/api/raw?path={p}")
    assert r.status_code == 200
    assert r.content == PNG_MAGIC


def test_raw_includes_source_image_in_job_whitelist(client, runtime):
    """promo job 的 source_image 应当能在带 job_id 时取到。"""
    src = runtime / "uploads" / "src.png"
    src.write_bytes(PNG_MAGIC)
    (runtime / "jobs" / "promo-1.json").write_text(json.dumps({
        "job_id": "promo-1", "character_id": "holy", "prompt": "p",
        "submitted_at": "2026-05-19T10:00:00Z", "model": "generate_image_gpt_image_2",
        "params": {"n": 1}, "seed": None, "output_paths": [],
        "status": "pending", "error": None, "kind": "promo",
        "source_image": str(src),
    }))
    r = client.get(f"/api/raw?path={src}&job_id=promo-1")
    assert r.status_code == 200
    assert r.content == PNG_MAGIC


def test_raw_rejects_arbitrary_path_outside_whitelist(client, runtime):
    """安全回归：随手指一个 /etc/passwd 仍然 403。"""
    r = client.get("/api/raw?path=/etc/passwd")
    # 要么 404（不存在路径已经被守卫）要么 403（root 不在 image_storage_root 下）
    assert r.status_code in (403, 404)


def test_upload_path_returned_is_resolvable_via_raw(client, runtime):
    """端到端：upload → 拿 path → raw 取回 → 字节一致。"""
    r = client.post(
        "/api/uploads",
        files={"file": ("e2e.png", io.BytesIO(PNG_MAGIC), "image/png")},
    )
    path = r.json()["path"]
    r2 = client.get(f"/api/raw?path={path}")
    assert r2.status_code == 200
    assert r2.content == PNG_MAGIC


def test_gallery_upload_creates_done_job_and_file(client, runtime):
    r = client.post(
        "/api/characters/holy/gallery/portrait",
        files={"file": ("portrait.png", io.BytesIO(PNG_MAGIC), "image/png")},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    path = Path(body["path"])
    assert path.exists()
    assert path.parent == Path.cwd() / "characters" / "holy" / "portrait"
    job_path = runtime / "jobs" / f"{body['job_id']}.json"
    data = json.loads(job_path.read_text(encoding="utf-8"))
    assert data["status"] == "done"
    assert data["kind"] == "portrait"
    assert data["output_paths"] == [str(path)]
