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
    # 标题先于来源校验：来源不存在时也报 invalid 而不是 404。
    blank_missing = _from_job(client, "job-missing", title="   ")
    assert blank_missing.status_code == 422
    assert blank_missing.json()["detail"]["code"] == "invalid"
    long_tag = _from_job(client, fresh.job_id, tags=["标" * 41])
    assert long_tag.status_code == 422 and long_tag.json()["detail"]["code"] == "invalid"
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


@pytest.fixture
def raw_client(isolated_data_root):
    """服务端异常回 500 而不是在测试里抛出。"""
    return TestClient(
        base_url="http://127.0.0.1",
        app=build_app(dist_dir=isolated_data_root / "dist"),
        raise_server_exceptions=False,
    )


def test_from_job_corrupted_job_file_is_500_not_invalid(raw_client, isolated_data_root):
    job = _studio_job(png((90, 0, 0)), {})
    (isolated_data_root / ".runtime" / "jobs" / f"{job.job_id}.json").write_text(
        "{不是 json", encoding="utf-8"
    )
    resp = _from_job(raw_client, job.job_id)
    assert resp.status_code == 500, resp.text


def _state_broken(*_args, **_kwargs):
    from character_workflow.lib.creation_assets import CreationAssetStateError

    raise CreationAssetStateError("创作资产库状态损坏")


def test_creation_asset_state_error_is_500_asset_state_broken(client, monkeypatch):
    """本机资产库坏了刷新也修不好：一律 500 asset_state_broken，不是 409（前端 409 = 刷新重试）。"""
    from character_workflow.lib import creation_assets, generation_recipe

    job = _studio_job(png((90, 0, 0)), {})
    monkeypatch.setattr(generation_recipe, "save_generation_asset", _state_broken)
    monkeypatch.setattr(creation_assets, "create_prompt_asset", _state_broken)
    prompt = client.post("/api/creation-assets/prompts", json={
        "title": "模板", "segments": [{"kind": "text", "text": "猫"}], "tags": [],
    })
    for resp in (_from_job(client, job.job_id), prompt):
        assert resp.status_code == 500, resp.text
        assert resp.json()["detail"] == {
            "code": "asset_state_broken", "message": "创作资产库状态损坏",
        }


def test_from_canvas_missing_canvas_json_is_500(raw_client):
    from character_workflow.lib.canvas_projects import canvas_project_dir

    project_id, job, _document = canvas_run_with_inputs(
        png((0, 90, 0)), png((0, 0, 90)), png((90, 0, 0))
    )
    node_id, version_id = result_version(job)
    (canvas_project_dir(project_id) / "canvas.json").unlink()
    resp = _from_canvas(raw_client, project_id, node_id, version_id)
    assert resp.status_code == 500, resp.text
    assert resp.json()["detail"]["code"] == "canvas_document_missing"


@pytest.mark.parametrize(("path", "field"), [
    ("/api/creation-assets/staleness", "asset_ids"),
    ("/api/creation-assets/generation/from-job", "job_id"),
    ("/api/creation-assets/generation/from-canvas", "canvas_project_id"),
])
def test_static_paths_are_not_swallowed_by_asset_id_routes(client, path, field):
    """同段数的 {asset_id} 路由（DELETE /creation-assets/{asset_id} 等）只能是部分匹配，
    请求必须落到静态路由上：空请求体按各自的请求模型报缺字段，而不是 404 / 405。"""
    resp = client.post(path, json={})
    assert resp.status_code == 422, resp.text
    missing = {tuple(row["loc"]) for row in resp.json()["detail"] if row["type"] == "missing"}
    assert ("body", field) in missing
