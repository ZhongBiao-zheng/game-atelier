import json

import pytest
from fastapi.testclient import TestClient

from skill.viewer_server.server_app import build_app


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    (tmp_path / "characters").mkdir()
    (tmp_path / "characters" / "shadow.md").write_text("# 暗影刺客女\n年龄: 24")
    monkeypatch.chdir(tmp_path)
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(build_app())


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


def test_get_spec_returns_content(client):
    r = client.get("/api/spec/shadow")
    assert r.status_code == 200
    assert "暗影刺客女" in r.json()["content"]


def test_get_spec_404(client):
    r = client.get("/api/spec/nonexistent")
    assert r.status_code == 404


def test_get_characters_lists_md_files(client):
    r = client.get("/api/characters")
    assert r.status_code == 200
    entries = r.json()
    ids = [c["id"] for c in entries]
    assert "shadow" in ids
    # Display name comes from first `# heading`, not file stem.
    by_id = {c["id"]: c for c in entries}
    assert by_id["shadow"]["name"] == "暗影刺客女"


def test_get_home_returns_user_home(client):
    r = client.get("/api/home")
    assert r.status_code == 200
    from pathlib import Path
    assert r.json()["home"] == str(Path.home())


def test_get_active_character_default_null(client):
    r = client.get("/api/active-character")
    assert r.status_code == 200
    assert r.json()["active_id"] is None
