from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.jobs import update_job_status, write_job
from character_workflow.lib.schemas import JobKind, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _project(client: TestClient) -> dict:
    response = client.post("/api/projects", json={"name": "蜀阵"})
    assert response.status_code == 200
    return response.json()["projects"][0]


def _character(client: TestClient, project_id: str, name: str = "赵云") -> dict:
    response = client.post("/api/characters", json={"name": name, "project_id": project_id})
    assert response.status_code == 200
    return response.json()


def _media(path: Path, offset: float = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media")
    stamp = time.time() + offset
    os.utime(path, (stamp, stamp))


def _ui_screen(root: Path, project: dict, screen_id: str = "home") -> Path:
    screen = root / f"projects/{project['slug']}/ui/v1/screens/{screen_id}"
    screen.mkdir(parents=True, exist_ok=True)
    return screen


def test_character_index_uses_canonical_portrait_or_first_portrait(client, tmp_path):
    project = _project(client)
    character = _character(client, project["id"])
    for version, offset in [(1, 50), (2, 40), (3, 30), (4, 20), (5, 10)]:
        _media(tmp_path / f"characters/{character['id']}/portrait/v{version}.png", offset)

    response = client.get(f"/api/projects/{project['id']}/characters/index")

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["character"]["id"] == character["id"]
    assert item["cover_path"] == f"characters/{character['id']}/portrait/v1.png"

    workspace = client.get(
        f"/api/projects/{project['id']}/characters/{character['id']}/workspace"
    ).json()
    portrait = next(item for item in workspace["assets"] if item["slot"] == "portrait")
    assert portrait["count"] == 5
    assert len(portrait["media"]) == 1

    canonical_path = f"characters/{character['id']}/portrait/v4.png"
    set_response = client.post(
        f"/api/characters/{character['id']}/canonical",
        json={"slot": "portrait", "path": canonical_path},
    )
    assert set_response.status_code == 200
    index_after_canonical = client.get(
        f"/api/projects/{project['id']}/characters/index"
    ).json()["items"][0]
    assert index_after_canonical["cover_path"] == canonical_path
    workspace = client.get(
        f"/api/projects/{project['id']}/characters/{character['id']}/workspace"
    ).json()
    portrait = next(item for item in workspace["assets"] if item["slot"] == "portrait")
    assert [item["path"] for item in portrait["media"]] == [
        f"characters/{character['id']}/portrait/v1.png",
        canonical_path,
    ]
    assert [item["path"] for item in workspace["recent_media"][:2]] == [
        canonical_path,
        f"characters/{character['id']}/portrait/v1.png",
    ]


def test_workspace_derives_ui_and_video_associations_from_reference_paths(client, tmp_path):
    project = _project(client)
    character = _character(client, project["id"])
    reference = tmp_path / f"characters/{character['id']}/portrait/canonical.png"
    _media(reference)
    ui_output = _ui_screen(tmp_path, project) / "v1.png"
    _media(ui_output)
    video_root = tmp_path / f"projects/{project['slug']}/videos/trailer"
    (video_root / "brief.md").parent.mkdir(parents=True, exist_ok=True)
    (video_root / "brief.md").write_text("---\ntitle: 赵云预告\n---\n", encoding="utf-8")
    video_output = video_root / "shots/s01/v1.mp4"
    _media(video_output)

    ui_job = write_job(
        job_id="job-ui-reference",
        character_id="",
        prompt="home",
        model="manual",
        params={"reference_images": [str(reference)]},
        namespace="ui",
        project_id=project["id"],
        ui_scheme_id="v1",
        screen_id="home",
    )
    update_job_status(
        ui_job.job_id,
        status=JobStatus.DONE,
        output_paths=[str(ui_output)],
    )
    video_job = write_job(
        job_id="job-video-reference",
        character_id="",
        prompt="shot",
        model="manual",
        params={"reference_images": [str(reference)]},
        namespace="video",
        project_id=project["id"],
        production_id="trailer",
        shot_id="s01",
        kind=JobKind.VIDEO,
    )
    update_job_status(
        video_job.job_id,
        status=JobStatus.DONE,
        output_paths=[str(video_output)],
    )

    response = client.get(
        f"/api/projects/{project['id']}/characters/{character['id']}/workspace"
    )

    assert response.status_code == 200
    related = response.json()["related"]
    assert [(item["target"]["kind"], item["source"]) for item in related] == [
        ("ui", "auto"),
        ("video", "auto"),
    ]


def test_manual_association_adds_imported_ui_and_removal_preserves_auto(client, tmp_path):
    project = _project(client)
    character = _character(client, project["id"])
    reference = tmp_path / f"characters/{character['id']}/portrait/ref.png"
    _media(reference)
    ui_output = _ui_screen(tmp_path, project) / "imported.png"
    _media(ui_output)
    job = write_job(
        job_id="job-ui-both",
        character_id="",
        prompt="home",
        model="manual",
        params={"reference_images": [str(reference)]},
        namespace="ui",
        project_id=project["id"],
        ui_scheme_id="v1",
        screen_id="home",
    )
    update_job_status(job.job_id, status=JobStatus.DONE, output_paths=[str(ui_output)])
    payload = {
        "character_id": character["id"],
        "target": {"kind": "ui", "scheme_id": "v1", "screen_id": "home"},
        "associated": True,
    }

    added = client.put(f"/api/projects/{project['id']}/character-associations", json=payload)
    assert added.status_code == 200
    workspace = client.get(
        f"/api/projects/{project['id']}/characters/{character['id']}/workspace"
    ).json()
    assert workspace["related"][0]["source"] == "both"

    payload["associated"] = False
    removed = client.put(f"/api/projects/{project['id']}/character-associations", json=payload)
    assert removed.status_code == 200
    workspace = client.get(
        f"/api/projects/{project['id']}/characters/{character['id']}/workspace"
    ).json()
    assert workspace["related"][0]["source"] == "auto"
    assert ui_output.is_file()


def test_manual_association_rejects_cross_project_character(client, tmp_path):
    first = _project(client)
    second_response = client.post("/api/projects", json={"name": "魏阵"})
    second = next(
        project for project in second_response.json()["projects"]
        if project["name"] == "魏阵"
    )
    character = _character(client, first["id"])
    _ui_screen(tmp_path, second)

    response = client.put(
        f"/api/projects/{second['id']}/character-associations",
        json={
            "character_id": character["id"],
            "target": {"kind": "ui", "scheme_id": "v1", "screen_id": "home"},
            "associated": True,
        },
    )

    assert response.status_code == 400
