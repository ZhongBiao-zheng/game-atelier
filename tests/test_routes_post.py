import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
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
    r = client.post(
        "/api/feedback",
        json={"text": "2 号那张光线再阴一点", "character_id": "shadow"},
    )
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
    # 让 ~ 展开到我们自己的临时目录：POSIX 认 HOME，Windows 的 expanduser 认 USERPROFILE。
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    target = "~/my-character-assets"
    r = client.post("/api/config", json={"image_storage_root": target})
    assert r.status_code == 200, r.json()
    resolved = r.json()["image_storage_root"]
    # resolved 是 str(Path.resolve())，Windows 下反斜杠——归一成 / 再比。
    assert resolved.replace("\\", "/").endswith("/my-character-assets")
    assert (tmp_path / "my-character-assets").exists()
    cfg = json.loads((runtime / "config.json").read_text())
    assert cfg["image_storage_root"] == resolved


def test_get_config_defaults_to_current_data_root(client, runtime):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["image_storage_root"] == str(runtime.parent)


def test_post_config_rejects_empty(client):
    r = client.post("/api/config", json={"image_storage_root": "   "})
    assert r.status_code == 422


def test_get_config_show_studio_defaults_false(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["show_studio_on_home"] is False


def test_post_config_show_studio_toggle_roundtrip(client, runtime):
    r = client.post("/api/config", json={"show_studio_on_home": True})
    assert r.status_code == 200
    assert client.get("/api/config").json()["show_studio_on_home"] is True
    r = client.post("/api/config", json={"show_studio_on_home": False})
    assert r.status_code == 200
    assert client.get("/api/config").json()["show_studio_on_home"] is False


def test_post_config_show_studio_rejects_non_bool(client):
    r = client.post("/api/config", json={"show_studio_on_home": "yes"})
    assert r.status_code == 422


def test_post_config_merges_keys(client, runtime, tmp_path, monkeypatch):
    """合并式补丁：改开关不丢 image_storage_root，反之亦然。"""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    client.post("/api/config", json={"image_storage_root": "~/assets"})
    client.post("/api/config", json={"show_studio_on_home": True})
    cfg = json.loads((runtime / "config.json").read_text())
    assert cfg["show_studio_on_home"] is True
    assert cfg["image_storage_root"].replace("\\", "/").endswith("/assets")


def test_post_config_rejects_unknown_only_payload(client):
    r = client.post("/api/config", json={"bogus": 1})
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


def test_post_job_cancel_deletes_job_file(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending_confirm", "error": None,
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "job_id": "j1", "deleted": True}
    assert not (runtime / "jobs" / "j1.json").exists()


def test_post_job_cancel_rejects_non_pending_confirm(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 409
    assert (runtime / "jobs" / "j1.json").exists()


def test_post_job_cancel_stale_pending_marks_failed(client, runtime):
    """pending 超过 60 分钟（Skill 进程疑似已死）→ 允许作废，标 FAILED 留痕不删文件。"""
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending", "error": None,
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "job_id": "j1", "status": "failed"}
    data = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert data["status"] == "failed"
    assert "中断" in data["error"]


def test_post_job_cancel_fresh_pending_still_409(client, runtime):
    """没到时限的 pending 可能真在出图，作废仍被拒。"""
    from datetime import datetime, timezone
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": datetime.now(timezone.utc).isoformat(), "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending", "error": None,
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 409
    assert json.loads((runtime / "jobs" / "j1.json").read_text())["status"] == "pending"


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


def test_create_character_creates_dirs_and_spec(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    r = client.post("/api/characters", json={"name": "烈拳猴"})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "烈拳猴"
    char_id = data["id"]
    assert char_id.startswith("char-")
    root = tmp_path / "characters" / char_id
    for d in ("portrait", "promo", "turnaround", "source"):
        assert (root / d).is_dir(), f"missing {d}/"
    spec = (root / "spec.md").read_text(encoding="utf-8")
    assert spec.startswith("# 烈拳猴")


def test_create_character_rejects_empty_name(client):
    r = client.post("/api/characters", json={"name": ""})
    assert r.status_code == 422


def test_create_character_sets_active(client, tmp_path, monkeypatch):
    import json as _json
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".runtime" / "jobs").mkdir(parents=True, exist_ok=True)
    r = client.post("/api/characters", json={"name": "测试角色"})
    assert r.status_code == 200
    char_id = r.json()["id"]
    active_file = tmp_path / ".runtime" / "active-character.json"
    assert active_file.exists()
    active = _json.loads(active_file.read_text())
    assert active["active_id"] == char_id


def test_create_character_can_assign_current_project_atomically(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    project = client.post("/api/projects", json={"name": "夏日项目"}).json()["projects"][0]

    response = client.post(
        "/api/characters",
        json={"name": "夏日角色", "project_id": project["id"]},
    )

    assert response.status_code == 200
    character_id = response.json()["id"]
    projects = client.get("/api/projects").json()
    assert projects["assignments"][character_id] == project["id"]


def test_create_character_rejects_missing_project_without_leaving_character(client, tmp_path):
    response = client.post(
        "/api/characters",
        json={"name": "孤立角色", "project_id": "missing"},
    )

    assert response.status_code == 404
    assert list((tmp_path / "characters").glob("char-*")) == []


def test_delete_character_removes_dir_assignment_and_active(client, tmp_path, monkeypatch):
    import json as _json

    monkeypatch.chdir(tmp_path)
    char_dir = tmp_path / "characters" / "shadow"
    (char_dir / "portrait").mkdir(parents=True, exist_ok=True)
    (char_dir / "portrait" / "v1.png").write_bytes(b"png")
    (tmp_path / ".runtime").mkdir(exist_ok=True)
    (tmp_path / ".runtime" / "active-character.json").write_text(
        _json.dumps({"active_id": "shadow", "updated_at": "2026-05-18T10:00:00Z"}),
        encoding="utf-8",
    )
    (tmp_path / ".runtime" / "projects.json").write_text(
        _json.dumps({
            "projects": [
                {"id": "p-1", "slug": "test", "name": "测试", "created_at": "2026-05-18T10:00:00Z"}
            ],
            "assignments": {"shadow": "p-1", "other": "p-1"},
        }),
        encoding="utf-8",
    )

    r = client.delete("/api/characters/shadow")

    assert r.status_code == 200, r.text
    assert not char_dir.exists()
    projects = _json.loads((tmp_path / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    assert projects["assignments"] == {"other": "p-1"}
    active = _json.loads((tmp_path / ".runtime" / "active-character.json").read_text(encoding="utf-8"))
    assert active["active_id"] is None


def test_delete_character_404_for_missing_dir(client):
    r = client.delete("/api/characters/nope")

    assert r.status_code == 404
