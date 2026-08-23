"""Independent, user-created canvas projects and canvas-owned jobs."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.jobs import job_output_dir_for, read_job
from viewer_server.server_app import build_app


_CREATED_AT = "2026-08-23T00:00:00+00:00"


@pytest.fixture
def client(isolated_data_root, monkeypatch):
    keys_dir = isolated_data_root / ".config"
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
            "created_at": _CREATED_AT,
        }],
    }))
    from viewer_server import routes as routes_module
    monkeypatch.setattr(routes_module, "_run_studio_job_safely", lambda _job_id: None)
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _create_project(client: TestClient, name: str = "分镜实验") -> dict:
    response = client.post("/api/canvas/projects", json={"name": name})
    assert response.status_code == 201, response.json()
    return response.json()


def test_canvas_project_create_list_rename_and_empty_document(client, isolated_data_root):
    assert client.get("/api/canvas/projects").json() == {"projects": []}

    created = _create_project(client)
    project_id = created["project_id"]
    assert created["name"] == "分镜实验"
    assert (isolated_data_root / "canvases" / project_id / "project.json").exists()

    listed = client.get("/api/canvas/projects").json()["projects"]
    assert [item["project_id"] for item in listed] == [project_id]
    assert listed[0]["cover"] is None

    document = client.get(f"/api/canvas/projects/{project_id}/document")
    assert document.status_code == 200
    assert document.json()["project_id"] == project_id
    assert document.json()["nodes"] == []
    assert document.json()["connections"] == []

    renamed = client.patch(
        f"/api/canvas/projects/{project_id}",
        json={"name": "列车广告片"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "列车广告片"


def test_canvas_document_roundtrip_and_rejects_dangling_connection(client):
    project_id = _create_project(client)["project_id"]
    document = {
        "schema_version": 1,
        "project_id": project_id,
        "viewport": {"x": 18, "y": -4, "zoom": 0.8},
        "nodes": [
            {
                "id": "text-1",
                "type": "text",
                "position": {"x": 20, "y": 30},
                "data": {"title": "方向", "text": "雨夜列车"},
            },
            {
                "id": "gen-1",
                "type": "generation",
                "position": {"x": 420, "y": 30},
                "data": {
                    "media_kind": "image",
                    "draft": {"prompt": "电影感", "model": "gpt-image-2", "params": {}},
                    "job_ids": [],
                },
            },
        ],
        "connections": [{
            "id": "edge-1",
            "kind": "provenance",
            "source_node_id": "text-1",
            "target_node_id": "gen-1",
        }],
        "updated_at": _CREATED_AT,
    }
    saved = client.put(f"/api/canvas/projects/{project_id}/document", json=document)
    assert saved.status_code == 200, saved.json()
    assert saved.json()["viewport"] == {"x": 18.0, "y": -4.0, "zoom": 0.8}
    assert client.get(f"/api/canvas/projects/{project_id}/document").json() == saved.json()

    document["connections"][0]["source_node_id"] = "missing"
    invalid = client.put(f"/api/canvas/projects/{project_id}/document", json=document)
    assert invalid.status_code == 422


def test_canvas_document_does_not_fallback_when_truth_file_is_missing(client, isolated_data_root):
    project_id = _create_project(client)["project_id"]
    (isolated_data_root / "canvases" / project_id / "canvas.json").unlink()

    response = client.get(f"/api/canvas/projects/{project_id}/document")

    assert response.status_code == 409
    assert response.json()["detail"] == "canvas document is missing"


def test_canvas_upload_and_media_endpoint_stay_inside_project(client, isolated_data_root):
    project_id = _create_project(client)["project_id"]
    uploaded = client.post(
        f"/api/canvas/projects/{project_id}/uploads",
        files={"file": ("reference.png", b"fake-png", "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.json()
    payload = uploaded.json()
    assert payload["media_kind"] == "image"
    assert payload["path"].startswith(f"canvases/{project_id}/uploads/")
    assert (isolated_data_root / payload["path"]).read_bytes() == b"fake-png"

    media = client.get(
        f"/api/canvas/projects/{project_id}/media",
        params={"path": payload["path"]},
    )
    assert media.status_code == 200
    assert media.content == b"fake-png"

    referenced_job = client.post(f"/api/canvas/projects/{project_id}/jobs", json={
        "prompt": "use the uploaded reference",
        "model": "gpt-image-2",
        "params": {"reference_images": [payload["path"]]},
    })
    assert referenced_job.status_code == 201, referenced_job.json()

    escaped = client.get(
        f"/api/canvas/projects/{project_id}/media",
        params={"path": f"canvases/{project_id}/../project.json"},
    )
    assert escaped.status_code == 403


def test_canvas_job_has_independent_namespace_and_output_dir(client, isolated_data_root):
    project_id = _create_project(client)["project_id"]
    response = client.post(f"/api/canvas/projects/{project_id}/jobs", json={
        "prompt": "a calm train interior",
        "model": "gpt-image-2",
        "params": {"n": 2},
        "kind": "image",
    })
    assert response.status_code == 201, response.json()
    payload = response.json()
    assert payload["namespace"] == "canvas"
    assert payload["canvas_project_id"] == project_id
    assert payload["status"] == "pending"

    listed = client.get(f"/api/canvas/projects/{project_id}/jobs")
    assert listed.status_code == 200
    assert [job["job_id"] for job in listed.json()] == [payload["job_id"]]

    stored = read_job(payload["job_id"])
    assert job_output_dir_for(stored) == (
        isolated_data_root / "canvases" / project_id / "outputs" / stored.job_id
    )


def test_canvas_job_rejects_missing_project(client):
    response = client.post("/api/canvas/projects/missing/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
    })
    assert response.status_code == 404
    assert client.get("/api/canvas/projects/missing/jobs").status_code == 404


def test_canvas_job_rejects_reference_outside_its_project(client):
    project_id = _create_project(client)["project_id"]

    response = client.post(f"/api/canvas/projects/{project_id}/jobs", json={
        "prompt": "steal a local file",
        "model": "gpt-image-2",
        "params": {"reference_images": ["/etc/passwd"]},
    })

    assert response.status_code == 422
    assert response.json()["detail"] == "media path is outside this canvas project"

    source_image = client.post(f"/api/canvas/projects/{project_id}/jobs", json={
        "prompt": "try the alternate source field",
        "model": "gpt-image-2",
        "params": {"source_image": "/etc/passwd"},
    })
    assert source_image.status_code == 422
    assert source_image.json()["detail"] == "media path is outside this canvas project"
