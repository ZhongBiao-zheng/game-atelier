"""Project gallery and project-index derived read models."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.jobs import update_job_status, write_job
from character_workflow.lib.schemas import AssetSlot, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / "characters").mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _make_media(path: Path, *, offset: float = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media")
    stamp = time.time() + offset
    os.utime(path, (stamp, stamp))


def _create_project(client: TestClient, name: str = "魔幻") -> dict:
    response = client.post("/api/projects", json={"name": name})
    assert response.status_code == 200
    return response.json()["projects"][0]


def _gallery(client: TestClient, project_id: str, query: str = "") -> dict:
    response = client.get(f"/api/projects/{project_id}/gallery{query}")
    assert response.status_code == 200
    return response.json()


def test_project_gallery_404_for_unknown_project(client):
    assert client.get("/api/projects/nope/gallery").status_code == 404


def test_project_gallery_combines_art_ui_and_video_outputs(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})

    _make_media(tmp_path / "characters/hero/portrait/portrait.png", offset=-40)
    _make_media(
        tmp_path / f"projects/{project['slug']}/ui/v1/screens/home/home.png",
        offset=-30,
    )
    _make_media(
        tmp_path / f"projects/{project['slug']}/videos/trailer/shots/s01/shot.mp4",
        offset=-20,
    )
    _make_media(
        tmp_path / f"projects/{project['slug']}/videos/trailer/exports/final.mp4",
        offset=-10,
    )
    (tmp_path / f"projects/{project['slug']}/videos/trailer/brief.md").write_text(
        "---\ntitle: 预告片\ntype: promo\n---\n",
        encoding="utf-8",
    )

    items = _gallery(client, project_id)["items"]

    assert [item["target"]["kind"] for item in items] == ["video", "video", "ui", "art"]
    assert items[0]["target"] == {
        "kind": "video",
        "production_id": "trailer",
        "shot_id": None,
        "output_kind": "export",
    }
    assert items[1]["media_type"] == "video"
    assert items[2]["target"]["screen_id"] == "home"
    assert items[3]["target"]["character_id"] == "hero"


def test_project_gallery_filters_category_hidden_and_non_outputs(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    shown = tmp_path / "characters/hero/promo/shown.png"
    hidden = tmp_path / "characters/hero/portrait/hidden.png"
    _make_media(shown, offset=-1)
    _make_media(hidden, offset=-2)
    _make_media(tmp_path / "characters/hero/source/reference.png")
    _make_media(tmp_path / f"projects/{project['slug']}/ui/v1/style-reference.png")
    client.post(
        "/api/gallery/hidden",
        json={"path": "characters/hero/portrait/hidden.png", "hidden": True},
    )

    art = _gallery(client, project_id, "?category=art")["items"]

    assert [item["path"] for item in art] == ["characters/hero/promo/shown.png"]


def test_project_gallery_excludes_files_registered_by_failed_jobs(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    failed = tmp_path / "characters/hero/portrait/failed.png"
    _make_media(failed)
    write_job(
        job_id="job-failed",
        character_id="hero",
        prompt="failed",
        model="manual",
        params={},
        asset_slot=AssetSlot.PORTRAIT,
    )
    update_job_status(
        "job-failed",
        status=JobStatus.FAILED,
        output_paths=[str(failed)],
        error="failed",
    )

    assert _gallery(client, project_id)["items"] == []


def test_project_gallery_cursor_is_stable_when_mtimes_match(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    stamp = time.time() - 10
    for name in ("a.png", "b.png", "c.png"):
        path = tmp_path / f"characters/hero/portrait/{name}"
        _make_media(path)
        os.utime(path, (stamp, stamp))

    first = _gallery(client, project_id, "?limit=2")
    second = _gallery(client, project_id, f"?limit=2&cursor={first['next_cursor']}")

    paths = [item["path"] for item in first["items"] + second["items"]]
    assert paths == [
        "characters/hero/portrait/a.png",
        "characters/hero/portrait/b.png",
        "characters/hero/portrait/c.png",
    ]
    assert second["next_cursor"] is None


def test_project_gallery_rejects_malformed_cursor(client):
    project = _create_project(client)

    response = client.get(
        f"/api/projects/{project['id']}/gallery",
        params={"cursor": "a"},
    )

    assert response.status_code == 400


def test_project_gallery_media_restores_one_visible_item(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    path = "characters/hero/promo/hero.png"
    _make_media(tmp_path / path)

    response = client.get(
        f"/api/projects/{project_id}/gallery/media",
        params={"path": path},
    )

    assert response.status_code == 200
    assert response.json()["target"]["character_id"] == "hero"
    client.post("/api/gallery/hidden", json={"path": path, "hidden": True})
    assert client.get(
        f"/api/projects/{project_id}/gallery/media",
        params={"path": path},
    ).status_code == 404


def test_project_index_uses_latest_four_unhidden_images_and_no_video(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    for index in range(5):
        _make_media(
            tmp_path / f"characters/hero/portrait/{index}.png",
            offset=index - 20,
        )
    _make_media(
        tmp_path / f"projects/{project['slug']}/videos/trailer/shots/s01/newest.mp4",
        offset=100,
    )
    client.post(
        "/api/gallery/hidden",
        json={"path": "characters/hero/portrait/4.png", "hidden": True},
    )

    response = client.get("/api/projects/index")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["project"]["id"] == project_id
    assert item["cover_paths"] == [
        "characters/hero/portrait/3.png",
        "characters/hero/portrait/2.png",
        "characters/hero/portrait/1.png",
        "characters/hero/portrait/0.png",
    ]


def test_project_index_cover_is_not_limited_by_newer_videos(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    production = tmp_path / f"projects/{project['slug']}/videos/trailer"
    (production / "brief.md").parent.mkdir(parents=True, exist_ok=True)
    (production / "brief.md").write_text("---\ntitle: 预告片\n---\n", encoding="utf-8")
    for index in range(101):
        _make_media(production / f"shots/{index:03d}/v1.mp4", offset=index + 100)
    for index in range(4):
        _make_media(tmp_path / f"characters/hero/portrait/{index}.png", offset=index)

    item = client.get("/api/projects/index").json()["items"][0]

    assert item["cover_paths"] == [
        "characters/hero/portrait/3.png",
        "characters/hero/portrait/2.png",
        "characters/hero/portrait/1.png",
        "characters/hero/portrait/0.png",
    ]


def test_project_activity_tracks_worldview_and_assigned_character_changes(client, tmp_path):
    project = _create_project(client)
    project_id = project["id"]
    first = client.get("/api/projects/index").json()["items"][0]["activity_at"]

    time.sleep(0.01)
    client.post(
        "/api/experience",
        json={"project": project_id, "worldview_md": "# 新世界观"},
    )
    second = client.get("/api/projects/index").json()["items"][0]["activity_at"]
    assert second > first

    time.sleep(0.01)
    client.post("/api/characters/hero/project", json={"project_id": project_id})
    _make_media(tmp_path / "characters/hero/portrait/new.png")
    third = client.get("/api/projects/index").json()["items"][0]["activity_at"]
    assert third > second

    time.sleep(0.01)
    write_job(
        job_id="job-project-activity",
        character_id="hero",
        prompt="新的制作记录",
        model="manual",
        params={},
        asset_slot=AssetSlot.PORTRAIT,
    )
    fourth = client.get("/api/projects/index").json()["items"][0]["activity_at"]
    assert fourth > third


def test_empty_project_index_has_no_cover(client):
    project = _create_project(client)
    item = client.get("/api/projects/index").json()["items"][0]
    assert item["project"]["id"] == project["id"]
    assert item["cover_paths"] == []
    assert item["activity_at"]
