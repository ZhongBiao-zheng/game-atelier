import json

import pytest
from tests.local_client import LocalTestClient as TestClient

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
    return TestClient(base_url="http://127.0.0.1", app=build_app())






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


def test_post_prompt_preserves_runner_owned_provider_task_ids(client, runtime):
    diagnostics = [{"attempt": 1, "method": "POST", "url": "https://example.test/tasks",
                    "started_at": "2026-09-28T00:00:00Z", "outcome": "unconfirmed"}]
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "old",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {
            "size": "2048x2048",
            "provider_task_protocol": "tuzi_async",
            "provider_task_ids": ["server-task"],
            "video_submission_attempts": diagnostics,
        },
        "output_paths": [], "status": "failed", "error": "network",
    }))

    r = client.post("/api/prompt/j1", json={
        "params": {
            "size": "1024x1024",
            "provider_task_protocol": "tuzi_async",
            "provider_task_ids": ["forged-task"],
            "video_submission_attempts": [],
        },
    })

    assert r.status_code == 200
    params = json.loads((runtime / "jobs" / "j1.json").read_text())["params"]
    assert params["size"] == "1024x1024"
    assert params["provider_task_ids"] == ["server-task"]
    assert params["video_submission_attempts"][0]["outcome"] == "unconfirmed"


def test_post_prompt_rejects_null_params_without_losing_provider_task_ids(client, runtime):
    path = runtime / "jobs" / "j1.json"
    path.write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "old",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {
            "provider_task_protocol": "tuzi_async",
            "provider_task_ids": ["server-task"],
        },
        "output_paths": [], "status": "pending", "error": None,
        "namespace": "studio", "kind": "image",
    }))

    response = client.post("/api/prompt/j1", json={"params": None})

    assert response.status_code == 422
    saved = json.loads(path.read_text())
    assert saved["params"]["provider_task_ids"] == ["server-task"]




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


def test_get_config_show_canvas_defaults_true(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["show_canvas_on_home"] is True


def test_post_config_show_canvas_toggle_roundtrip(client, runtime):
    r = client.post("/api/config", json={"show_canvas_on_home": False})
    assert r.status_code == 200
    assert client.get("/api/config").json()["show_canvas_on_home"] is False
    r = client.post("/api/config", json={"show_canvas_on_home": True})
    assert r.status_code == 200
    assert client.get("/api/config").json()["show_canvas_on_home"] is True


def test_post_config_show_canvas_rejects_non_bool(client):
    r = client.post("/api/config", json={"show_canvas_on_home": "yes"})
    assert r.status_code == 422


def test_post_config_merges_keys(client, runtime, tmp_path, monkeypatch):
    """合并式补丁：改开关不丢 image_storage_root，反之亦然。"""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    client.post("/api/config", json={"image_storage_root": "~/assets"})
    client.post("/api/config", json={"show_canvas_on_home": True})
    cfg = json.loads((runtime / "config.json").read_text())
    assert cfg["show_canvas_on_home"] is True
    assert cfg["image_storage_root"].replace("\\", "/").endswith("/assets")


def test_post_config_rejects_unknown_only_payload(client):
    r = client.post("/api/config", json={"bogus": 1})
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


def test_post_job_cancel_fresh_pending_requests_stop(client, runtime):
    """正在出图的 pending：只登记停止请求，status 由 runner 在可中断点落 CANCELED；重复点幂等。"""
    from datetime import datetime, timezone
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": datetime.now(timezone.utc).isoformat(), "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "pending", "error": None, "namespace": "studio", "kind": "image",
    }))
    r = client.post("/api/jobs/j1/cancel")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "job_id": "j1", "status": "pending", "cancel_requested": True}
    saved = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert saved["status"] == "pending"
    first = saved["cancel_requested_at"]
    assert first
    assert client.post("/api/jobs/j1/cancel").status_code == 200
    assert json.loads((runtime / "jobs" / "j1.json").read_text())["cancel_requested_at"] == first


def test_post_job_cancel_resumable_paid_tuzi_task_stops_polling_but_keeps_task_id(client, runtime):
    """已提交的 Tuzi 任务：停止=不再轮询，任务 id 留在 params 里供人工对账；即便早已过时限也不标 FAILED。"""
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "Tuzi", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {
            "provider_task_protocol": "tuzi_images",
            "provider_task_ids": ["paid-task-1"],
        },
        "output_paths": [], "status": "pending", "error": None,
        "namespace": "studio", "kind": "image",
    }))

    response = client.post("/api/jobs/j1/cancel")

    assert response.status_code == 200
    saved = json.loads((runtime / "jobs" / "j1.json").read_text())
    assert saved["status"] == "pending"
    assert saved["cancel_requested_at"]
    assert saved["params"]["provider_task_ids"] == ["paid-task-1"]


def test_delete_job_accepts_canceled(client, runtime):
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "c", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "canceled", "error": "已停止", "namespace": "studio", "kind": "image",
    }))
    assert client.delete("/api/jobs/j1").status_code == 200
    assert not (runtime / "jobs" / "j1.json").exists()


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
