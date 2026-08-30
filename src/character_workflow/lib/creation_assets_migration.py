"""One-time upgrade from versioned creation assets to single mutable content.

The backup is intentionally outside the active creation-assets directory and is never read by
runtime code.  The migration also severs old job/Canvas references while preserving a frozen title
snapshot wherever the old asset still resolves.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import canvas_project_lock_path
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import job_lock, write_job_under_lock
from character_workflow.lib.schemas import CanvasDocument, Job


def migrate_creation_assets_to_single_content() -> dict[str, Any] | None:
    catalog_path = data_root.creation_assets_dir() / "catalog.json"
    if not catalog_path.is_file():
        return None
    raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    if raw.get("schema_version") == 2:
        return None
    if raw.get("schema_version") != 1:
        raise ValueError("unsupported creation asset catalog schema")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_root = data_root.runtime_dir() / "backups" / "creation-assets" / timestamp
    backup_root.mkdir(parents=True, exist_ok=False)
    shutil.copytree(data_root.creation_assets_dir(), backup_root / "creation-assets")

    title_by_id = {
        asset["asset_id"]: asset["title"]
        for asset in raw.get("assets", [])
        if isinstance(asset, dict)
        and isinstance(asset.get("asset_id"), str)
        and isinstance(asset.get("title"), str)
    }
    migrated_assets = [_flatten_asset(asset) for asset in raw.get("assets", [])]
    migrated_catalog = {
        "schema_version": 2,
        "revision": int(raw.get("revision", 0)) + 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "assets": migrated_assets,
        "migrated_canvas_project_ids": list(raw.get("migrated_canvas_project_ids", [])),
    }

    changed_jobs = _migrate_jobs(title_by_id, backup_root)
    changed_canvases = _migrate_canvases(title_by_id, backup_root)
    removed_blobs = _prune_unreferenced_image_blobs(migrated_assets)
    atomic_write_json(catalog_path, migrated_catalog)
    manifest = {
        "migration": "creation-assets-v1-to-v2-single-content",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "catalog_assets": len(migrated_assets),
        "jobs": changed_jobs,
        "canvases": changed_canvases,
        "removed_blobs": removed_blobs,
    }
    atomic_write_json(backup_root / "manifest.json", manifest)
    return {**manifest, "backup_path": str(backup_root)}


def _flatten_asset(asset: dict[str, Any]) -> dict[str, Any]:
    versions = asset.get("versions")
    if not isinstance(versions, list) or not versions:
        raise ValueError("creation asset has no versions")
    latest_id = asset.get("latest_version_id")
    latest = next(
        (version for version in versions if version.get("version_id") == latest_id),
        None,
    )
    if latest is None:
        raise ValueError("creation asset latest version is missing")
    content = {
        key: value
        for key, value in latest.items()
        if key not in {"version_id", "created_at"}
    }
    return {
        "asset_id": asset["asset_id"],
        "kind": asset["kind"],
        "title": asset["title"],
        "tags": list(asset.get("tags", [])),
        "created_at": asset["created_at"],
        "updated_at": asset["updated_at"],
        "last_used_at": asset.get("last_used_at"),
        "content": content,
        "project_ids": list(dict.fromkeys(asset.get("project_ids", []))),
    }


def _migrate_jobs(title_by_id: dict[str, str], backup_root: Path) -> int:
    jobs_dir = data_root.runtime_dir() / "jobs"
    if not jobs_dir.is_dir():
        return 0
    changed = 0
    for path in sorted(jobs_dir.glob("*.json")):
        with job_lock(path.stem):
            payload = json.loads(path.read_text(encoding="utf-8"))
            params = payload.get("params")
            if not isinstance(params, dict) or not _migrate_prompt_params(params, title_by_id):
                continue
            job = Job.model_validate(payload)
            if job.job_id != path.stem:
                raise ValueError("job file name does not match job_id")
            _backup_file(path, backup_root / "jobs" / path.name)
            write_job_under_lock(job)
            changed += 1
    return changed


def _migrate_canvases(title_by_id: dict[str, str], backup_root: Path) -> int:
    canvases_dir = data_root.canvases_dir()
    if not canvases_dir.is_dir():
        return 0
    changed = 0
    for path in sorted(canvases_dir.glob("*/canvas.json")):
        with file_lock(canvas_project_lock_path(path.parent.name)):
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not _migrate_canvas_payload(payload, title_by_id):
                continue
            document = CanvasDocument.model_validate(payload)
            if document.project_id != path.parent.name:
                raise ValueError("canvas directory name does not match project_id")
            _backup_file(path, backup_root / "canvases" / path.parent.name / path.name)
            atomic_write_json(path, document.model_dump(mode="json"))
            changed += 1
    return changed


def _migrate_canvas_payload(payload: dict[str, Any], title_by_id: dict[str, str]) -> bool:
    changed = False
    versions = payload.get("content_versions")
    if isinstance(versions, dict):
        for version in versions.values():
            origin = version.get("origin") if isinstance(version, dict) else None
            if not isinstance(origin, dict) or origin.get("kind") != "creation_asset":
                continue
            title = title_by_id.get(origin.get("asset_id"), "创作资产")
            version["origin"] = {"kind": "creation_asset_snapshot", "title": title}
            changed = True

    for node in payload.get("nodes", []):
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        draft = data.get("draft") or data.get("generation_draft")
        params = draft.get("params") if isinstance(draft, dict) else None
        if not isinstance(params, dict) or not _migrate_prompt_params(params, title_by_id):
            continue
        changed = True
    return changed


def _migrate_prompt_params(params: dict[str, Any], title_by_id: dict[str, str]) -> bool:
    legacy_keys = {
        "creation_prompt_asset_id",
        "creation_prompt_version_id",
        "creation_prompt_variable_values",
    }
    if legacy_keys.isdisjoint(params):
        return False
    asset_id = params.pop("creation_prompt_asset_id", None)
    params.pop("creation_prompt_version_id", None)
    params.pop("creation_prompt_variable_values", None)
    title = title_by_id.get(asset_id) if isinstance(asset_id, str) else None
    if title:
        params["creation_asset_source_title"] = title
    return True


def _prune_unreferenced_image_blobs(migrated_assets: list[dict[str, Any]]) -> int:
    data_root_path = data_root.resolve_data_root().resolve()
    blob_root = data_root_path / "creation-assets" / "blobs"
    if not blob_root.is_dir():
        return 0
    referenced = {
        str(asset["content"]["path"])
        for asset in migrated_assets
        if asset.get("kind") == "image"
        and isinstance(asset.get("content"), dict)
        and isinstance(asset["content"].get("path"), str)
    }
    removed = 0
    for path in blob_root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(data_root_path).as_posix()
        if relative in referenced:
            continue
        path.unlink()
        removed += 1
    return removed


def _backup_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
