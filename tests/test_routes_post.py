import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from skill.viewer_server.server_app import build_app


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    (runtime / "draft").mkdir()
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    (tmp_path / "characters").mkdir()
    (tmp_path / "characters" / "shadow.md").write_text("# old")
    monkeypatch.chdir(tmp_path)
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(build_app())


def test_post_spec_writes_file(client, runtime):
    r = client.post("/api/spec/shadow", json={"content": "# new content"})
    assert r.status_code == 200
    assert (Path.cwd() / "characters" / "shadow.md").read_text() == "# new content"


def test_post_spec_rejects_empty(client):
    r = client.post("/api/spec/shadow", json={"content": ""})
    assert r.status_code == 422


def test_post_prompt_patches_whitelisted_fields(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "old",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    r = client.post("/api/prompt/j1", json={"prompt": "new prompt"})
    assert r.status_code == 200
    data = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert data["prompt"] == "new prompt"
    assert data["character_id"] == "c"  # untouched


def test_post_prompt_rejects_status_field(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "old",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    r = client.post("/api/prompt/j1", json={"status": "failed"})
    assert r.status_code == 422


def test_post_feedback_writes_draft(client, runtime):
    r = client.post("/api/feedback", json={"text": "2 号那张光线再阴一点"})
    assert r.status_code == 200
    drafts = list((runtime / "draft").glob("*.md"))
    assert len(drafts) == 1
    assert "2 号那张" in drafts[0].read_text()


def test_post_clipboard_attempt_appends_log(client, runtime):
    r = client.post("/api/clipboard-attempt", json={
        "ts": "2026-05-18T10:00:00Z", "success": True,
    })
    assert r.status_code == 200
    log = (runtime / "clipboard.log").read_text()
    assert "true" in log
