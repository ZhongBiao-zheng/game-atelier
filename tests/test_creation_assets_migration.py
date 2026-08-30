from __future__ import annotations

import json
from pathlib import Path

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.creation_assets import list_creation_assets
from character_workflow.lib.creation_assets_migration import (
    migrate_creation_assets_to_single_content,
)


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
