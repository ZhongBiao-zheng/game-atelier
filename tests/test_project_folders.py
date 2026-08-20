from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.projects import assign_character, create_project
from character_workflow.lib.schemas import ProjectFolderCreate, ProjectFolderItem
from character_workflow.lib.video_jobs import create_production
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root: Path) -> TestClient:
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _post(client: TestClient, path: str, payload: dict) -> dict:
    response = client.post(path, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _folder_assets(isolated_data_root: Path):
    project = create_project("麻将游戏")
    character_id = "cao-cao"
    character_dir = isolated_data_root / "characters" / character_id
    character_dir.mkdir(parents=True)
    (character_dir / "spec.md").write_text("# 曹操\n", encoding="utf-8")
    assign_character(character_id, project.id)

    project_root = isolated_data_root / "projects" / project.slug
    screen_id = "home"
    screen_dir = project_root / "ui" / "v1" / "screens" / screen_id
    screen_dir.mkdir(parents=True)
    (screen_dir / "v1.png").write_bytes(b"image")
    (project_root / "ui" / "v1" / "screens" / "screen-map.md").write_text(
        "| screen-id | 名称 | 分类 | 优先级 | 状态 | 依赖 |\n"
        "|---|---|---|---|---|---|\n"
        "| home | 主界面 | core | must-have | planned | |\n",
        encoding="utf-8",
    )

    production_id = "launch-pv"
    production_dir = create_production(project.id, production_id, "上线宣传片", "promo")
    return project, character_id, character_dir, screen_id, screen_dir, production_id, production_dir


def test_project_folder_models_forbid_unknown_fields():
    assert ProjectFolderItem(kind="character", asset_id="cao-cao").model_dump() == {
        "kind": "character",
        "asset_id": "cao-cao",
        "scheme_id": None,
    }
    with pytest.raises(ValueError):
        ProjectFolderItem(kind="character", asset_id="cao-cao", label="副本名")
    with pytest.raises(ValueError):
        ProjectFolderCreate(name="   ")


def test_folder_crud_and_order_use_atomic_project_file(client, isolated_data_root, monkeypatch):
    from character_workflow.lib import project_folders

    project = create_project("麻将游戏")
    writes: list[Path] = []
    original = project_folders.atomic_write_text

    def recording_write(path: Path, content: str) -> None:
        writes.append(path)
        original(path, content)

    monkeypatch.setattr(project_folders, "atomic_write_text", recording_write)

    first = _post(client, f"/api/projects/{project.id}/folders", {
        "name": "夏日版本",
        "note": "管理夏日内容",
    })["folders"][0]
    second = _post(client, f"/api/projects/{project.id}/folders", {
        "name": "08.22 对外宣传片",
    })["folders"][0]

    updated = _post(client, f"/api/projects/{project.id}/folders/{first['id']}", {
        "name": "夏日版本皮肤",
        "note": "角色与宣传素材",
    })
    assert next(item for item in updated["folders"] if item["id"] == first["id"])["note"] == "角色与宣传素材"

    reordered = _post(client, f"/api/projects/{project.id}/folders/reorder", {
        "ordered_ids": [first["id"], second["id"]],
    })
    assert [item["id"] for item in reordered["folders"]] == [first["id"], second["id"]]

    duplicate_order = client.post(f"/api/projects/{project.id}/folders/reorder", json={
        "ordered_ids": [first["id"], first["id"], second["id"]],
    })
    assert duplicate_order.status_code == 422

    deleted = client.delete(f"/api/projects/{project.id}/folders/{second['id']}")
    assert deleted.status_code == 200
    assert [item["id"] for item in deleted.json()["folders"]] == [first["id"]]
    assert len(writes) == 5
    assert {path for path in writes} == {
        isolated_data_root / "projects" / project.slug / "folders.json"
    }


def test_folder_accepts_mixed_assets_and_same_asset_in_multiple_folders(
    client,
    isolated_data_root,
):
    project, character_id, *_rest, screen_id, _screen_dir, production_id, _production_dir = (
        _folder_assets(isolated_data_root)
    )
    folder_a = _post(client, f"/api/projects/{project.id}/folders", {"name": "版本 A"})["folders"][0]
    folder_b = _post(client, f"/api/projects/{project.id}/folders", {"name": "版本 B"})["folders"][0]

    for item in (
        {"kind": "character", "asset_id": character_id},
        {"kind": "ui_screen", "asset_id": screen_id, "scheme_id": "v1"},
        {"kind": "video_production", "asset_id": production_id},
    ):
        _post(client, f"/api/projects/{project.id}/folders/{folder_a['id']}/items", item)
    _post(
        client,
        f"/api/projects/{project.id}/folders/{folder_b['id']}/items",
        {"kind": "character", "asset_id": character_id},
    )

    folders = client.get(f"/api/projects/{project.id}/folders").json()["folders"]
    by_id = {folder["id"]: folder for folder in folders}
    assert by_id[folder_a["id"]]["items"] == [
        {"kind": "character", "asset_id": character_id, "scheme_id": None},
        {"kind": "ui_screen", "asset_id": screen_id, "scheme_id": "v1"},
        {"kind": "video_production", "asset_id": production_id, "scheme_id": None},
    ]
    assert by_id[folder_b["id"]]["items"] == [
        {"kind": "character", "asset_id": character_id, "scheme_id": None},
    ]


def test_remove_item_and_delete_folder_preserve_assets(client, isolated_data_root):
    (
        project,
        character_id,
        character_dir,
        screen_id,
        screen_dir,
        production_id,
        production_dir,
    ) = _folder_assets(isolated_data_root)
    folder = _post(client, f"/api/projects/{project.id}/folders", {"name": "交付整理"})["folders"][0]
    for item in (
        {"kind": "character", "asset_id": character_id},
        {"kind": "ui_screen", "asset_id": screen_id, "scheme_id": "v1"},
        {"kind": "video_production", "asset_id": production_id},
    ):
        _post(client, f"/api/projects/{project.id}/folders/{folder['id']}/items", item)

    removed = client.delete(
        f"/api/projects/{project.id}/folders/{folder['id']}/items",
        params={"kind": "character", "asset_id": character_id},
    )
    assert removed.status_code == 200
    deleted = client.delete(f"/api/projects/{project.id}/folders/{folder['id']}")
    assert deleted.status_code == 200

    assert character_dir.is_dir()
    assert screen_dir.is_dir()
    assert production_dir.is_dir()


def test_folder_rejects_unknown_and_cross_project_assets(client, isolated_data_root):
    project, character_id, *_ = _folder_assets(isolated_data_root)
    other = create_project("另一个项目")
    folder = _post(client, f"/api/projects/{other.id}/folders", {"name": "错误引用"})["folders"][0]

    response = client.post(
        f"/api/projects/{other.id}/folders/{folder['id']}/items",
        json={"kind": "character", "asset_id": character_id},
    )
    assert response.status_code == 400
    assert "不属于这个项目" in response.json()["detail"]

    missing = client.get("/api/projects/missing/folders")
    assert missing.status_code == 404
