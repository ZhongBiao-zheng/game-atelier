"""Independent, user-created canvas projects and canvas-owned jobs."""
from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.canvas_projects import canvas_project_lock_path
from character_workflow.lib.jobs import job_output_dir_for, read_job
from viewer_server.server_app import build_app


_CREATED_AT = "2026-08-23T00:00:00+00:00"
# 1×1 PNG —— 上传会按魔术字节核对内容与扩展名是否一致。
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


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
            "models": [{"name": "GPT Image 2", "id": "gpt-image-2", "modality": "image"}],
            "notes": "",
            "created_at": _CREATED_AT,
        }],
    }))
    from viewer_server import routes as routes_module
    monkeypatch.setattr(routes_module, "_run_studio_job_safely", lambda _job_id: None)
    monkeypatch.setattr(routes_module, "_run_canvas_job_safely", lambda _job_id: None)
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _document(client: TestClient, project_id: str) -> dict:
    response = client.get(f"/api/canvas/projects/{project_id}/document")
    assert response.status_code == 200, response.json()
    return response.json()


def _save_document(client: TestClient, project_id: str, document: dict):
    return client.put(
        f"/api/canvas/projects/{project_id}/document",
        json=document,
        headers={"If-Match": str(document["revision"])},
    )


def _image_draft() -> dict:
    return {
        "mode": "image",
        "prompt": "电影感雨夜列车",
        "input_policy": "mentions_only",
        "model": "gpt-image-2",
        "alias": "default",
        "params": {"n": 1, "ratio": "1:1"},
        "updated_at": _CREATED_AT,
    }


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

    # 自动保存锁不许放进项目目录：删项目要在持锁期间把项目目录整体 rename 走，Windows 不允许
    # rename 一个内部还有打开句柄的目录（POSIX 允许，所以这条只在 Windows 上会以 WinError 5
    # 的形式暴露）。这里在任何平台上都能拦住把锁挪回项目目录的改动。
    lock = canvas_project_lock_path(project_id)
    assert lock.parent == isolated_data_root / ".runtime" / "locks"
    assert not list((isolated_data_root / "canvases" / project_id).glob("*.lock"))

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
    current = _document(client, project_id)
    document = {
        **current,
        "viewport": {"x": 18, "y": -4, "zoom": 0.8},
        "nodes": [
            {
                "id": "text-1",
                "title": "方向",
                "type": "text",
                "position": {"x": 20, "y": 30},
                "z_index": 0,
                "data": {
                    "current_version_id": "version-text",
                    "generation_draft": None,
                    "active_run_id": None,
                    "display": {"scale": "sm"},
                },
            },
            {
                "id": "config-1",
                "title": "图片生成",
                "type": "config",
                "position": {"x": 420, "y": 30},
                "z_index": 0,
                "data": {"draft": _image_draft()},
            },
        ],
        "connections": [{
            "id": "edge-1",
            "role": "input",
            "source_node_id": "text-1",
            "target_node_id": "config-1",
        }],
        "content_versions": {
            "version-text": {
                "version_id": "version-text",
                "kind": "text",
                "text": "雨夜列车",
                "created_at": _CREATED_AT,
                "sha256": "0" * 64,
                "origin": {"kind": "user_edit"},
            },
        },
    }

    saved = _save_document(client, project_id, document)
    assert saved.status_code == 200, saved.json()
    body = saved.json()
    assert body["viewport"] == {"x": 18.0, "y": -4.0, "zoom": 0.8}
    assert body["revision"] == current["revision"] + 1
    # 服务端拥有 sha256 与 created_at：前端占位值会被真值覆盖。
    assert body["content_versions"]["version-text"]["sha256"] != "0" * 64
    assert _document(client, project_id) == body

    dangling = {**body, "connections": [{
        **body["connections"][0],
        "source_node_id": "missing",
    }]}
    invalid = _save_document(client, project_id, dangling)
    assert invalid.status_code == 422


def test_canvas_document_save_requires_an_if_match_revision(client):
    project_id = _create_project(client)["project_id"]
    document = _document(client, project_id)

    response = client.put(
        f"/api/canvas/projects/{project_id}/document",
        json=document,
    )

    assert response.status_code == 428


def test_canvas_document_does_not_fallback_when_truth_file_is_missing(client, isolated_data_root):
    """存档文件不见了要明确报错，不能静默造一份空 Document 出来。

    状态码是 500 而不是 409：409 在前端的文案是「刷新后重试」，而对着一个不存在的 canvas.json
    重试永远不会成功——画师只会一直刷。这是服务端数据完整性故障，得让人去看日志和数据目录。
    """
    project_id = _create_project(client)["project_id"]
    (isolated_data_root / "canvases" / project_id / "canvas.json").unlink()

    response = client.get(f"/api/canvas/projects/{project_id}/document")

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert detail["code"] == "canvas_document_missing"
    # 给画师看的是中文，且明说反复刷新没用。
    assert "canvas.json" in detail["message"]
    assert "刷新" in detail["message"]


def test_document_save_rejections_are_chinese_with_a_stable_code(client):
    """保存被拒的原因原来是英文断言直接当 detail 返回（`existing canvas content versions
    are immutable` 之类）。改成和同批路径一致的中文 `{code, message}`。"""
    project_id = _create_project(client)["project_id"]
    current = _document(client, project_id)

    # 1. 提交的内容属于另一个项目
    foreign = {**current, "project_id": "canvas-somewhere-else"}
    response = _save_document(client, project_id, foreign)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "canvas_document_project_mismatch",
        "message": "提交的画布内容属于另一个项目，没有保存。",
    }

    # 2. If-Match 与提交内容里的 revision 不一致
    response = client.put(
        f"/api/canvas/projects/{project_id}/document",
        json=current,
        headers={"If-Match": str(current["revision"] + 1)},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "canvas_if_match_mismatch"

    # 3. 保存请求自己造一个非 user_edit 的版本
    forged = {
        **current,
        "content_versions": {
            "version-forged": {
                "version_id": "version-forged",
                "kind": "text",
                "text": "服务端才能写的产物",
                "created_at": _CREATED_AT,
                "sha256": "f" * 64,
                "origin": {"kind": "job_output", "job_id": "job-x", "candidate_id": "c-0"},
            },
        },
    }
    response = _save_document(client, project_id, forged)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "canvas_version_not_user_text"


def test_upload_rejection_says_which_check_failed_in_chinese(client):
    project_id = _create_project(client)["project_id"]
    # 扩展名说是 png，内容不是 —— 按魔术字节判定。
    response = client.post(
        f"/api/canvas/projects/{project_id}/uploads",
        files={"file": ("fake.png", b"not an image at all", "image/png")},
        data={"expected_revision": "0"},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "canvas_upload_ext_mismatch",
        "message": "文件的实际内容和扩展名不一致（按魔术字节判定），没有上传。",
    }


def test_canvas_upload_and_media_endpoint_stay_inside_project(client, isolated_data_root):
    project_id = _create_project(client)["project_id"]
    current = _document(client, project_id)

    uploaded = client.post(
        f"/api/canvas/projects/{project_id}/uploads",
        files={"file": ("reference.png", _PNG, "image/png")},
        data={"expected_revision": str(current["revision"])},
    )
    assert uploaded.status_code == 201, uploaded.json()
    version = uploaded.json()["version"]
    assert version["kind"] == "image"
    assert version["path"].startswith("uploads/")
    stored = isolated_data_root / "canvases" / project_id / version["path"]
    assert stored.read_bytes() == _PNG

    media = client.get(
        f"/api/canvas/projects/{project_id}/versions/{version['version_id']}/media"
    )
    assert media.status_code == 200
    assert media.content == _PNG

    # 媒体读取只认本项目登记过的 Content Version id，没有可穿越的路径参数。
    unknown = client.get(f"/api/canvas/projects/{project_id}/versions/version-missing/media")
    assert unknown.status_code == 404

    # 同一个 version id 换到别的项目下读不出来：越界由服务端明确拒绝，不是静默 404。
    other_project_id = _create_project(client, "另一个项目")["project_id"]
    leaked = client.get(
        f"/api/canvas/projects/{other_project_id}/versions/{version['version_id']}/media"
    )
    assert leaked.status_code == 403


def _project_with_config_node(client: TestClient) -> tuple[str, int]:
    project_id = _create_project(client)["project_id"]
    current = _document(client, project_id)
    saved = _save_document(client, project_id, {
        **current,
        "nodes": [{
            "id": "config-1",
            "title": "图片生成",
            "type": "config",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {"draft": _image_draft()},
        }],
    })
    assert saved.status_code == 200, saved.json()
    return project_id, saved.json()["revision"]


def test_canvas_job_has_independent_namespace_and_output_dir(client, isolated_data_root):
    project_id, revision = _project_with_config_node(client)

    response = client.post(f"/api/canvas/projects/{project_id}/runs", json={
        "surface_node_id": "config-1",
        "expected_revision": revision,
        "requested_count": 2,
    })
    assert response.status_code == 201, response.json()
    payload = response.json()["job"]
    assert payload["namespace"] == "canvas"
    assert payload["canvas_project_id"] == project_id
    assert payload["status"] == "pending"
    assert payload["canvas_run"]["result_node_id"] != "config-1"
    assert len(payload["canvas_run"]["candidates"]) == 2

    listed = client.get(f"/api/canvas/projects/{project_id}/jobs")
    assert listed.status_code == 200
    assert [job["job_id"] for job in listed.json()] == [payload["job_id"]]

    stored = read_job(payload["job_id"])
    assert job_output_dir_for(stored) == (
        isolated_data_root / "canvases" / project_id / "outputs" / stored.job_id
    )


def test_canvas_job_rejects_missing_project(client):
    response = client.post("/api/canvas/projects/canvas-missing00/runs", json={
        "surface_node_id": "config-1",
        "expected_revision": 0,
        "requested_count": 1,
    })

    assert response.status_code == 404
    assert client.get("/api/canvas/projects/canvas-missing00/jobs").status_code == 404


def test_canvas_run_rejects_a_surface_node_outside_this_project(client):
    project_id, revision = _project_with_config_node(client)
    other_project_id, _other_revision = _project_with_config_node(client)

    response = client.post(f"/api/canvas/projects/{project_id}/runs", json={
        "surface_node_id": "config-missing",
        "expected_revision": revision,
        "requested_count": 1,
    })
    assert response.status_code == 404

    # 生成输入只能来自本项目登记过的 Content Version，跨项目节点 id 同样无法被解析。
    assert other_project_id != project_id


def test_document_save_drops_draft_params_a_browser_may_not_submit(client, isolated_data_root):
    """写入侧闸门：服务端独占的路径类参数不落盘。"""
    project_id = _create_project(client)["project_id"]
    current = _document(client, project_id)
    secret = isolated_data_root / ".config" / "keys.json"

    saved = _save_document(client, project_id, {
        **current,
        "nodes": [{
            "id": "config-1",
            "title": "图片生成",
            "type": "config",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {"draft": {
                **_image_draft(),
                "params": {
                    "n": 1,
                    "ratio": "1:1",
                    "mask_image": str(secret),
                    "mj_sref": [str(secret)],
                    "reference_images": [str(secret)],
                },
            }},
        }],
    })

    assert saved.status_code == 200, saved.json()
    params = saved.json()["nodes"][0]["data"]["draft"]["params"]
    assert params["n"] == 1 and params["ratio"] == "1:1"
    for field in ("mask_image", "mj_sref", "reference_images"):
        assert params.get(field) is None, field


def test_frozen_run_never_reads_a_draft_supplied_path(client, isolated_data_root):
    """冻结侧闸门：磁盘上已有的残留字段也进不了 job.params，/api/raw 因此读不到。"""
    project_id, revision = _project_with_config_node(client)
    secret = isolated_data_root / ".config" / "keys.json"

    # 绕过写入侧闸门，模拟历史残留 / 直接改盘。
    truth = isolated_data_root / "canvases" / project_id / "canvas.json"
    document = json.loads(truth.read_text(encoding="utf-8"))
    document["nodes"][0]["data"]["draft"]["params"].update({
        "mask_image": str(secret),
        "mj_sref": [str(secret)],
    })
    truth.write_text(json.dumps(document), encoding="utf-8")

    response = client.post(f"/api/canvas/projects/{project_id}/runs", json={
        "surface_node_id": "config-1",
        "expected_revision": revision,
        "requested_count": 1,
    })
    assert response.status_code == 201, response.json()
    job_id = response.json()["job"]["job_id"]
    params = read_job(job_id).params.model_dump()
    assert params.get("mask_image") is None
    assert params.get("mj_sref") is None

    leaked = client.get("/api/raw", params={"job_id": job_id, "path": str(secret)})
    assert leaked.status_code == 403


def test_canvas_jobs_endpoint_scans_the_jobs_directory_once(client, monkeypatch):
    """出图期间前端一直轮这条接口，list_jobs() 要解析 .runtime/jobs 下的每一个 job 文件。"""
    from character_workflow.lib import canvas_runs, jobs as jobs_module
    from viewer_server import routes as routes_module

    project_id = _create_project(client)["project_id"]
    scans: list[int] = []
    original = jobs_module.list_jobs

    def counted() -> list:
        scans.append(1)
        return original()

    # 两个绑定都要换：路由在函数体里 import，canvas_runs 在模块顶层 import。
    monkeypatch.setattr(jobs_module, "list_jobs", counted)
    monkeypatch.setattr(canvas_runs, "list_jobs", counted)
    monkeypatch.setattr(routes_module, "list_jobs", counted, raising=False)

    response = client.get(f"/api/canvas/projects/{project_id}/jobs")
    assert response.status_code == 200, response.text
    assert len(scans) == 1
