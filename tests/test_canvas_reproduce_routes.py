"""画布复刻路由：If-Match 与 insert 路由同写法，响应是带 warnings 的 CanvasReproduceResponse。"""
from __future__ import annotations

import pytest
from tests.local_client import LocalTestClient as TestClient
from tests.test_canvas_reproduce import _MASK, _REF_A, _REF_B, _asset

from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document
from character_workflow.lib.creation_assets import blob_path_for, create_media_asset_from_bytes
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _url(project_id: str, asset_id: str) -> str:
    return f"/api/canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce"


def _post(client, project_id: str, asset_id: str, *, revision: int | None = 0, **body):
    headers = {} if revision is None else {"If-Match": f'"{revision}"'}
    payload = {"position": {"x": 100, "y": 200}, "alias": "tuzi-main", "model": "gpt-image-2",
               **body}
    return client.post(_url(project_id, asset_id), json=payload, headers=headers)


def test_reproduce_builds_nodes_and_returns_warnings(client):
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_REF_B, "reference"), (_MASK, "mask")])
    resp = _post(client, project.project_id, asset.asset_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert resp.headers["ETag"] == f'"{body["revision"]}"' and body["revision"] == 1
    assert [node["type"] for node in body["nodes"]] == ["image", "image", "config"]
    assert len(body["connections"]) == 2
    assert len(body["warnings"]) == 1
    config = body["nodes"][-1]
    assert config["data"]["draft"]["model"] == "gpt-image-2"
    stored = read_canvas_document(project.project_id)
    assert stored.revision == 1 and "warnings" not in stored.model_dump()


def test_reproduce_without_model_leaves_config_model_empty(client):
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])
    resp = _post(client, project.project_id, asset.asset_id, model=None, alias=None)
    assert resp.status_code == 200, resp.text
    assert resp.json()["nodes"][-1]["data"]["draft"]["model"] in (None, "")


def test_reproduce_if_match_required_and_conflict(client):
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])
    assert _post(client, project.project_id, asset.asset_id, revision=None).status_code == 428
    bad = client.post(
        _url(project.project_id, asset.asset_id),
        json={"position": {"x": 0, "y": 0}}, headers={"If-Match": "abc"},
    )
    assert bad.status_code == 422
    conflict = _post(client, project.project_id, asset.asset_id, revision=5)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"] == {"code": "revision_conflict", "current_revision": 0}
    assert read_canvas_document(project.project_id).nodes == []


def test_reproduce_error_codes(client):
    project = create_canvas_project("复刻")
    media = create_media_asset_from_bytes(
        title="图", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )
    not_generation = _post(client, project.project_id, media.asset_id)
    assert not_generation.status_code == 422, not_generation.text

    asset = _asset([(_REF_A, "reference")])
    assert _post(client, project.project_id, "ca_missing").status_code == 404
    assert _post(client, "cp-missing", asset.asset_id).status_code == 404

    extra = _post(client, project.project_id, asset.asset_id, bogus=True)
    assert extra.status_code == 422

    row = asset.content.snapshot.inputs[0]
    blob_path_for(row.sha256, row.mime_type).unlink()
    state = _post(client, project.project_id, asset.asset_id)
    assert state.status_code == 409, state.text
    assert isinstance(state.json()["detail"], str)
    assert read_canvas_document(project.project_id).nodes == []


def test_reproduce_draft_validation_error_is_422(client, monkeypatch):
    from pydantic import BaseModel, ValidationError

    from character_workflow.lib import canvas_reproduce

    class _Strict(BaseModel):
        value: int

    def broken(**_kwargs):
        try:
            _Strict(value="x")
        except ValidationError as error:
            raise error

    monkeypatch.setattr(canvas_reproduce, "reproduce_generation_asset_into_canvas", broken)
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])
    resp = _post(client, project.project_id, asset.asset_id)
    assert resp.status_code == 422, resp.text
