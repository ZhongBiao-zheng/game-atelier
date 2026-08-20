"""B3: screen 风格候选与定稿 —— params 来源关系 / canonical 读写 / CLI / API。"""
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


@pytest.fixture
def screen_images(isolated_data_root, project):
    d = isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens" / "home"
    d.mkdir(parents=True)
    for name in ("v1.png", "v2.png", "v3.png"):
        (d / name).write_bytes(b"\x89PNG\r\n\x1a\n")
    return d


# ---------- lib ----------

def test_set_and_read_screen_canonical(project, screen_images):
    file = ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v2.png"))
    assert file.screens["home"].path == "projects/mohuan/ui/v1/screens/home/v2.png"
    assert ui_jobs.read_screen_canonical(project.id, "v1").screens["home"].path.endswith("v2.png")


def test_set_screen_canonical_accepts_relative_path(project, screen_images):
    file = ui_jobs.set_screen_canonical(
        project.id, "v1", "home", "projects/mohuan/ui/v1/screens/home/v1.png",
    )
    assert file.screens["home"].path == "projects/mohuan/ui/v1/screens/home/v1.png"


def test_set_screen_canonical_replaces_previous(project, screen_images):
    ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v1.png"))
    file = ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v3.png"))
    assert file.screens["home"].path.endswith("v3.png")
    assert len(file.screens) == 1


def test_set_screen_canonical_rejects_other_screen_dir(isolated_data_root, project, screen_images):
    other = isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens" / "battle"
    other.mkdir(parents=True)
    (other / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    with pytest.raises(ValueError):
        ui_jobs.set_screen_canonical(project.id, "v1", "home", str(other / "v1.png"))


def test_set_screen_canonical_rejects_missing_file(project, screen_images):
    with pytest.raises(FileNotFoundError):
        ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "nope.png"))


def test_clear_screen_canonical(project, screen_images):
    ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v1.png"))
    file = ui_jobs.clear_screen_canonical(project.id, "v1", "home")
    assert "home" not in file.screens


def test_corrupt_canonical_degrades_to_empty(project, screen_images):
    (screen_images.parent / "canonical.json").write_text("{ broken", encoding="utf-8")
    assert ui_jobs.read_screen_canonical(project.id, "v1").screens == {}


def test_style_variant_auto_resolved_from_job(project, screen_images):
    """定稿不必重复报风格标签 —— 从产出这张图的 job 反查。"""
    job = jobs.write_job(
        job_id="job-ui-v2", character_id="", prompt="p", model="m",
        params={"style_variant": "厚涂写实", "base_version": "v1.png"},
        namespace="ui", project_id=project.id, ui_scheme_id="v1", screen_id="home", alias=None,
    )
    jobs.save_job(job.model_copy(update={"output_paths": [str(screen_images / "v2.png")]}))
    file = ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v2.png"))
    assert file.screens["home"].style_variant == "厚涂写实"


def test_style_variant_empty_when_no_job_matches(project, screen_images):
    file = ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen_images / "v1.png"))
    assert file.screens["home"].style_variant == ""


# ---------- CLI ----------

def test_submit_screen_records_variant_and_base(tmp_path, capsys, project):
    _seed_key()
    prompt_file = tmp_path / "p.txt"
    prompt_file.write_text("首页·厚涂写实", encoding="utf-8")
    rc = main([
        "submit-screen", "--project", "mohuan", "--screen", "home",
        "--prompt-file", str(prompt_file),
        "--style-variant", "厚涂写实", "--base-version", "v1.png",
    ])
    assert rc == 0
    job = jobs.read_job(capsys.readouterr().out.strip())
    assert job.params.style_variant == "厚涂写实"
    assert job.params.base_version == "v1.png"


def test_set_screen_canonical_cli(capsys, project, screen_images):
    rc = main([
        "set-screen-canonical", "--project", "mohuan", "--screen", "home",
        "--path", str(screen_images / "v3.png"),
    ])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["screens"]["home"]["path"].endswith("v3.png")

    assert main(["set-screen-canonical", "--project", "mohuan", "--screen", "home", "--clear"]) == 0
    assert json.loads(capsys.readouterr().out)["screens"] == {}


def test_set_screen_canonical_cli_requires_path(capsys, project):
    assert main(["set-screen-canonical", "--project", "mohuan", "--screen", "home"]) == 1
    assert "error" in json.loads(capsys.readouterr().out)


# ---------- API ----------

@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def test_screen_canonical_api_roundtrip(client, project, screen_images):
    r = client.post(
        f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical",
        json={"screen_id": "home", "path": "projects/mohuan/ui/v1/screens/home/v2.png"},
    )
    assert r.status_code == 200
    assert r.json()["screens"]["home"]["path"] == "projects/mohuan/ui/v1/screens/home/v2.png"

    assert client.get(f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical").json()["screens"]["home"]

    cleared = client.post(
        f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical",
        json={"screen_id": "home", "path": None},
    )
    assert cleared.json()["screens"] == {}


def test_screen_canonical_api_errors(client, project, screen_images):
    assert client.get("/api/projects/p-nope/ui-schemes/v1/screens/canonical").status_code == 404
    missing = client.post(
        f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical",
        json={"screen_id": "home", "path": "projects/mohuan/ui/v1/screens/home/nope.png"},
    )
    assert missing.status_code == 404
    outside = client.post(
        f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical",
        json={"screen_id": "home", "path": "characters/x/portrait/v1.png"},
    )
    assert outside.status_code in (400, 404)


def test_gallery_screens_exposes_variant_metadata(client, project, screen_images):
    job = jobs.write_job(
        job_id="job-ui-var", character_id="", prompt="p", model="m",
        params={"style_variant": "扁平卡通", "base_version": "v1.png"},
        namespace="ui", project_id=project.id, ui_scheme_id="v1", screen_id="home", alias=None,
    )
    jobs.save_job(job.model_copy(update={"output_paths": [str(screen_images / "v2.png")]}))
    items = client.get(f"/api/gallery/screens?project={project.id}&scheme=v1").json()["items"]
    tagged = next(i for i in items if i["filename"] == "v2.png")
    assert tagged["style_variant"] == "扁平卡通"
    assert tagged["base_version"] == "v1.png"
    plain = next(i for i in items if i["filename"] == "v1.png")
    assert plain["style_variant"] is None
