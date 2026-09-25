"""浏览器提交的参考路径闸门：POST /api/studio/jobs 与 POST /api/prompt/{job_id}，
以及 /api/raw 不能借登记在 job 上的路径读出数据根外的文件。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from character_workflow.lib.jobs import read_job
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app

_REF_FIELDS = (
    "reference_images", "reference_videos", "reference_audios", "mj_sref", "mj_cref", "mj_oref",
)


@pytest.fixture
def client(isolated_data_root, monkeypatch):
    (isolated_data_root / ".config" / "keys.json").write_text(json.dumps({
        "version": 1,
        "default_alias": "default",
        "keys": [{
            "alias": "default", "provider": "openai", "access_key": "sk-fake",
            "secret_key": None, "capabilities": [], "models": [], "notes": "",
            "created_at": "2026-05-25T00:00:00+00:00",
        }],
    }))
    from viewer_server import routes as routes_module
    monkeypatch.setattr(routes_module, "_run_studio_job_safely", lambda _job_id: None)
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n")
    return path


def _create(client, params: dict):
    return client.post("/api/studio/jobs", json={
        "prompt": "a quiet warm gallery", "model": "gpt-image-2", "params": params,
    })


def _forbidden_paths(root: Path) -> list[str]:
    _touch(root / ".runtime" / "jobs" / "x.json")
    secret = _touch(root.parent / "secret.png")
    link = root / ".runtime" / "uploads" / "link.png"
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.is_symlink():
        link.symlink_to(secret)
    return [
        "/etc/hosts",
        str(Path.home() / ".ssh" / "id_rsa"),
        str(root / ".config" / "keys.json"),
        str(root / ".runtime" / "jobs" / "x.json"),
        str(root / ".runtime" / "uploads" / ".." / ".." / ".config" / "keys.json"),
        str(root / ".runtime" / "uploads" / ".." / "jobs" / "x.json"),
        str(root / ".Config" / "keys.json"),
        str(root / ".RUNTIME" / "jobs" / "x.json"),
        f"characters/../../{secret.name}",
        str(link),
        "//etc/hosts",
        "file:///etc/hosts",
        "http:///x",
        "HTTP://evil/../..",
        "characters/a\x00.png",
        "characters/" + "x" * 300 + ".png",
    ]


def _allowed_paths(root: Path) -> list[str]:
    return [
        str(_touch(root / ".runtime" / "uploads" / "a.png")),
        str(_touch(root / "creation-assets" / "blobs" / f"{'a' * 64}.png")),
        str(_touch(root / "studio" / "job-1" / "out.png")),
    ]


@pytest.mark.parametrize("field", _REF_FIELDS)
def test_create_rejects_every_forbidden_reference(client, isolated_data_root, field):
    ok = _allowed_paths(isolated_data_root)[0]
    for bad in _forbidden_paths(isolated_data_root):
        response = _create(client, {field: [ok, bad]})

        assert response.status_code == 422, bad
        assert response.json()["detail"].startswith(f"params.{field} 第 2 项"), bad
    # 只剩测试自己造的 x.json，没有任何 job 落盘。
    jobs = [p.name for p in (isolated_data_root / ".runtime" / "jobs").glob("*.json")]
    assert jobs == ["x.json"]


@pytest.mark.parametrize("field", _REF_FIELDS)
def test_create_accepts_references_inside_data_root(client, isolated_data_root, field):
    allowed = _allowed_paths(isolated_data_root)

    response = _create(client, {field: allowed})

    assert response.status_code == 201, response.text
    stored = read_job(response.json()["job_id"]).params.model_dump()[field]
    assert stored == [str(Path(item).resolve()) for item in allowed]


def test_create_accepts_web_urls_sent_back_by_rerun(client):
    urls = ["https://cdn.example.com/a.png", "http://cdn.example.com/b.png"]

    response = _create(client, {"reference_images": urls})

    assert response.status_code == 201, response.text
    assert response.json()["params"]["reference_images"] == urls


def test_create_drops_browser_supplied_mask_image(client, isolated_data_root):
    response = _create(client, {"mask_image": str(isolated_data_root / ".config" / "keys.json")})

    assert response.status_code == 201
    assert read_job(response.json()["job_id"]).params.mask_image is None


def test_post_prompt_rejects_forbidden_reference_and_keeps_job(client, isolated_data_root):
    job_id = _create(client, {}).json()["job_id"]
    ok = _allowed_paths(isolated_data_root)[0]
    for bad in _forbidden_paths(isolated_data_root):
        response = client.post(f"/api/prompt/{job_id}", json={
            "prompt": "changed", "params": {"mj_cref": [ok, bad]},
        })

        assert response.status_code == 422, bad
        assert response.json()["detail"].startswith("params.mj_cref 第 2 项"), bad
    job = read_job(job_id)
    assert job.prompt == "a quiet warm gallery"
    assert job.params.mj_cref is None


def test_post_prompt_accepts_references_inside_data_root(client, isolated_data_root):
    job_id = _create(client, {}).json()["job_id"]
    allowed = _allowed_paths(isolated_data_root)

    response = client.post(f"/api/prompt/{job_id}", json={
        "params": {"reference_images": allowed, "reference_videos": allowed[:1]},
    })

    assert response.status_code == 200, response.text
    assert read_job(job_id).params.reference_images == [str(Path(p).resolve()) for p in allowed]


def test_post_prompt_cannot_set_mask_image(client, isolated_data_root):
    job_id = _create(client, {}).json()["job_id"]
    keys_file = str(isolated_data_root / ".config" / "keys.json")

    response = client.post(f"/api/prompt/{job_id}", json={"params": {"mask_image": keys_file}})

    assert response.status_code == 200
    assert read_job(job_id).params.mask_image is None
    leaked = client.get("/api/raw", params={"job_id": job_id, "path": keys_file})
    assert leaked.status_code == 403


def test_raw_does_not_resolve_web_url_entries_as_local_paths(client, isolated_data_root):
    # 能过闸门的「网络地址」当路径解析时会穿越到数据根外；白名单里必须跳过它们。
    disguised = "http://" + "../" * 40 + "etc/hosts"
    response = _create(client, {"reference_images": [disguised]})
    assert response.status_code == 201, response.text

    leaked = client.get("/api/raw", params={
        "job_id": response.json()["job_id"], "path": "/etc/hosts",
    })

    assert leaked.status_code == 403


def test_create_stores_resolved_absolute_paths(client, isolated_data_root):
    # 闸门按数据根解析相对路径，caller 按 CWD 读；落盘改写成闸门判过的那个绝对路径。
    target = _touch(isolated_data_root / "characters" / "holy" / "v1.png")
    link = isolated_data_root / "studio" / "alias.png"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(target)
    urls = "https://cdn.example.com/a.png"

    response = _create(client, {
        "reference_images": ["characters/holy/v1.png", str(link), urls],
    })

    assert response.status_code == 201, response.text
    assert read_job(response.json()["job_id"]).params.reference_images == [
        str(target.resolve()), str(target.resolve()), urls,
    ]


def test_create_gates_extra_source_image(client, isolated_data_root):
    response = _create(client, {"source_image": "/etc/hosts"})
    assert response.status_code == 422
    assert response.json()["detail"].startswith("params.source_image 第 1 项")

    allowed = _allowed_paths(isolated_data_root)[0]
    response = _create(client, {"source_image": allowed})
    assert response.status_code == 201, response.text
    assert read_job(response.json()["job_id"]).params.model_dump()["source_image"] == str(
        Path(allowed).resolve(),
    )


def test_post_prompt_gates_extra_source_image(client, isolated_data_root):
    job_id = _create(client, {}).json()["job_id"]

    response = client.post(f"/api/prompt/{job_id}", json={"params": {"source_image": "/etc/hosts"}})

    assert response.status_code == 422
    assert response.json()["detail"].startswith("params.source_image 第 1 项")
    assert "source_image" not in read_job(job_id).params.model_dump()


@pytest.mark.parametrize("variant", [(".Config", "keys.json"), (".RUNTIME", "jobs", "x.json")])
def test_case_variants_cannot_register_and_raw_refuses(client, isolated_data_root, variant):
    _forbidden_paths(isolated_data_root)
    path = str(isolated_data_root.joinpath(*variant))
    job_id = _create(client, {}).json()["job_id"]

    assert _create(client, {"reference_images": [path]}).status_code == 422
    assert client.post(f"/api/prompt/{job_id}", json={
        "params": {"reference_images": [path]},
    }).status_code == 422
    assert client.get("/api/raw", params={"job_id": job_id, "path": path}).status_code == 403
    assert client.get("/api/raw", params={"path": path}).status_code == 403


def test_raw_without_job_id_only_serves_uploads(client, isolated_data_root):
    # 旧的 image_storage_root 兜底已删：配置了也不放行。
    (isolated_data_root / ".runtime" / "config.json").write_text(
        json.dumps({"image_storage_root": str(isolated_data_root)}),
    )
    upload = _touch(isolated_data_root / ".runtime" / "uploads" / "a.png")
    forbidden = [
        str(isolated_data_root / ".config" / "keys.json"),
        str(_touch(isolated_data_root / "characters" / "x.png")),
        "characters/x.png",
        str(_touch(isolated_data_root / "studio" / "j" / "out.png")),
        str(isolated_data_root / ".runtime" / "uploads"),
        "/etc/hosts",
    ]

    for path in forbidden:
        assert client.get("/api/raw", params={"path": path}).status_code == 403, path
    assert client.get("/api/raw", params={"path": str(upload)}).status_code == 200
    assert client.get("/api/raw", params={"path": ".runtime/uploads/a.png"}).status_code == 200


def test_raw_rejects_nul_byte_path_as_bad_request(client):
    job_id = _create(client, {}).json()["job_id"]

    assert client.get("/api/raw", params={"path": "characters/a\x00.png"}).status_code == 400
    assert client.get(
        "/api/raw", params={"job_id": job_id, "path": ".runtime/uploads/a\x00.png"},
    ).status_code == 400


def test_raw_rejects_overlong_file_name_as_bad_request(client, isolated_data_root):
    # 父目录要真实存在：不存在时 stat 先报 ENOENT，走的是普通 404。
    (isolated_data_root / ".runtime" / "uploads").mkdir(parents=True, exist_ok=True)
    job_id = _create(client, {}).json()["job_id"]
    overlong = ".runtime/uploads/" + "x" * 300 + ".png"

    assert client.get("/api/raw", params={"path": overlong}).status_code == 400
    assert client.get("/api/raw", params={"job_id": job_id, "path": overlong}).status_code == 400
