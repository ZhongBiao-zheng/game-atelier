"""P3 创作资产路由：生成结果保存为生成资产（Studio / 画布），静态路径不被 {asset_id} 通配吞掉。"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from tests.local_client import LocalTestClient as TestClient
from tests.test_generation_recipe import (
    _studio_job,
    _upload,
    canvas_run_with_inputs,
    png,
    result_version,
)

from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _from_job(client, job_id: str, **extra):
    return client.post("/api/creation-assets/generation/from-job", json={
        "job_id": job_id, "output_index": 0, "title": "红猫", "tags": ["猫"], **extra,
    })


def _from_canvas(client, canvas_id: str, node_id: str, version_id: str, **extra):
    return client.post("/api/creation-assets/generation/from-canvas", json={
        "canvas_project_id": canvas_id, "node_id": node_id, "version_id": version_id,
        "title": "画布结果", **extra,
    })


def test_from_job_creates_generation_asset(client, isolated_data_root):
    ref = png((0, 90, 0))
    upload = _upload(isolated_data_root, "ref.png", ref)
    job = _studio_job(png((90, 0, 0)), {"reference_images": [str(upload)]})
    resp = _from_job(client, job.job_id, project_id="canvas-1")
    assert resp.status_code == 201, resp.text
    asset = resp.json()
    assert asset["kind"] == "generation" and asset["title"] == "红猫" and asset["tags"] == ["猫"]
    assert asset["project_ids"] == ["canvas-1"]
    snapshot = asset["content"]["snapshot"]
    assert snapshot["model"] == "gpt-image-2"
    assert [row["sha256"] for row in snapshot["inputs"]] == [hashlib.sha256(ref).hexdigest()]
    listed = client.get("/api/creation-assets", params={"kind": "generation"}).json()["assets"]
    assert [row["asset_id"] for row in listed] == [asset["asset_id"]]
    reference = client.get(f"/api/creation-assets/{asset['asset_id']}/inputs/0")
    assert reference.status_code == 200 and reference.content == ref


def test_from_job_errors(client, isolated_data_root):
    assert _from_job(client, "job-missing").status_code == 404

    job = _studio_job(png((90, 0, 0)), {})
    out_of_range = _from_job(client, job.job_id, output_index=3)
    assert out_of_range.status_code == 422, out_of_range.text
    assert out_of_range.json()["detail"]["code"] == "not_shareable"
    assert out_of_range.json()["detail"]["message"]

    Path(job.output_paths[0]).unlink()
    gone = _from_job(client, job.job_id)
    assert gone.status_code == 422 and gone.json()["detail"]["code"] == "source_missing"

    fresh = _studio_job(png((90, 0, 0)), {})
    blank = _from_job(client, fresh.job_id, title="   ")
    assert blank.status_code == 422 and blank.json()["detail"]["code"] == "invalid"
    assert client.get("/api/creation-assets").json()["assets"] == []

    extra = client.post("/api/creation-assets/generation/from-job", json={
        "job_id": fresh.job_id, "output_index": 0, "title": "红猫", "bogus": 1,
    })
    assert extra.status_code == 422


def test_from_canvas_creates_generation_asset_in_the_canvas_project(client):
    ref_a, ref_b = png((0, 90, 0)), png((0, 0, 90))
    project_id, job, _document = canvas_run_with_inputs(ref_a, ref_b, png((90, 0, 0)))
    node_id, version_id = result_version(job)
    resp = _from_canvas(client, project_id, node_id, version_id, tags=["狐狸"])
    assert resp.status_code == 201, resp.text
    asset = resp.json()
    assert asset["kind"] == "generation" and asset["project_ids"] == [project_id]
    assert [row["sha256"] for row in asset["content"]["snapshot"]["inputs"]] == [
        hashlib.sha256(body).hexdigest() for body in (ref_a, ref_b)
    ]


def test_from_canvas_errors(client):
    from character_workflow.lib.canvas_projects import read_canvas_document

    project_id, job, _document = canvas_run_with_inputs(
        png((0, 90, 0)), png((0, 0, 90)), png((90, 0, 0))
    )
    node_id, version_id = result_version(job)
    assert _from_canvas(client, "cp-missing", node_id, version_id).status_code == 404
    assert _from_canvas(client, project_id, node_id, "version-missing").status_code == 404
    assert _from_canvas(client, project_id, "image-a", version_id).status_code == 404
    upload_version = next(
        node.data.current_version_id
        for node in read_canvas_document(project_id).nodes if node.id == "image-a"
    )
    resp = _from_canvas(client, project_id, "image-a", upload_version)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "not_shareable"
    with_project = _from_canvas(client, project_id, node_id, version_id, project_id="x")
    assert with_project.status_code == 422  # project_id 取 canvas_project_id，不收


@pytest.mark.parametrize("path", [
    "/api/creation-assets/staleness",
    "/api/creation-assets/generation/from-job",
    "/api/creation-assets/generation/from-canvas",
])
def test_static_paths_are_not_swallowed_by_asset_id_routes(client, path):
    """同段数的 {asset_id} 路由（DELETE /creation-assets/{asset_id} 等）只能是部分匹配，
    请求必须落到静态路由上：空请求体按各自的请求模型报 422，而不是 404 / 405。"""
    resp = client.post(path, json={})
    assert resp.status_code == 422, resp.text
    assert isinstance(resp.json()["detail"], list)
    fields = {tuple(row["loc"]) for row in resp.json()["detail"]}
    assert all(loc[0] == "body" for loc in fields)
