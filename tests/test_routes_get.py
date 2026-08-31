import json

import pytest
from tests.local_client import LocalTestClient as TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def runtime(isolated_data_root):
    """Use the isolated_data_root already set up by the autouse fixture."""
    runtime = isolated_data_root / ".runtime"
    (runtime / "jobs").mkdir(parents=True, exist_ok=True)
    shadow = isolated_data_root / "characters" / "shadow"
    shadow.mkdir(parents=True, exist_ok=True)
    (shadow / "spec.md").write_text("# 暗影刺客女\n年龄: 24")
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


def test_get_jobs_empty(client):
    r = client.get("/api/jobs")
    assert r.status_code == 200
    assert r.json() == []


def test_get_jobs_lists_all(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    r = client.get("/api/jobs")
    assert r.status_code == 200
    assert len(r.json()) == 1
    assert r.json()[0]["job_id"] == "j1"


def test_get_jobs_skips_bad_file(client, runtime):
    """坏 job 文件（半写 / 手改 schema 不符）跳过，不再拖垮整个列表 500。"""
    (runtime / "jobs" / "good.json").write_text(json.dumps({
        "job_id": "good", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-06-10T10:00:00Z", "model": "m",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    (runtime / "jobs" / "corrupt.json").write_text("{half-written")
    (runtime / "jobs" / "bad-schema.json").write_text(
        json.dumps({"job_id": "x", "status": "bogus"})
    )
    r = client.get("/api/jobs")
    assert r.status_code == 200
    assert [j["job_id"] for j in r.json()] == ["good"]


def test_get_images_skips_bad_file(client, runtime):
    (runtime / "jobs" / "ok.json").write_text(json.dumps({
        "job_id": "ok", "character_id": "c9", "prompt": "p",
        "submitted_at": "2026-06-10T10:00:00Z", "model": "m",
        "params": {}, "seed": None, "output_paths": ["/x/a.png"],
        "status": "done", "error": None,
    }))
    (runtime / "jobs" / "corrupt.json").write_text("{")
    r = client.get("/api/images?character=c9")
    assert r.status_code == 200
    assert r.json()["output_paths"] == ["/x/a.png"]


def test_get_spec_returns_content(client):
    r = client.get("/api/spec/shadow")
    assert r.status_code == 200
    assert "暗影刺客女" in r.json()["content"]


def test_get_spec_404(client):
    r = client.get("/api/spec/nonexistent")
    assert r.status_code == 404


def test_get_characters_lists_character_dirs(client):
    r = client.get("/api/characters")
    assert r.status_code == 200
    entries = r.json()
    ids = [c["id"] for c in entries]
    assert "shadow" in ids
    # Display name comes from first `# heading`, not directory name.
    by_id = {c["id"]: c for c in entries}
    assert by_id["shadow"]["name"] == "暗影刺客女"
    # 无立绘 → thumbnail 为 None
    assert by_id["shadow"]["thumbnail"] is None


def test_get_characters_thumbnail_is_latest_portrait(client, isolated_data_root):
    import os

    portrait = isolated_data_root / "characters" / "shadow" / "portrait"
    portrait.mkdir(parents=True, exist_ok=True)
    old = portrait / "v1.png"
    new = portrait / "v2.png"
    old.write_bytes(b"old")
    new.write_bytes(b"new")
    (portrait / "prompt-v1.md").write_text("not an image")
    # mtime 决定最新，与文件名无关
    os.utime(old, (1_000_000_000, 1_000_000_000))
    os.utime(new, (2_000_000_000, 2_000_000_000))

    r = client.get("/api/characters")
    assert r.status_code == 200
    by_id = {c["id"]: c for c in r.json()}
    assert by_id["shadow"]["thumbnail"] == "characters/shadow/portrait/v2.png"


def test_get_home_returns_user_home(client):
    r = client.get("/api/home")
    assert r.status_code == 200
    from pathlib import Path
    assert r.json()["home"] == str(Path.home())


def test_get_active_character_default_null(client):
    r = client.get("/api/active-character")
    assert r.status_code == 200
    assert r.json()["active_id"] is None
