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
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
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
    # 报错要能自证：说清是哪个文件、什么格式不收、这里到底收什么（画师看的是中文界面）
    detail = r.json()["detail"]
    assert "malware.exe" in detail and ".exe" in detail
    assert "格式不支持" in detail and "png" in detail


def test_upload_rejects_oversized_file(client):
    # 上限 10MB；构造 11MB 触发拒绝
    big = b"\x89PNG" + b"\x00" * (11 * 1024 * 1024)
    r = client.post(
        "/api/uploads",
        files={"file": ("huge.png", io.BytesIO(big), "image/png")},
    )
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert "huge.png" in detail and "太大" in detail
    assert "11MB" in detail and "10MB" in detail


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


# ── 视频 / 音频上传（Studio video feature）─────────────────────────────

def test_upload_accepts_mp4(client):
    r = client.post(
        "/api/uploads",
        files={"file": ("clip.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32), "video/mp4")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["path"].endswith(".mp4")


def test_upload_accepts_mp3(client):
    r = client.post(
        "/api/uploads",
        files={"file": ("voice.mp3", io.BytesIO(b"ID3" + b"\x00" * 64), "audio/mpeg")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["path"].endswith(".mp3")


def test_upload_rejects_oversized_video(client):
    big = b"\x00" * (101 * 1024 * 1024)  # 101 MB > 100 MB video cap
    r = client.post(
        "/api/uploads",
        files={"file": ("huge.mp4", io.BytesIO(big), "video/mp4")},
    )
    assert r.status_code == 413


def test_upload_image_still_capped_at_10mb(client):
    big = b"\x00" * (11 * 1024 * 1024)  # 11 MB > 10 MB image cap
    r = client.post(
        "/api/uploads",
        files={"file": ("huge.png", io.BytesIO(big), "image/png")},
    )
    assert r.status_code == 413


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
        "status": "pending", "error": None, "asset_slot": "promo",
        "source_image": str(src),
    }))
    r = client.get(f"/api/raw?path={src}&job_id=promo-1")
    assert r.status_code == 200
    assert r.content == PNG_MAGIC


def test_raw_includes_reference_videos_and_audios_in_job_whitelist(client, runtime):
    """视频 job 的参考视频/音频带 job_id 取应放行（原白名单只含 reference_images）。"""
    vid = runtime / "uploads" / "ref.mp4"
    vid.write_bytes(b"\x00\x00\x00\x18ftypmp42")
    aud = runtime / "uploads" / "ref.mp3"
    aud.write_bytes(b"ID3\x00")
    (runtime / "jobs" / "vid-1.json").write_text(json.dumps({
        "job_id": "vid-1", "character_id": "studio", "prompt": "p",
        "submitted_at": "2026-06-10T10:00:00Z", "model": "seedance",
        "params": {"reference_videos": [str(vid)], "reference_audios": [str(aud)]},
        "seed": None, "output_paths": [], "status": "pending", "error": None,
        "kind": "video", "namespace": "studio",
    }))
    assert client.get(f"/api/raw?path={vid}&job_id=vid-1").status_code == 200
    assert client.get(f"/api/raw?path={aud}&job_id=vid-1").status_code == 200


def test_raw_allows_external_mj_references_only_through_job_whitelist(
    client, runtime, tmp_path,
):
    """其他项目的本地图片只有被 MJ job 明确登记后才能在历史卡片显示。"""
    external = tmp_path / "other-project" / "style.png"
    external.parent.mkdir()
    external.write_bytes(PNG_MAGIC)
    (runtime / "jobs" / "mj-1.json").write_text(json.dumps({
        "job_id": "mj-1", "character_id": "studio", "prompt": "p",
        "submitted_at": "2026-08-20T10:00:00Z", "model": "mj_imagine",
        "params": {"mj_sref": [str(external)]},
        "seed": None, "output_paths": [], "status": "pending", "error": None,
        "kind": "image", "namespace": "studio",
    }))

    assert client.get(f"/api/raw?path={external}").status_code == 403
    response = client.get(f"/api/raw?path={external}&job_id=mj-1")
    assert response.status_code == 200
    assert response.content == PNG_MAGIC


def test_raw_resolves_relative_job_references_from_data_root(client, runtime, tmp_path):
    relative = Path("characters/hero/portrait/ref.png")
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(PNG_MAGIC)
    (runtime / "jobs" / "relative-ref.json").write_text(json.dumps({
        "job_id": "relative-ref", "character_id": "hero", "prompt": "p",
        "submitted_at": "2026-08-20T10:00:00Z", "model": "mj_imagine",
        "params": {"mj_sref": [str(relative)]},
        "seed": None, "output_paths": [], "status": "pending", "error": None,
        "kind": "image", "namespace": "studio",
    }))

    response = client.get(f"/api/raw?path={relative}&job_id=relative-ref")
    assert response.status_code == 200
    assert response.content == PNG_MAGIC


def test_raw_fallback_rejects_sibling_prefix_dir(client, runtime, tmp_path):
    """安全回归：/x/downloads-evil 不能过 /x/downloads 的前缀检查（is_relative_to）。"""
    evil = tmp_path / "downloads-evil"
    evil.mkdir()
    leak = evil / "leak.png"
    leak.write_bytes(PNG_MAGIC)
    r = client.get(f"/api/raw?path={leak}")
    assert r.status_code == 403


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
    assert data["asset_slot"] == "portrait"
    assert data["output_paths"] == [str(path)]
