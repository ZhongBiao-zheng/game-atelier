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
















def test_matting_model_status_reports_missing_runtime(client, monkeypatch):
    from character_workflow.lib import matting

    monkeypatch.setattr(matting, "runtime_available", lambda: False)
    status = client.get("/api/canvas/matting-model")
    assert status.status_code == 200
    body = status.json()
    assert body["available"] is False and body["ready"] is False
    assert body["message"]
    download = client.post("/api/canvas/matting-model")
    assert download.status_code == 422
    assert download.json()["detail"]["code"] == "canvas_matting_unavailable"


def test_matting_model_status_available_with_runtime(client):
    body = client.get("/api/canvas/matting-model").json()
    assert body["available"] is True and body["message"] is None
    assert body["provider"] != "unavailable"
