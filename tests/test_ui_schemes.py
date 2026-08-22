from __future__ import annotations

import json
import pytest

from fastapi.testclient import TestClient

from character_workflow.lib import jobs, projects, stale, ui_jobs, ui_schemes
from character_workflow.lib.schemas import UiSchemeCreate
from viewer_server.server_app import build_app


def test_new_project_starts_with_v1(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")

    schemes = ui_schemes.read_schemes(project.id)

    assert schemes.default_scheme_id == "v1"
    assert [(item.id, item.name) for item in schemes.schemes] == [("v1", "V1")]
    assert (isolated_data_root / "projects/mohuan/ui/v1/screens").is_dir()


def test_legacy_ui_is_moved_to_v1_and_references_are_rewritten(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    # Simulate a pre-scheme project by removing the new empty UI root.
    import shutil
    shutil.rmtree(isolated_data_root / "projects/mohuan/ui")
    root = isolated_data_root / "projects/mohuan"
    image = root / "screens/home/v1.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    (root / "style.md").write_text(
        "---\nstatus: approved\n---\n\n## style\n- render: 厚涂\n\n"
        "## ui.typography\n- 标题: 衬线\n\n## taboo\n- 荧光色\n",
        encoding="utf-8",
    )
    legacy_style_fingerprint = stale.style_fingerprint_for_slug("mohuan")
    windows_image = r"C:\data\projects\mohuan\screens\home\v1.png"
    (root / "screens/canonical.json").write_text(json.dumps({
        "screens": {"home": {
            "path": "projects/mohuan/screens/home/v1.png",
            "set_at": "2026-08-20T00:00:00Z",
            "style_variant": "",
            "style_fingerprint": legacy_style_fingerprint,
        }},
    }), encoding="utf-8")
    job_path = isolated_data_root / ".runtime/jobs/job-old-ui.json"
    job_path.parent.mkdir(parents=True, exist_ok=True)
    job_path.write_text(json.dumps({
        "job_id": "job-old-ui", "character_id": "", "prompt": "p",
        "submitted_at": "2026-08-20T00:00:00Z", "model": "m", "params": {},
        "output_paths": [str(image), windows_image], "status": "done", "error": None,
        "asset_slot": "portrait", "kind": "image", "namespace": "ui",
        "source_image": None, "project_id": project.id, "screen_id": "home",
        "production_id": None, "shot_id": None, "alias": None, "provider": None,
        "retry_of": None, "progress_phase": None, "completed_at": None,
    }), encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        ui_schemes.read_schemes(project.id)

    ui_schemes.migrate_legacy_project(project.id)

    moved = root / "ui/v1/screens/home/v1.png"
    assert moved.is_file()
    assert not (root / "screens").exists()
    assert "ui.typography" in (root / "ui/v1/style.md").read_text(encoding="utf-8")
    baseline = (root / "style.md").read_text(encoding="utf-8")
    assert "## style" in baseline and "## taboo" in baseline
    assert "ui.typography" not in baseline
    migrated_job = jobs.read_job("job-old-ui")
    assert migrated_job.ui_scheme_id == "v1"
    assert migrated_job.output_paths == [
        str(moved),
        r"C:\data\projects\mohuan\ui\v1\screens\home\v1.png",
    ]
    canonical = ui_jobs.read_screen_canonical(project.id, "v1")
    assert canonical.screens["home"].path == "projects/mohuan/ui/v1/screens/home/v1.png"
    assert canonical.screens["home"].style_fingerprint == stale.style_fingerprint_for_ui_scheme(
        project.id, "v1",
    )
    assert stale.screen_canonical_status(project.id, "v1").screens["home"].style_stale is False


def test_server_startup_runs_explicit_legacy_upgrade(isolated_data_root):
    projects.create_project("魔幻", slug="mohuan")
    root = isolated_data_root / "projects/mohuan"
    import shutil
    shutil.rmtree(root / "ui")
    image = root / "screens/home/v1.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")

    with TestClient(build_app()) as client:
        assert client.get("/api/projects").status_code == 200

    assert (root / "ui/v1/screens/home/v1.png").is_file()
    assert (root / "ui/schemes.json").is_file()


def test_legacy_baseline_without_ui_sections_gets_minimal_v1_style(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    root = isolated_data_root / "projects/mohuan"
    import shutil
    shutil.rmtree(root / "ui")
    baseline = "---\nstatus: approved\n---\n\n## style\n- render: 厚涂\n"
    (root / "style.md").write_text(baseline, encoding="utf-8")

    ui_schemes.migrate_legacy_project(project.id)

    assert (root / "style.md").read_text(encoding="utf-8") == baseline
    scheme_style = (root / "ui/v1/style.md").read_text(encoding="utf-8")
    assert "status: approved" in scheme_style
    assert "## ui" in scheme_style
    assert "继承项目视觉基线" in scheme_style


def test_v2_can_copy_selected_material_then_diverge(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    source = isolated_data_root / "projects/mohuan/ui/v1"
    (source / "style.md").write_text("V1 style", encoding="utf-8")
    (source / "screens/screen-map.md").write_text("map", encoding="utf-8")
    (source / "screens/home").mkdir()
    (source / "screens/home/v1.png").write_bytes(b"v1")
    (source / "screens/home.md").write_text("brief", encoding="utf-8")

    file = ui_schemes.create_scheme(project.id, UiSchemeCreate(
        name="V2",
        source_scheme_id="v1",
        copy_style=True,
        copy_screen_map=True,
        screen_ids=["home"],
    ))
    target = isolated_data_root / "projects/mohuan/ui/v2"

    assert [item.id for item in file.schemes] == ["v1", "v2"]
    assert (target / "style.md").read_text(encoding="utf-8") == "V1 style"
    assert (target / "screens/screen-map.md").read_text(encoding="utf-8") == "map"
    assert (target / "screens/home/v1.png").read_bytes() == b"v1"
    assert not (target / "screens/canonical.json").exists()
    (target / "screens/home/v1.png").write_bytes(b"v2")
    assert (source / "screens/home/v1.png").read_bytes() == b"v1"


def test_default_switch_is_scheme_aware(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    ui_schemes.create_scheme(project.id, UiSchemeCreate(name="V2"))
    schemes = ui_schemes.set_default(project.id, "v2")
    assert schemes.default_scheme_id == "v2"


def test_scheme_canonical_and_stale_state_are_independent(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    ui_schemes.create_scheme(project.id, UiSchemeCreate(name="V2"))
    root = isolated_data_root / "projects/mohuan/ui"
    for scheme_id in ("v1", "v2"):
        (root / scheme_id / "style.md").write_text("style one", encoding="utf-8")
        screen = root / scheme_id / "screens/home/v1.png"
        screen.parent.mkdir(parents=True, exist_ok=True)
        screen.write_bytes(scheme_id.encode())
        ui_jobs.set_screen_canonical(project.id, scheme_id, "home", str(screen))

    (root / "v2/style.md").write_text("style two", encoding="utf-8")

    v1 = stale.screen_canonical_status(project.id, "v1")
    v2 = stale.screen_canonical_status(project.id, "v2")
    assert v1.screens["home"].path.endswith("ui/v1/screens/home/v1.png")
    assert v1.screens["home"].style_stale is False
    assert v2.screens["home"].path.endswith("ui/v2/screens/home/v1.png")
    assert v2.screens["home"].style_stale is True


def test_project_baseline_change_marks_every_ui_scheme_stale(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    root = isolated_data_root / "projects/mohuan"
    (root / "style.md").write_text("project baseline one", encoding="utf-8")
    (root / "ui/v1/style.md").write_text("scheme style", encoding="utf-8")
    screen = root / "ui/v1/screens/home/v1.png"
    screen.parent.mkdir(parents=True, exist_ok=True)
    screen.write_bytes(b"v1")
    ui_jobs.set_screen_canonical(project.id, "v1", "home", str(screen))

    (root / "style.md").write_text("project baseline two", encoding="utf-8")

    assert stale.screen_canonical_status(project.id, "v1").screens["home"].style_stale is True


def test_scheme_api_exposes_copy_and_default_controls(isolated_data_root):
    project = projects.create_project("魔幻", slug="mohuan")
    client = TestClient(build_app())

    created = client.post(f"/api/projects/{project.id}/ui-schemes", json={
        "name": "V2", "source_scheme_id": "v1", "copy_style": False,
        "copy_screen_map": False, "screen_ids": [],
    })
    assert created.status_code == 200
    assert [item["id"] for item in created.json()["schemes"]] == ["v1", "v2"]
    default = client.post(f"/api/projects/{project.id}/ui-schemes/default", json={
        "scheme_id": "v2",
    })
    assert default.status_code == 200
    assert default.json()["default_scheme_id"] == "v2"
