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
    shadow = tmp_path / "characters" / "shadow"
    shadow.mkdir(parents=True)
    (shadow / "spec.md").write_text("# old")
    monkeypatch.chdir(tmp_path)
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(build_app())


def test_post_spec_writes_file(client, runtime):
    r = client.post("/api/spec/shadow", json={"content": "# new content"})
    assert r.status_code == 200
    assert (Path.cwd() / "characters" / "shadow" / "spec.md").read_text() == "# new content"


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


def test_post_config_expands_tilde_and_mkdirs(client, runtime, tmp_path, monkeypatch):
    # Force HOME to tmp_path so ~ expands somewhere we own
    monkeypatch.setenv("HOME", str(tmp_path))
    target = "~/my-character-assets"
    r = client.post("/api/config", json={"image_storage_root": target})
    assert r.status_code == 200, r.json()
    resolved = r.json()["image_storage_root"]
    assert resolved.endswith("/my-character-assets")
    assert (tmp_path / "my-character-assets").exists()
    cfg = json.loads((runtime / "config.json").read_text())
    assert cfg["image_storage_root"] == resolved


def test_post_config_rejects_empty(client):
    r = client.post("/api/config", json={"image_storage_root": "   "})
    assert r.status_code == 422


def test_post_rename_character_updates_heading(client, runtime):
    p = Path.cwd() / "characters" / "shadow" / "spec.md"
    p.write_text("# 暗影刺客女\n\n职业：刺客", encoding="utf-8")
    r = client.post("/api/characters/shadow/rename", json={"name": "暗影女刺客"})
    assert r.status_code == 200, r.json()
    new = p.read_text(encoding="utf-8")
    assert new.startswith("# 暗影女刺客")
    assert "职业：刺客" in new


def test_post_rename_inserts_heading_if_missing(client, runtime):
    p = Path.cwd() / "characters" / "shadow" / "spec.md"
    p.write_text("职业：刺客\n年龄：24", encoding="utf-8")
    r = client.post("/api/characters/shadow/rename", json={"name": "暗影"})
    assert r.status_code == 200
    assert p.read_text(encoding="utf-8").startswith("# 暗影\n")


def test_post_rename_rejects_404(client):
    r = client.post("/api/characters/nope/rename", json={"name": "x"})
    assert r.status_code == 404


def test_post_rename_rejects_empty(client):
    r = client.post("/api/characters/shadow/rename", json={"name": "   "})
    assert r.status_code == 422


def test_projects_crud_full_cycle(client, runtime):
    # Empty
    r = client.get("/api/projects")
    assert r.status_code == 200
    assert r.json() == {"projects": [], "assignments": {}}

    # Create
    r = client.post("/api/projects", json={"name": "魔幻"})
    assert r.status_code == 200
    pid = r.json()["projects"][0]["id"]
    assert r.json()["projects"][0]["name"] == "魔幻"

    # Rename
    r = client.post(f"/api/projects/{pid}/rename", json={"name": "武侠"})
    assert r.status_code == 200
    assert r.json()["projects"][0]["name"] == "武侠"

    # Assign
    r = client.post("/api/characters/shadow/project", json={"project_id": pid})
    assert r.status_code == 200, r.json()
    assert r.json()["assignments"] == {"shadow": pid}

    # Unassign
    r = client.post("/api/characters/shadow/project", json={"project_id": None})
    assert r.status_code == 200
    assert r.json()["assignments"] == {}

    # Re-assign then delete project → assignments清空
    client.post("/api/characters/shadow/project", json={"project_id": pid})
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert r.json()["projects"] == []
    assert r.json()["assignments"] == {}


def test_post_project_rename_404(client):
    r = client.post("/api/projects/nope/rename", json={"name": "x"})
    assert r.status_code == 404


def test_post_character_project_404_when_project_missing(client):
    r = client.post("/api/characters/shadow/project", json={"project_id": "nope"})
    assert r.status_code == 404


def test_post_project_rejects_empty(client):
    r = client.post("/api/projects", json={"name": ""})
    assert r.status_code == 422


def test_post_job_confirm_transitions_pending_confirm_to_pending(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending_confirm", "error": None,
    }))
    r = client.post("/api/jobs/j1/confirm")
    assert r.status_code == 200, r.json()
    data = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert data["status"] == "pending"


def test_post_job_confirm_rejects_wrong_status(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending", "error": None,
    }))
    r = client.post("/api/jobs/j1/confirm")
    assert r.status_code == 409


def test_post_job_cancel_marks_failed(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending_confirm", "error": None,
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 200
    data = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert data["status"] == "failed"
    assert "画师取消" in data["error"]


def test_delete_failed_job_removes_job_file(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "failed", "error": "Lovart timeout",
    }))

    r = client.delete("/api/jobs/j1")

    assert r.status_code == 200, r.text
    assert not (runtime / "jobs" / "j1.json").exists()


def test_delete_failed_job_rejects_done_job(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))

    r = client.delete("/api/jobs/j1")

    assert r.status_code == 409
    assert (runtime / "jobs" / "j1.json").exists()
