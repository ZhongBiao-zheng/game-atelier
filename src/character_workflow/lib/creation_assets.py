"""Application-level prompt and image assets shared by Studio and Canvas."""
from __future__ import annotations

import hashlib
import mimetypes
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import TypeAdapter, ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.canvas_projects import (
    _read_canvas_document_unlocked,
    canvas_project_dir,
    canvas_project_lock_path,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasCreationAssetOrigin,
    CanvasInputConnection,
    CanvasLibraryAsset,
    CanvasMediaVersion,
    CanvasPrompt,
    CanvasTextVersion,
    CreationAsset,
    CreationAssetCatalog,
    CreationAssetList,
    CreationImageAssetVersion,
    CreationPromptAssetVersion,
    CreationPromptSegment,
    CreationPromptTextSegment,
    CreationPromptVariableSegment,
    RevisionedSidecar,
)


_PROMPT_SEGMENTS = TypeAdapter(list[CreationPromptSegment])
_IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


class CreationAssetStateError(ValueError):
    """The global creation asset catalog is invalid on disk."""


class CreationAssetDuplicateError(ValueError):
    """Saving an image would duplicate an existing asset."""

    def __init__(self, asset_id: str):
        super().__init__("这张图片已经在资产库中")
        self.asset_id = asset_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _catalog_path() -> Path:
    return data_root.creation_assets_dir() / "catalog.json"


def _catalog_lock_path() -> Path:
    return data_root.runtime_dir() / "locks" / "creation-assets.lock"


def _empty_catalog() -> CreationAssetCatalog:
    return CreationAssetCatalog(updated_at=_now())


def _read_catalog_unlocked() -> CreationAssetCatalog:
    path = _catalog_path()
    if not path.exists():
        return _empty_catalog()
    try:
        return CreationAssetCatalog.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as error:
        raise CreationAssetStateError("创作资产库状态损坏") from error


def _write_catalog_unlocked(
    current: CreationAssetCatalog,
    assets: list[CreationAsset],
    *,
    migrated_canvas_project_ids: list[str] | None = None,
) -> CreationAssetCatalog:
    timestamp = _now()
    updated = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "assets": assets,
        "migrated_canvas_project_ids": (
            migrated_canvas_project_ids
            if migrated_canvas_project_ids is not None
            else current.migrated_canvas_project_ids
        ),
    })
    atomic_write_json(_catalog_path(), updated.model_dump(mode="json"))
    return updated


def _required_text(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label}不能为空")
    return normalized


def _normalize_tags(tags: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in tags:
        tag = raw.strip()
        key = tag.casefold()
        if not tag or key in seen:
            continue
        if len(tag) > 40:
            raise ValueError("标签不能超过 40 个字符")
        seen.add(key)
        normalized.append(tag)
    return normalized


def _normalize_project_ids(project_ids: list[str]) -> list[str]:
    return list(dict.fromkeys(project_id for project_id in project_ids if project_id))


def _normalize_segments(
    segments: list[CreationPromptSegment] | list[dict[str, str]],
) -> list[CreationPromptSegment]:
    parsed = _PROMPT_SEGMENTS.validate_python(segments)
    normalized: list[CreationPromptSegment] = []
    for segment in parsed:
        if segment.kind == "text":
            if normalized and normalized[-1].kind == "text":
                previous = normalized[-1]
                assert isinstance(previous, CreationPromptTextSegment)
                normalized[-1] = previous.model_copy(
                    update={"text": previous.text + segment.text},
                )
            else:
                normalized.append(segment)
            continue
        name = _required_text(segment.name, "变量名称")
        default_value = _required_text(segment.default_value, "变量默认内容")
        normalized.append(CreationPromptVariableSegment(
            kind="variable",
            name=name,
            default_value=default_value,
        ))
    rendered = render_prompt_segments(normalized, {})
    if not rendered.strip():
        raise ValueError("提示词内容不能为空")
    if len(rendered) > 40_000:
        raise ValueError("提示词内容不能超过 40000 个字符")
    return normalized


def render_prompt_segments(
    segments: list[CreationPromptSegment],
    values: dict[str, str],
) -> str:
    parts: list[str] = []
    for segment in segments:
        if segment.kind == "text":
            parts.append(segment.text)
            continue
        value = values.get(segment.name)
        parts.append(value if value is not None and value.strip() else segment.default_value)
    return "".join(parts)


def _prompt_variable_values(
    segments: list[CreationPromptSegment],
    values: dict[str, str],
) -> dict[str, str]:
    """Keep only explicit values that still exist in the selected prompt version."""
    names = {
        segment.name
        for segment in segments
        if segment.kind == "variable"
    }
    return {
        name: value
        for name, value in values.items()
        if name in names and isinstance(value, str)
    }


def _prompt_version(
    segments: list[CreationPromptSegment] | list[dict[str, str]],
    *,
    timestamp: str | None = None,
) -> CreationPromptAssetVersion:
    return CreationPromptAssetVersion(
        kind="prompt",
        version_id=f"asset-version-{secrets.token_hex(12)}",
        created_at=timestamp or _now(),
        segments=_normalize_segments(segments),
    )


def _image_mime(body: bytes, declared: str | None, filename: str) -> str:
    detected: str | None = None
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        detected = "image/png"
    elif body.startswith(b"\xff\xd8\xff"):
        detected = "image/jpeg"
    elif len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        detected = "image/webp"
    elif body.startswith((b"GIF87a", b"GIF89a")):
        detected = "image/gif"
    guessed = mimetypes.guess_type(filename)[0]
    mime_type = detected or declared or guessed
    if mime_type not in _IMAGE_SUFFIXES:
        raise ValueError("只支持 PNG、JPEG、WebP 或 GIF 图片")
    if detected and declared and declared != detected:
        raise ValueError("图片内容与声明的文件类型不一致")
    return mime_type


def _store_image_blob(body: bytes, filename: str, mime_type: str | None) -> CreationImageAssetVersion:
    if not body:
        raise ValueError("图片内容不能为空")
    if len(body) > 50 * 1024 * 1024:
        raise ValueError("图片不能超过 50 MiB")
    safe_filename = Path(filename).name or "image"
    detected_mime = _image_mime(body, mime_type, safe_filename)
    digest = hashlib.sha256(body).hexdigest()
    suffix = _IMAGE_SUFFIXES[detected_mime]
    relative = Path("creation-assets") / "blobs" / f"{digest}{suffix}"
    target = data_root.resolve_data_root() / relative
    if not target.exists():
        atomic_write_bytes(target, body)
    return CreationImageAssetVersion(
        kind="image",
        version_id=f"asset-version-{secrets.token_hex(12)}",
        created_at=_now(),
        path=relative.as_posix(),
        mime_type=detected_mime,
        bytes=len(body),
        sha256=digest,
        filename=safe_filename,
    )


def _new_asset(
    *,
    kind: Literal["prompt", "image"],
    title: str,
    tags: list[str],
    version: CreationPromptAssetVersion | CreationImageAssetVersion,
    project_id: str | None,
) -> CreationAsset:
    timestamp = version.created_at
    return CreationAsset(
        asset_id=f"creation-asset-{secrets.token_hex(10)}",
        kind=kind,
        title=_required_text(title, "资产标题"),
        tags=_normalize_tags(tags),
        created_at=timestamp,
        updated_at=timestamp,
        latest_version_id=version.version_id,
        versions=[version],
        project_ids=[project_id] if project_id else [],
    )


def create_prompt_asset(
    title: str,
    segments: list[CreationPromptSegment] | list[dict[str, str]],
    tags: list[str],
    project_id: str | None = None,
) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = _new_asset(
            kind="prompt",
            title=title,
            tags=tags,
            version=_prompt_version(segments),
            project_id=project_id,
        )
        _write_catalog_unlocked(current, [asset, *current.assets])
        return asset


def _image_duplicate(catalog: CreationAssetCatalog, digest: str) -> CreationAsset | None:
    for asset in catalog.assets:
        if asset.kind != "image":
            continue
        if any(version.sha256 == digest for version in asset.versions):
            return asset
    return None


def create_image_asset_from_bytes(
    *,
    title: str,
    body: bytes,
    filename: str,
    mime_type: str | None,
    tags: list[str],
    project_id: str | None = None,
    allow_existing: bool = False,
) -> CreationAsset:
    version = _store_image_blob(body, filename, mime_type)
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        duplicate = _image_duplicate(current, version.sha256)
        if duplicate:
            if not allow_existing:
                raise CreationAssetDuplicateError(duplicate.asset_id)
            project_ids = _normalize_project_ids([
                *duplicate.project_ids,
                *([project_id] if project_id else []),
            ])
            if project_ids == duplicate.project_ids:
                return duplicate
            timestamp = _now()
            reused = duplicate.model_copy(update={
                "project_ids": project_ids,
                "updated_at": timestamp,
            })
            _write_catalog_unlocked(
                current,
                [reused if row.asset_id == reused.asset_id else row for row in current.assets],
            )
            return reused
        asset = _new_asset(
            kind="image",
            title=title,
            tags=tags,
            version=version,
            project_id=project_id,
        )
        _write_catalog_unlocked(current, [asset, *current.assets])
        return asset


def create_image_asset_from_path(
    *,
    title: str,
    source_path: str,
    tags: list[str],
    project_id: str | None = None,
    allow_existing: bool = False,
) -> CreationAsset:
    root = data_root.resolve_data_root().resolve()
    source = Path(source_path)
    source = source.resolve() if source.is_absolute() else (root / source).resolve()
    try:
        source.relative_to(root)
    except ValueError as error:
        raise ValueError("图片路径不在数据目录内") from error
    if not source.is_file():
        raise FileNotFoundError(source_path)
    return create_image_asset_from_bytes(
        title=title,
        body=source.read_bytes(),
        filename=source.name,
        mime_type=mimetypes.guess_type(source.name)[0],
        tags=tags,
        project_id=project_id,
        allow_existing=allow_existing,
    )


def _replace_asset(
    current: CreationAssetCatalog,
    asset: CreationAsset,
) -> CreationAssetCatalog:
    return _write_catalog_unlocked(
        current,
        [asset if row.asset_id == asset.asset_id else row for row in current.assets],
    )


def get_creation_asset(asset_id: str) -> CreationAsset:
    migrate_legacy_canvas_libraries()
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        return asset


def list_creation_assets(
    *,
    kind: Literal["prompt", "image"] | None = None,
    scope: Literal["all", "project"] = "all",
    project_id: str | None = None,
    archived: bool = False,
) -> CreationAssetList:
    migrate_legacy_canvas_libraries()
    if scope == "project" and not project_id:
        raise ValueError("按项目查看资产时必须提供 project_id")
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        rows = [
            asset
            for asset in current.assets
            if (kind is None or asset.kind == kind)
            and ((asset.archived_at is not None) == archived)
            and (scope != "project" or project_id in asset.project_ids)
        ]
        rows.sort(key=lambda asset: asset.last_used_at or asset.created_at, reverse=True)
        tags: list[str] = []
        seen: set[str] = set()
        for asset in rows:
            for tag in asset.tags:
                key = tag.casefold()
                if key not in seen:
                    tags.append(tag)
                    seen.add(key)
        return CreationAssetList(revision=current.revision, assets=rows, recent_tags=tags[:20])


def patch_creation_asset_metadata(
    asset_id: str,
    *,
    title: str | None = None,
    tags: list[str] | None = None,
) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        changes: dict[str, object] = {"updated_at": _now()}
        if title is not None:
            changes["title"] = _required_text(title, "资产标题")
        if tags is not None:
            changes["tags"] = _normalize_tags(tags)
        updated = asset.model_copy(update=changes)
        _replace_asset(current, updated)
        return updated


def create_prompt_version(
    asset_id: str,
    segments: list[CreationPromptSegment] | list[dict[str, str]],
) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        if asset.kind != "prompt":
            raise ValueError("只有提示词资产可以创建提示词版本")
        version = _prompt_version(segments)
        updated = asset.model_copy(update={
            "latest_version_id": version.version_id,
            "versions": [*asset.versions, version],
            "updated_at": version.created_at,
        })
        _replace_asset(current, updated)
        return updated


def create_image_version_from_bytes(
    asset_id: str,
    *,
    body: bytes,
    filename: str,
    mime_type: str | None,
) -> CreationAsset:
    version = _store_image_blob(body, filename, mime_type)
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        if asset.kind != "image":
            raise ValueError("只有图片资产可以创建图片版本")
        duplicate = _image_duplicate(current, version.sha256)
        if duplicate:
            if duplicate.asset_id != asset_id:
                raise CreationAssetDuplicateError(duplicate.asset_id)
            existing = next(row for row in asset.versions if row.sha256 == version.sha256)
            if existing.version_id == asset.latest_version_id:
                return asset
        updated = asset.model_copy(update={
            "latest_version_id": version.version_id,
            "versions": [*asset.versions, version],
            "updated_at": version.created_at,
        })
        _replace_asset(current, updated)
        return updated


def restore_creation_asset_version(asset_id: str, version_id: str) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        source = next((version for version in asset.versions if version.version_id == version_id), None)
        if source is None:
            raise KeyError(version_id)
        timestamp = _now()
        restored = source.model_copy(update={
            "version_id": f"asset-version-{secrets.token_hex(12)}",
            "created_at": timestamp,
        })
        updated = asset.model_copy(update={
            "latest_version_id": restored.version_id,
            "versions": [*asset.versions, restored],
            "updated_at": timestamp,
        })
        _replace_asset(current, updated)
        return updated


def _set_archived(asset_id: str, archived: bool) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        timestamp = _now()
        updated = asset.model_copy(update={
            "archived_at": timestamp if archived else None,
            "updated_at": timestamp,
        })
        _replace_asset(current, updated)
        return updated


def archive_creation_asset(asset_id: str) -> CreationAsset:
    return _set_archived(asset_id, True)


def restore_creation_asset(asset_id: str) -> CreationAsset:
    return _set_archived(asset_id, False)


def mark_creation_asset_used(asset_id: str, project_id: str | None = None) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        timestamp = _now()
        project_ids = _normalize_project_ids([
            *asset.project_ids,
            *([project_id] if project_id else []),
        ])
        updated = asset.model_copy(update={
            "last_used_at": timestamp,
            "updated_at": timestamp,
            "project_ids": project_ids,
        })
        _replace_asset(current, updated)
        return updated


def remove_creation_asset_from_project(asset_id: str, project_id: str) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        updated = asset.model_copy(update={
            "project_ids": [value for value in asset.project_ids if value != project_id],
            "updated_at": _now(),
        })
        _replace_asset(current, updated)
        return updated


def remove_canvas_project_asset_relations(project_id: str) -> None:
    """Remove a deleted Canvas project from every global asset relation."""
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        if not any(project_id in asset.project_ids for asset in current.assets):
            return
        assets = [
            asset.model_copy(update={
                "project_ids": [value for value in asset.project_ids if value != project_id],
                "updated_at": _now(),
            })
            if project_id in asset.project_ids
            else asset
            for asset in current.assets
        ]
        _write_catalog_unlocked(current, assets)


def relate_imported_canvas_creation_assets(project_id: str) -> None:
    """Restore project scope for global assets referenced by an imported Canvas snapshot."""
    document = _read_canvas_document_unlocked(project_id)
    referenced_ids: set[str] = set()
    for version in document.content_versions.values():
        if version.origin.kind == "creation_asset":
            referenced_ids.add(version.origin.asset_id)
    for node in document.nodes:
        draft = (
            node.data.draft
            if node.type == "config"
            else getattr(node.data, "generation_draft", None)
        )
        asset_id = getattr(draft.params, "creation_prompt_asset_id", None) if draft else None
        if asset_id:
            referenced_ids.add(asset_id)
    if not referenced_ids:
        return
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        changed = False
        assets: list[CreationAsset] = []
        for asset in current.assets:
            if asset.asset_id not in referenced_ids or project_id in asset.project_ids:
                assets.append(asset)
                continue
            changed = True
            assets.append(asset.model_copy(update={
                "project_ids": [*asset.project_ids, project_id],
                "updated_at": _now(),
            }))
        if changed:
            _write_catalog_unlocked(current, assets)


def creation_asset_image_path(asset_id: str, version_id: str) -> Path:
    asset = get_creation_asset(asset_id)
    version = next((row for row in asset.versions if row.version_id == version_id), None)
    if version is None or version.kind != "image":
        raise KeyError(version_id)
    root = data_root.resolve_data_root().resolve()
    path = (root / version.path).resolve()
    try:
        path.relative_to(root / "creation-assets" / "blobs")
    except ValueError as error:
        raise CreationAssetStateError("图片资产路径越出创作资产目录") from error
    if not path.is_file():
        raise CreationAssetStateError("图片资产文件缺失")
    return path


def insert_creation_asset_into_canvas(
    *,
    project_id: str,
    asset_id: str,
    position,
    expected_revision: int,
    variable_values: dict[str, str] | None = None,
    target_node_id: str | None = None,
):
    """Pin the latest global asset version into a Canvas document.

    Canvas receives its own immutable content snapshot.  The origin keeps the global asset/version
    identity, while later user edits create a normal user_edit version and therefore sever the link.
    """
    from character_workflow.lib.canvas_library import _content_node
    from character_workflow.lib.canvas_projects import (
        _commit_canvas_upload,
        _display_image_dimensions,
        _document_path,
        _project_path,
        _recover_canvas_transactions_unlocked,
        canvas_project_dir,
        read_canvas_project,
    )

    values = variable_values or {}
    asset = get_creation_asset(asset_id)
    if asset.archived_at is not None:
        raise ValueError("已归档的创作资产不能插入画布")
    source_version = next(
        (version for version in asset.versions if version.version_id == asset.latest_version_id),
        None,
    )
    if source_version is None:
        raise CreationAssetStateError("创作资产缺少最新版本")
    if source_version.kind == "prompt":
        values = _prompt_variable_values(source_version.segments, values)
    image_body: bytes | None = None
    if source_version.kind == "image":
        image_body = creation_asset_image_path(asset_id, source_version.version_id).read_bytes()

    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        target = next((node for node in current.nodes if node.id == target_node_id), None)
        if target_node_id and target is None:
            raise KeyError(target_node_id)
        if target is not None:
            draft = getattr(target.data, "generation_draft", None)
            if getattr(target, "type", None) == "config":
                draft = getattr(target.data, "draft", None)
            if source_version.kind != "image" or draft is None or draft.mode not in {"image", "video"}:
                raise ValueError("当前生成面板不能接收这个创作资产")

        timestamp = _now()
        version_id = f"version-{secrets.token_hex(12)}"
        origin = CanvasCreationAssetOrigin(
            kind="creation_asset",
            asset_id=asset.asset_id,
            asset_version_id=source_version.version_id,
            variable_values=values,
        )
        write_target: Path | None = None
        if source_version.kind == "prompt":
            rendered = render_prompt_segments(source_version.segments, values)
            canvas_version = CanvasTextVersion(
                version_id=version_id,
                created_at=timestamp,
                sha256=hashlib.sha256(rendered.encode("utf-8")).hexdigest(),
                origin=origin,
                kind="text",
                text=rendered,
            )
        else:
            assert image_body is not None
            suffix = _IMAGE_SUFFIXES[source_version.mime_type]
            relative = Path("uploads") / f"creation-asset-{secrets.token_hex(12)}{suffix}"
            write_target = canvas_project_dir(project_id) / relative
            width, height = _display_image_dimensions(image_body)
            canvas_version = CanvasMediaVersion(
                version_id=version_id,
                created_at=timestamp,
                sha256=source_version.sha256,
                origin=origin,
                kind="image",
                path=relative.as_posix(),
                mime_type=source_version.mime_type,
                bytes=len(image_body),
                width=width,
                height=height,
            )
        node = _content_node(version_id, asset.title, position, canvas_version.kind)
        connections = list(current.connections)
        if target_node_id:
            connections.append(CanvasInputConnection(
                id=f"connection-{secrets.token_hex(10)}",
                role="input",
                source_node_id=node.id,
                target_node_id=target_node_id,
            ))
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [*current.nodes, node],
            "connections": connections,
            "content_versions": {**current.content_versions, version_id: canvas_version},
        })
        project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
        if write_target is not None:
            assert image_body is not None
            _commit_canvas_upload(project_id, project, updated, write_target, image_body, timestamp)
        else:
            atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
            atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))

    mark_creation_asset_used(asset_id, project_id)
    return updated


def update_creation_asset_references_in_canvas(
    *,
    project_id: str,
    asset_id: str,
    node_id: str,
    update_all: bool,
    expected_revision: int,
):
    """Explicitly repin one or every current Canvas node reference to the latest asset version."""
    from character_workflow.lib.canvas_projects import (
        _commit_canvas_upload,
        _display_image_dimensions,
        _document_path,
        _project_path,
        _recover_canvas_transactions_unlocked,
        read_canvas_project,
    )

    asset = get_creation_asset(asset_id)
    if asset.archived_at is not None:
        raise ValueError("已归档的创作资产不能更新引用")
    source_version = next(
        (version for version in asset.versions if version.version_id == asset.latest_version_id),
        None,
    )
    if source_version is None:
        raise CreationAssetStateError("创作资产缺少最新版本")
    image_body = (
        creation_asset_image_path(asset_id, source_version.version_id).read_bytes()
        if source_version.kind == "image"
        else None
    )

    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        selected = next((node for node in current.nodes if node.id == node_id), None)
        if selected is None:
            raise KeyError(node_id)

        def referenced_origin(node):
            if node.type not in {"text", "image", "video", "audio"}:
                return None
            current_version_id = node.data.current_version_id
            version = current.content_versions.get(current_version_id or "")
            if version is None or version.origin.kind != "creation_asset":
                return None
            return version.origin if version.origin.asset_id == asset_id else None

        def referenced_draft(node):
            draft = (
                node.data.draft
                if node.type == "config"
                else getattr(node.data, "generation_draft", None)
            )
            if draft is None or draft.params.creation_prompt_asset_id != asset_id:
                return None
            return draft

        selected_origin = referenced_origin(selected)
        selected_draft = referenced_draft(selected)
        if selected_origin is None and selected_draft is None:
            raise ValueError("所选节点不是这个创作资产的引用")
        if selected_draft is not None and source_version.kind != "prompt":
            raise ValueError("生成草稿只能引用提示词资产")
        content_targets = [
            node
            for node in current.nodes
            if referenced_origin(node) is not None and (update_all or node.id == node_id)
        ]
        draft_targets = [
            node
            for node in current.nodes
            if source_version.kind == "prompt"
            and referenced_draft(node) is not None
            and (update_all or node.id == node_id)
        ]
        stale_content_targets = [
            node
            for node in content_targets
            if referenced_origin(node).asset_version_id != source_version.version_id
        ]
        stale_draft_targets = [
            node
            for node in draft_targets
            if referenced_draft(node).params.creation_prompt_version_id != source_version.version_id
        ]
        if not stale_content_targets and not stale_draft_targets:
            return current

        timestamp = _now()
        new_versions = {}
        next_version_by_node: dict[str, str] = {}
        write_target: Path | None = None
        if source_version.kind == "image":
            if any(node.type != "image" for node in stale_content_targets):
                raise ValueError("图片资产只能更新图片节点")
            assert image_body is not None
            version_id = f"version-{secrets.token_hex(12)}"
            suffix = _IMAGE_SUFFIXES[source_version.mime_type]
            relative = Path("uploads") / f"creation-asset-{secrets.token_hex(12)}{suffix}"
            write_target = canvas_project_dir(project_id) / relative
            width, height = _display_image_dimensions(image_body)
            canvas_version = CanvasMediaVersion(
                version_id=version_id,
                created_at=timestamp,
                sha256=source_version.sha256,
                origin=CanvasCreationAssetOrigin(
                    kind="creation_asset",
                    asset_id=asset.asset_id,
                    asset_version_id=source_version.version_id,
                ),
                kind="image",
                path=relative.as_posix(),
                mime_type=source_version.mime_type,
                bytes=len(image_body),
                width=width,
                height=height,
            )
            new_versions[version_id] = canvas_version
            next_version_by_node = {node.id: version_id for node in stale_content_targets}
        else:
            if any(node.type != "text" for node in stale_content_targets):
                raise ValueError("提示词资产只能更新文本节点")
            for node in stale_content_targets:
                previous_origin = referenced_origin(node)
                values = _prompt_variable_values(
                    source_version.segments,
                    previous_origin.variable_values,
                )
                rendered = render_prompt_segments(source_version.segments, values)
                version_id = f"version-{secrets.token_hex(12)}"
                new_versions[version_id] = CanvasTextVersion(
                    version_id=version_id,
                    created_at=timestamp,
                    sha256=hashlib.sha256(rendered.encode("utf-8")).hexdigest(),
                    origin=CanvasCreationAssetOrigin(
                        kind="creation_asset",
                        asset_id=asset.asset_id,
                        asset_version_id=source_version.version_id,
                        variable_values=values,
                    ),
                    kind="text",
                    text=rendered,
                )
                next_version_by_node[node.id] = version_id

        draft_target_ids = {node.id for node in stale_draft_targets}
        updated_nodes = []
        for node in current.nodes:
            data = node.data
            if node.id in next_version_by_node:
                data = data.model_copy(update={
                    "current_version_id": next_version_by_node[node.id],
                })
            if node.id in draft_target_ids:
                draft = referenced_draft(node)
                values = _prompt_variable_values(
                    source_version.segments,
                    draft.params.creation_prompt_variable_values or {},
                )
                updated_draft = draft.model_copy(update={
                    "prompt": render_prompt_segments(source_version.segments, values),
                    "params": draft.params.model_copy(update={
                        "creation_prompt_asset_id": asset.asset_id,
                        "creation_prompt_version_id": source_version.version_id,
                        "creation_prompt_variable_values": values,
                    }),
                    "updated_at": timestamp,
                })
                draft_field = "draft" if node.type == "config" else "generation_draft"
                data = data.model_copy(update={draft_field: updated_draft})
            updated_nodes.append(node.model_copy(update={"data": data}))
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": updated_nodes,
            "content_versions": {**current.content_versions, **new_versions},
        })
        project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
        if write_target is not None:
            assert image_body is not None
            _commit_canvas_upload(project_id, project, updated, write_target, image_body, timestamp)
        else:
            atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
            atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))

    mark_creation_asset_used(asset_id, project_id)
    return updated


def migrate_legacy_canvas_libraries() -> int:
    root = data_root.canvases_dir()
    if not root.is_dir():
        return 0
    migrated_count = 0
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        assets = list(current.assets)
        migrated_ids = list(current.migrated_canvas_project_ids)
        migrated_set = set(migrated_ids)
        changed = False
        for project_dir in sorted(root.iterdir()):
            project_id = project_dir.name
            if project_id in migrated_set or not (project_dir / "project.json").is_file():
                continue
            asset_path = project_dir / "library" / "assets.json"
            prompt_path = project_dir / "library" / "prompts.json"
            try:
                with file_lock(canvas_project_lock_path(project_id)):
                    document = _read_canvas_document_unlocked(project_id)
                    legacy_assets = (
                        RevisionedSidecar[CanvasLibraryAsset].model_validate_json(
                            asset_path.read_text(encoding="utf-8")
                        ).items
                        if asset_path.is_file()
                        else []
                    )
                    legacy_prompts = (
                        RevisionedSidecar[CanvasPrompt].model_validate_json(
                            prompt_path.read_text(encoding="utf-8")
                        ).items
                        if prompt_path.is_file()
                        else []
                    )
            except (OSError, ValidationError, ValueError):
                continue

            for prompt in legacy_prompts:
                version = _prompt_version([{
                    "kind": "text",
                    "text": prompt.content,
                }])
                assets.insert(0, _new_asset(
                    kind="prompt",
                    title=prompt.title,
                    tags=prompt.tags,
                    version=version,
                    project_id=project_id,
                ))
                migrated_count += 1

            for legacy_asset in legacy_assets:
                canvas_version = document.content_versions.get(legacy_asset.version_id)
                if canvas_version is None or canvas_version.kind != "image":
                    continue
                source = canvas_project_dir(project_id) / canvas_version.path
                if not source.is_file():
                    continue
                version = _store_image_blob(
                    source.read_bytes(),
                    source.name,
                    canvas_version.mime_type,
                )
                duplicate = next((
                    row
                    for row in assets
                    if row.kind == "image"
                    and any(item.sha256 == version.sha256 for item in row.versions)
                ), None)
                if duplicate:
                    project_ids = _normalize_project_ids([*duplicate.project_ids, project_id])
                    assets = [
                        row.model_copy(update={"project_ids": project_ids})
                        if row.asset_id == duplicate.asset_id
                        else row
                        for row in assets
                    ]
                else:
                    assets.insert(0, _new_asset(
                        kind="image",
                        title=legacy_asset.title,
                        tags=legacy_asset.tags,
                        version=version,
                        project_id=project_id,
                    ))
                migrated_count += 1

            migrated_ids.append(project_id)
            migrated_set.add(project_id)
            changed = True
        if changed:
            _write_catalog_unlocked(
                current,
                assets,
                migrated_canvas_project_ids=migrated_ids,
            )
    return migrated_count
