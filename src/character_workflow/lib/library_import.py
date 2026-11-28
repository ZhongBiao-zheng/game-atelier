"""Import the local legacy catalog once. Retry safely before moving originals to the trash."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from pathlib import Path

from character_workflow.lib import project_reference_assets as project_assets
from character_workflow.lib import data_root, library, trash
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json, read_text_with_retry
from character_workflow.lib.library_legacy_upgrade import (
    migrate_creation_assets_to_single_content, migrate_creation_assets_to_v4,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import CreationAssetCatalog, MEDIA_SUFFIXES

logger = logging.getLogger(__name__)


def _key(prefix, name):
    return prefix + "_" + uuid.uuid5(uuid.NAMESPACE_URL, "cobrush/library/import/" + name).hex


def _checked(path: Path, directory: Path, digest: str = ""):
    if path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError("旧素材路径无效")
    body = path.read_bytes()
    if digest and not hashlib.sha256(body).hexdigest().startswith(digest):
        raise ValueError("旧素材摘要不匹配")
    return body


def _copy_reference(body, target):
    if target.exists():
        if target.read_bytes() != body:
            raise ValueError("项目参考库中存在不同内容的同名文件")
    else:
        atomic_write_bytes(target, body)


def _import_catalog(source, catalog):
    destination = data_root.project_references_dir()
    retained = []
    folder = _key("fld", "旧素材")
    count = 0
    with library.transaction() as tx:
        if not library._path(folder).exists():
            tx.put(dict(id=folder, name="旧素材", parent_id=None, item_ids=[]))
        for asset in catalog.assets:
            # Project references and adopted team entries retain their IDs for existing clients.
            if not re.fullmatch(r"[A-Za-z0-9_-]+", asset.asset_id):
                raise ValueError("旧素材标识无效")
            preserve = bool(asset.project_ids or asset.category or asset.adopted_from or asset.kind == "generation")
            entries = []
            media = project_assets.asset_media_content(asset)
            if media:
                ext = MEDIA_SUFFIXES[media.mime_type]
                file = media.sha256 + ext
                blob = source.parent / media.path
                body = _checked(blob, source / "blobs", media.sha256)
                if len(body) != media.bytes:
                    raise ValueError("旧素材文件长度不匹配")
                entries.append(("media", asset.title, body, media.mime_type.split("/")[0], ext))
                if preserve:
                    _copy_reference(body, destination / "blobs" / file)
                    media.path = "project-references/blobs/" + file
            if asset.content.kind == "generation" and preserve:
                for ref in asset.content.snapshot.inputs:
                    file = ref.sha256 + MEDIA_SUFFIXES[ref.mime_type]
                    _copy_reference(_checked(source / "blobs" / file, source, ref.sha256),
                                    destination / "blobs" / file)
            if asset.content.kind == "prompt":
                value = project_assets.render_prompt_segments(asset.content.segments, {})
                entries.append(("prompt", asset.title, value.encode(), "text", ".md"))
                for i, preview in enumerate(asset.content.preview_images):
                    if Path(preview.file).name != preview.file or "\\" in preview.file:
                        raise ValueError("旧效果图文件名无效")
                    file = Path("prompt-previews") / asset.asset_id / preview.file
                    body = _checked(source / file, source, Path(preview.file).stem)
                    entries.append((preview.file, f"{asset.title} 效果图 {i + 1}", body, "image", file.suffix))
                    if preserve:
                        _copy_reference(body, destination / file)
            for role, title, body, kind, suffix in entries:
                key = _key("itm", asset.asset_id + "/" + role)
                if key not in tx.get(folder)["item_ids"]:
                    library._insert(tx, folder, title, body, kind, suffix,
                                    {"kind": "import", "asset_id": asset.asset_id}, key)
                count += 1
            if preserve:
                retained.append(asset)
            logger.info("imported legacy asset %s (%d items)", asset.asset_id, len(entries))
        current = project_assets._read_catalog_unlocked()
        existing = {asset.asset_id for asset in current.assets}
        kept = [a for a in retained if a.asset_id not in existing]
        project_assets._write_catalog_unlocked(current, [*current.assets, *kept],
            migrated_canvas_project_ids=list(dict.fromkeys([*current.migrated_canvas_project_ids,
                                                            *catalog.migrated_canvas_project_ids])))
        archive = source / "archived.json"
        if archive.is_file():
            archived = project_assets._read_archived_unlocked()
            keep_ids = {a.asset_id for a in retained}
            archived.update({k: v for k, v in json.loads(read_text_with_retry(archive))["assets"].items() if k in keep_ids})
            project_assets._write_archived_unlocked(archived)
    return {"folder_id": folder, "items": count, "retained": len(retained)}


def import_legacy():
    source = data_root.creation_assets_dir()
    marker = data_root.runtime_dir() / "library-import.json"
    with file_lock(project_assets._catalog_lock_path()):
        previous = json.loads(read_text_with_retry(marker)) if marker.exists() else {}
        if previous.get("status") == "done":
            return previous
        if not source.exists():
            if previous.get("status") == "copied":
                result = {**previous, "status": "done"}
                atomic_write_json(marker, result, durable=True)
                return result
            return None
        try:
            if source.is_symlink():
                raise ValueError("旧素材目录不能是符号链接")
            logger.info("starting legacy asset import")
            # V1–3 are upgraded by the existing backed-up migration before reading the catalog.
            migrate_creation_assets_to_single_content()
            migrate_creation_assets_to_v4()
            catalog = CreationAssetCatalog.model_validate_json(read_text_with_retry(source / "catalog.json"))
            result = _import_catalog(source, catalog)
            atomic_write_json(marker, {**result, "status": "copied"}, durable=True)
            trash_id = trash.move_to_trash("library", "旧创作资产", [source])
            result.update(status="done", trash_id=trash_id)
            atomic_write_json(marker, result, durable=True)
            logger.info("legacy asset import completed: %s", result)
            return result
        except Exception as error:
            atomic_write_json(marker, {"status": "failed", "error": str(error)}, durable=True)
            logger.exception("legacy asset import failed; will retry at startup")
            raise
