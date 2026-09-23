from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.creation_assets import list_creation_assets
from character_workflow.lib.creation_assets_migration import (
    migrate_creation_assets_to_media,
    migrate_creation_assets_to_single_content,
)
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def test_versioned_assets_are_backed_up_and_migrated_once(isolated_data_root):
    asset_id = "creation-asset-old"
    version_id = "asset-version-latest"
    canvas_id = "canvas-old-1234"
    catalog = {
        "schema_version": 1,
        "revision": 7,
        "updated_at": "2026-08-28T00:00:00Z",
        "migrated_canvas_project_ids": [],
        "assets": [{
            "asset_id": asset_id,
            "kind": "prompt",
            "title": "旧提示词",
            "tags": ["旧"],
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-28T00:00:00Z",
            "last_used_at": None,
            "archived_at": "2026-08-28T00:00:00Z",
            "latest_version_id": version_id,
            "project_ids": [],
            "versions": [
                {
                    "kind": "prompt",
                    "version_id": "asset-version-first",
                    "created_at": "2026-08-27T00:00:00Z",
                    "segments": [{"kind": "text", "text": "旧正文"}],
                },
                {
                    "kind": "prompt",
                    "version_id": version_id,
                    "created_at": "2026-08-28T00:00:00Z",
                    "segments": [{"kind": "text", "text": "最新正文"}],
                },
            ],
        }, {
            "asset_id": "creation-asset-image",
            "kind": "image",
            "title": "旧图片",
            "tags": [],
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-28T00:00:00Z",
            "last_used_at": None,
            "archived_at": None,
            "latest_version_id": "asset-image-latest",
            "project_ids": [],
            "versions": [{
                "kind": "image",
                "version_id": "asset-image-first",
                "created_at": "2026-08-27T00:00:00Z",
                "path": "creation-assets/blobs/old.png",
                "mime_type": "image/png",
                "bytes": 3,
                "sha256": "a" * 64,
                "filename": "old.png",
            }, {
                "kind": "image",
                "version_id": "asset-image-latest",
                "created_at": "2026-08-28T00:00:00Z",
                "path": "creation-assets/blobs/latest.png",
                "mime_type": "image/png",
                "bytes": 6,
                "sha256": "b" * 64,
                "filename": "latest.png",
            }],
        }],
    }
    creation_assets_dir = isolated_data_root / "creation-assets"
    atomic_write_json(creation_assets_dir / "catalog.json", catalog)
    blob_dir = creation_assets_dir / "blobs"
    blob_dir.mkdir(parents=True)
    (blob_dir / "old.png").write_bytes(b"old")
    (blob_dir / "latest.png").write_bytes(b"latest")

    job_path = isolated_data_root / ".runtime" / "jobs" / "job-old.json"
    atomic_write_json(job_path, {
        "job_id": "job-old",
        "character_id": "",
        "prompt": "旧提示词正文",
        "submitted_at": "2026-08-28T00:00:00Z",
        "model": "gpt-image-2",
        "params": {
            "creation_prompt_asset_id": asset_id,
            "creation_prompt_version_id": version_id,
            "creation_prompt_variable_values": {"主体": "猫"},
        },
        "output_paths": [],
        "status": "failed",
        "error": "旧任务",
        "kind": "image",
        "namespace": "studio",
    })
    canvas_path = isolated_data_root / "canvases" / canvas_id / "canvas.json"
    atomic_write_json(canvas_path.parent / "project.json", {"project_id": canvas_id})
    atomic_write_json(canvas_path, {
        "schema_version": 2,
        "project_id": canvas_id,
        "revision": 0,
        "nodes": [{
            "id": "node-config",
            "title": "生成节点",
            "type": "config",
            "position": {"x": 0, "y": 0},
            "data": {
                "draft": {
                    "mode": "image",
                    "prompt": "旧提示词正文",
                    "model": "gpt-image-2",
                    "params": {
                        "creation_prompt_asset_id": asset_id,
                        "creation_prompt_version_id": version_id,
                        "creation_prompt_variable_values": {},
                    },
                    "updated_at": "2026-08-28T00:00:00Z",
                },
            },
        }],
        "connections": [],
        "content_versions": {
            "version-one": {
                "kind": "text",
                "version_id": "version-one",
                "created_at": "2026-08-28T00:00:00Z",
                "sha256": "c" * 64,
                "origin": {
                    "kind": "creation_asset",
                    "asset_id": asset_id,
                    "asset_version_id": version_id,
                    "variable_values": {},
                },
                "text": "旧提示词正文",
            },
        },
        "updated_at": "2026-08-28T00:00:00Z",
    })

    result = migrate_creation_assets_to_single_content()

    assert result is not None
    assert result["catalog_assets"] == 2
    assert result["jobs"] == 1
    assert result["canvases"] == 1
    assert result["removed_blobs"] == 1
    backup = Path(result["backup_path"])
    assert (backup / "creation-assets" / "catalog.json").is_file()
    assert (backup / "jobs" / "job-old.json").is_file()
    assert (backup / "canvases" / canvas_id / "canvas.json").is_file()
    assert (creation_assets_dir.parent / ".runtime" / "backups" / "creation-assets").is_dir()
    # server 启动顺序：v1→v2 之后紧接 v2→v4，之后目录才可读。
    assert migrate_creation_assets_to_media()["catalog_assets"] == 2
    assert json.loads((creation_assets_dir / "catalog.json").read_text("utf-8"))["schema_version"] == 4
    restored = next(asset for asset in list_creation_assets().assets if asset.asset_id == asset_id)
    assert restored.title == "旧提示词"
    assert restored.content.segments[0].text == "最新正文"
    assert "archived_at" not in restored.model_dump()
    assert not (blob_dir / "old.png").exists()
    assert (blob_dir / "latest.png").is_file()

    migrated_job = json.loads(job_path.read_text(encoding="utf-8"))
    assert migrated_job["params"]["creation_asset_source_title"] == "旧提示词"
    assert "creation_prompt_asset_id" not in migrated_job["params"]
    assert "creation_prompt_version_id" not in migrated_job["params"]
    assert "creation_prompt_variable_values" not in migrated_job["params"]
    migrated_canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    assert migrated_canvas["content_versions"]["version-one"]["origin"] == {
        "kind": "creation_asset_snapshot",
        "title": "旧提示词",
    }
    migrated_params = migrated_canvas["nodes"][0]["data"]["draft"]["params"]
    assert migrated_params["creation_asset_source_title"] == "旧提示词"
    assert "creation_prompt_asset_id" not in migrated_params
    assert migrate_creation_assets_to_single_content() is None


def test_v2_image_assets_migrate_to_media_v4(isolated_data_root):
    catalog = {
        "schema_version": 2, "revision": 3, "updated_at": "2026-09-01T00:00:00Z",
        "migrated_canvas_project_ids": [],
        "assets": [{
            "asset_id": "creation-asset-img1", "kind": "image", "title": "旧图",
            "tags": [], "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z",
            "last_used_at": None, "project_ids": [], "recommendation": None,
            "content": {"kind": "image", "path": "creation-assets/blobs/" + "a" * 64 + ".png",
                        "mime_type": "image/png", "bytes": 10, "sha256": "a" * 64, "filename": "x.png"},
        }],
    }
    atomic_write_json(isolated_data_root / "creation-assets" / "catalog.json", catalog)
    from character_workflow.lib.creation_assets_migration import migrate_creation_assets_to_media
    result = migrate_creation_assets_to_media()
    assert result["catalog_assets"] == 1
    listed = list_creation_assets(kind="media")
    assert listed.assets[0].kind == "media" and listed.assets[0].content.kind == "media"
    raw = json.loads((isolated_data_root / "creation-assets" / "catalog.json").read_text("utf-8"))
    assert raw["schema_version"] == 4
    assert "recommendation" not in raw["assets"][0]
    assert migrate_creation_assets_to_media() is None


def _v2_catalog(content: object) -> dict:
    return {
        "schema_version": 2, "revision": 1, "updated_at": "2026-09-01T00:00:00Z",
        "migrated_canvas_project_ids": [],
        "assets": [{
            "asset_id": "creation-asset-img2", "kind": "image", "title": "旧图",
            "tags": [], "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z",
            "last_used_at": None, "project_ids": [], "recommendation": None,
            "content": content,
        }],
    }


def test_media_migration_keeps_v2_intact_when_content_is_not_an_object(isolated_data_root):
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    atomic_write_json(catalog_path, _v2_catalog("creation-assets/blobs/x.png"))

    with pytest.raises(ValueError, match="creation-asset-img2"):
        migrate_creation_assets_to_media()

    raw = json.loads(catalog_path.read_text("utf-8"))
    assert raw["schema_version"] == 2 and raw["assets"][0]["kind"] == "image"
    assert not (isolated_data_root / ".runtime" / "backups" / "creation-assets").exists()


def test_media_migration_keeps_v2_intact_when_a_row_fails_validation(isolated_data_root):
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    # sha256 不是 64 位十六进制：整表校验必须在落盘前拦住它。
    atomic_write_json(catalog_path, _v2_catalog({
        "kind": "image", "path": "creation-assets/blobs/bad.png", "mime_type": "image/png",
        "bytes": 10, "sha256": "not-a-digest", "filename": "bad.png",
    }))

    with pytest.raises(ValueError, match="creation-asset-img2"):
        migrate_creation_assets_to_media()

    raw = json.loads(catalog_path.read_text("utf-8"))
    assert raw["schema_version"] == 2 and raw["assets"][0]["kind"] == "image"
    assert not (isolated_data_root / ".runtime" / "backups" / "creation-assets").exists()


def test_reading_the_catalog_outside_the_server_migrates_v2_to_v4(isolated_data_root):
    """Skill CLI / workshop 入口没有 lifespan：读目录本身必须先过 v2→v4。"""
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    atomic_write_json(catalog_path, _v2_catalog({
        "kind": "image", "path": "creation-assets/blobs/" + "c" * 64 + ".png",
        "mime_type": "image/png", "bytes": 10, "sha256": "c" * 64, "filename": "x.png",
    }))

    listed = list_creation_assets()

    assert [asset.kind for asset in listed.assets] == ["media"]
    assert listed.assets[0].content.kind == "media"
    assert json.loads(catalog_path.read_text("utf-8"))["schema_version"] == 4


def _v3_catalog() -> dict:
    """P1 发版后的真实 v3 形状：提示词资产带 recommendation，媒体资产带 recommendation: null。"""
    return {
        "schema_version": 3, "revision": 5, "updated_at": "2026-09-20T00:00:00Z",
        "migrated_canvas_project_ids": ["canvas-old"],
        "assets": [{
            "asset_id": "creation-asset-prompt", "kind": "prompt", "title": "高清写实",
            "tags": ["高清"], "created_at": "2026-09-19T00:00:00Z",
            "updated_at": "2026-09-19T00:00:00Z", "last_used_at": None, "project_ids": [],
            "content": {"kind": "prompt", "segments": [{"kind": "text", "text": "变清晰"}]},
            "recommendation": {
                "mode": "image", "model": "gpt-image-2", "params": {"quality": "high"},
            },
            "adopted_from": None,
        }, {
            "asset_id": "creation-asset-media", "kind": "media", "title": "参考图",
            "tags": [], "created_at": "2026-09-19T00:00:00Z",
            "updated_at": "2026-09-19T00:00:00Z", "last_used_at": None, "project_ids": [],
            "content": {"kind": "media", "path": "creation-assets/blobs/" + "d" * 64 + ".png",
                        "mime_type": "image/png", "bytes": 10, "sha256": "d" * 64,
                        "filename": "ref.png"},
            "recommendation": None,
            "adopted_from": None,
        }],
    }


def test_v3_catalog_drops_recommendation_on_the_read_path(isolated_data_root, client):
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    atomic_write_json(catalog_path, _v3_catalog())

    listed = client.get("/api/creation-assets")

    assert listed.status_code == 200, listed.json()
    assert [row["asset_id"] for row in listed.json()["assets"]] == [
        "creation-asset-prompt", "creation-asset-media",
    ]
    assert all("recommendation" not in row for row in listed.json()["assets"])
    raw = json.loads(catalog_path.read_text("utf-8"))
    assert raw["schema_version"] == 4 and raw["revision"] == 6
    assert all("recommendation" not in row for row in raw["assets"])
    assert raw["migrated_canvas_project_ids"] == ["canvas-old"]
    backups = list((isolated_data_root / ".runtime" / "backups" / "creation-assets").iterdir())
    assert len(backups) == 1
    assert json.loads((backups[0] / "catalog.json").read_text("utf-8"))["schema_version"] == 3
    assert migrate_creation_assets_to_media() is None


def test_v3_catalog_migration_keeps_original_when_a_row_is_broken(isolated_data_root):
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    catalog = _v3_catalog()
    catalog["assets"][1]["content"]["sha256"] = "not-a-digest"
    atomic_write_json(catalog_path, catalog)

    with pytest.raises(ValueError, match="creation-asset-media"):
        migrate_creation_assets_to_media()

    raw = json.loads(catalog_path.read_text("utf-8"))
    assert raw["schema_version"] == 3 and "recommendation" in raw["assets"][0]
    assert not (isolated_data_root / ".runtime" / "backups" / "creation-assets").exists()


def test_v4_catalog_is_left_alone_by_every_step(isolated_data_root):
    catalog_path = isolated_data_root / "creation-assets" / "catalog.json"
    atomic_write_json(catalog_path, _v3_catalog())
    migrate_creation_assets_to_media()
    before = catalog_path.read_text("utf-8")

    assert migrate_creation_assets_to_single_content() is None
    assert migrate_creation_assets_to_media() is None
    assert catalog_path.read_text("utf-8") == before
