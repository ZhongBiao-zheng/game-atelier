"""B2: UI 页面 job —— screen_id 校验 / 输出目录 / submit-screen CLI / screens 端点 / 图片服务。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.__main__ import main
from character_workflow.lib import jobs, keys, projects, ui_jobs
from viewer_server.server_app import build_app


def _seed_key() -> None:
    keys.write_keys_db(keys.KeysDB.model_validate({
        "version": 1,
        "default_alias": "img-main",
        "keys": [{
            "alias": "img-main",
            "provider": "openai",
            "access_key": "ak_test",
            "secret_key": None,
            "capabilities": ["portrait", "promo", "turnaround"],
            "models": [{"name": "GPT Image", "id": "gpt-image-1"}],
            "created_at": "2026-08-10T00:00:00+08:00",
        }],
    }))


@pytest.fixture
def project():
    return projects.create_project("魔幻", slug="mohuan")


# ---------- ui_jobs lib ----------

def test_validate_screen_id_rejects_traversal_and_uppercase():
    for bad in ("../evil", "a/b", "Home", "", "-lead", "空格 id"):
        with pytest.raises(ValueError):
            ui_jobs.validate_screen_id(bad)
    assert ui_jobs.validate_screen_id("home-v2") == "home-v2"


def test_screen_output_dir_lands_in_project_screens(isolated_data_root, project):
    out = ui_jobs.screen_output_dir(project.id, "v1", "home")
    assert out == isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens" / "home"


def test_screen_output_dir_requires_both_fields(project):
    with pytest.raises(ValueError):
        ui_jobs.screen_output_dir(project.id, "v1", None)
    with pytest.raises(ValueError):
        ui_jobs.screen_output_dir(None, "v1", "home")
    with pytest.raises(KeyError):
        ui_jobs.screen_output_dir("p-nope", "v1", "home")


def test_resolve_project_accepts_id_or_slug(project):
    assert projects.resolve_project(project.id).id == project.id
    assert projects.resolve_project("mohuan").id == project.id
    with pytest.raises(KeyError):
        projects.resolve_project("nope")


# ---------- write_job + 输出目录派发 ----------

def test_write_job_ui_namespace_roundtrip(project):
    job = jobs.write_job(
        job_id="job-ui-1", character_id="", prompt="p", model="m", params={},
        namespace="ui", project_id=project.id, ui_scheme_id="v1", screen_id="home", alias=None,
    )
    loaded = jobs.read_job("job-ui-1")
    assert loaded.namespace == "ui"
    assert loaded.project_id == project.id
    assert loaded.screen_id == "home"
    assert jobs.job_output_dir_for(job).as_posix().endswith("projects/mohuan/ui/v1/screens/home")


# ---------- submit-screen CLI ----------

def test_submit_screen_cli_writes_pending_confirm_job(tmp_path, capsys, project):
    _seed_key()
    prompt_file = tmp_path / "prompt.txt"
    prompt_file.write_text("首页基准页", encoding="utf-8")
    rc = main([
        "submit-screen", "--project", "mohuan", "--screen", "home",
        "--prompt-file", str(prompt_file),
    ])
    assert rc == 0
    job_id = capsys.readouterr().out.strip()
    job = jobs.read_job(job_id)
    assert job.status.value == "pending_confirm"
    assert job.namespace == "ui"
    assert job.project_id == project.id
    assert job.screen_id == "home"
    assert job.alias == "img-main"
    assert job.model == "gpt-image-1"


def test_submit_screen_cli_rejects_bad_screen_id(tmp_path, capsys, project):
    _seed_key()
    prompt_file = tmp_path / "prompt.txt"
    prompt_file.write_text("x", encoding="utf-8")
    rc = main([
        "submit-screen", "--project", "mohuan", "--screen", "../Evil",
        "--prompt-file", str(prompt_file),
    ])
    assert rc == 1


def test_submit_screen_cli_unknown_project(tmp_path, project):
    _seed_key()
    prompt_file = tmp_path / "prompt.txt"
    prompt_file.write_text("x", encoding="utf-8")
    assert main([
        "submit-screen", "--project", "nope", "--screen", "home",
        "--prompt-file", str(prompt_file),
    ]) == 1


# ---------- /api/jobs 全量校验 + screens 端点 ----------

@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def test_api_jobs_accepts_ui_job(client, project):
    jobs.write_job(
        job_id="job-ui-2", character_id="", prompt="p", model="m", params={},
        namespace="ui", project_id=project.id, ui_scheme_id="v1", screen_id="home", alias=None,
    )
    r = client.get("/api/jobs")
    assert r.status_code == 200
    ui = [j for j in r.json() if j["job_id"] == "job-ui-2"]
    assert ui and ui[0]["screen_id"] == "home" and ui[0]["project_id"] == project.id


def test_gallery_screens_lists_by_screen(client, isolated_data_root, project):
    d = isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens"
    (d / "home").mkdir(parents=True)
    (d / "home" / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (d / "home" / "v1.md").write_text("sidecar", encoding="utf-8")
    (d / "battle").mkdir()
    (d / "battle" / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    r = client.get(f"/api/gallery/screens?project={project.id}&scheme=v1")
    assert r.status_code == 200
    items = r.json()["items"]
    assert {(i["screen_id"], i["filename"]) for i in items} == {
        ("home", "v1.png"), ("battle", "v1.png"),
    }
    assert all(i["path"].startswith("projects/mohuan/ui/v1/screens/") for i in items)


def test_gallery_screens_404_unknown_project(client):
    assert client.get("/api/gallery/screens?project=nope&scheme=v1").status_code == 404


def test_gallery_image_serves_screens_but_not_project_docs(client, isolated_data_root, project):
    d = isolated_data_root / "projects" / "mohuan"
    (d / "ui" / "v1" / "screens" / "home").mkdir(parents=True)
    (d / "ui" / "v1" / "screens" / "home" / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (d / "style.md").write_text("secret", encoding="utf-8")
    ok = client.get("/api/gallery/image?path=projects/mohuan/ui/v1/screens/home/v1.png")
    assert ok.status_code == 200
    bad = client.get("/api/gallery/image?path=projects/mohuan/style.md")
    assert bad.status_code == 400


def test_job_json_dump_keeps_new_fields(project):
    job = jobs.write_job(
        job_id="job-ui-3", character_id="", prompt="p", model="m", params={},
        namespace="ui", project_id=project.id, ui_scheme_id="v1", screen_id="inventory", alias=None,
    )
    dumped = json.loads(job.model_dump_json())
    assert dumped["project_id"] == project.id
    assert dumped["screen_id"] == "inventory"
