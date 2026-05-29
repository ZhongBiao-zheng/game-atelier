"""POST /api/studio/jobs creates standalone job under namespace=studio."""
from __future__ import annotations

import json
import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app

_FAKE_CREATED_AT = "2026-05-25T00:00:00+00:00"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    # Write a valid keys.json (KeySpec requires access_key + created_at)
    keys_dir = tmp_path / ".config"
    keys_dir.mkdir()
    (keys_dir / "keys.json").write_text(json.dumps({
        "version": 1,
        "default_alias": "default",
        "keys": [{
            "alias": "default",
            "provider": "openai",
            "access_key": "sk-fake",
            "secret_key": None,
            "capabilities": [],
            "models": [],
            "notes": "",
            "created_at": _FAKE_CREATED_AT,
        }],
    }))
    # TestClient runs BackgroundTasks synchronously after the response; stub the
    # runner so we don't actually invoke lovart in unit tests.
    from viewer_server import routes as routes_module
    monkeypatch.setattr(routes_module, "_run_studio_job_safely", lambda _job_id: None)
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def test_post_studio_job_creates_pending(client):
    """Studio job created with status=pending (skip pending_confirm — UI click is the confirmation)."""
    resp = client.post("/api/studio/jobs", json={
        "prompt": "a quiet warm gallery",
        "model": "gpt-image-2",
        "params": {"size": "1024x1024"},
    })
    assert resp.status_code == 201
    payload = resp.json()
    assert payload["status"] == "pending"
    assert payload["namespace"] == "studio"
    assert payload["kind"] == "image"
    assert payload["params"]["n"] == 1


def test_post_studio_job_uses_default_alias_when_omitted(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
    })
    assert resp.json()["alias"] == "default"


def test_post_studio_job_rejects_video_kind(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
        "kind": "video",
    })
    assert resp.status_code == 422


def test_post_studio_job_rejects_out_of_range_image_count(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {"n": 5},
    })
    assert resp.status_code == 422


def test_studio_job_writes_to_studio_namespace_path(tmp_path, monkeypatch):
    """studio_output_dir(job_id) returns <data_root>/studio/<job_id>/."""
    from character_workflow.lib.studio_jobs import studio_output_dir
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    out = studio_output_dir("job-test-xyz")
    assert out == tmp_path / "studio" / "job-test-xyz"


def test_characters_endpoint_does_not_leak_studio(client, tmp_path):
    """GET /api/characters 不返回 studio/ 目录."""
    (tmp_path / "studio" / "job-x").mkdir(parents=True)
    (tmp_path / "characters" / "char-real").mkdir(parents=True)
    resp = client.get("/api/characters")
    chars = [c["id"] for c in resp.json()]
    assert "job-x" not in chars
    assert "studio" not in chars


def test_post_studio_job_schedules_background_runner(client, monkeypatch):
    """The POST handler must register a BackgroundTask that calls the runner wrapper."""
    from viewer_server import routes as routes_module
    called: list[str] = []

    def fake_runner(job_id: str) -> None:
        called.append(job_id)

    monkeypatch.setattr(routes_module, "_run_studio_job_safely", fake_runner)
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
    })
    assert resp.status_code == 201
    # TestClient runs background tasks synchronously after response sent.
    assert called == [resp.json()["job_id"]]


def test_get_single_job(client):
    """GET /api/jobs/{job_id} returns the job by id."""
    r1 = client.post("/api/studio/jobs", json={"prompt": "x", "model": "gpt-image-2", "params": {}})
    assert r1.status_code == 201
    job_id = r1.json()["job_id"]
    r2 = client.get(f"/api/jobs/{job_id}")
    assert r2.status_code == 200
    assert r2.json()["job_id"] == job_id
