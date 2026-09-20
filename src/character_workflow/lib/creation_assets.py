"""Application-level prompt and media assets shared by Studio and Canvas."""
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
from character_workflow.lib.media_probe import mp4_track_dimensions as video_dimensions_from_bytes
from character_workflow.lib.prompt_variables import build_prompt_variable_template
from character_workflow.lib.schemas import (
    AdoptionOrigin,
    CanvasCreationAssetSnapshotOrigin,
    CanvasInputConnection,
    CanvasLibraryAsset,
    CanvasMediaVersion,
    CanvasPrompt,
    CanvasTextVersion,
    CreationAsset,
    CreationAssetCatalog,
    CreationAssetList,
    CreationAssetRecommendation,
    CreationMediaAssetContent,
    CreationPromptAssetContent,
    CreationPromptSegment,
    CreationPromptTextSegment,
    CreationPromptVariableSegment,
    RevisionedSidecar,
)


_PROMPT_SEGMENTS = TypeAdapter(list[CreationPromptSegment])
MEDIA_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
}
# 上限按类型分档：图片小、音频中、视频大。
_MEDIA_SIZE_LIMITS = {
    "image": 50 * 1024 * 1024,
    "audio": 100 * 1024 * 1024,
    "video": 500 * 1024 * 1024,
}
_MEDIA_SIZE_LABELS = {"image": "图片", "audio": "音频", "video": "视频"}


class CreationAssetStateError(ValueError):
    """The global creation asset catalog is invalid on disk."""


class CreationAssetDuplicateError(ValueError):
    """Saving a media file would duplicate an existing asset."""

    def __init__(self, asset_id: str):
        super().__init__("这个文件已经在资产库中")
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


def _prompt_content(
    segments: list[CreationPromptSegment] | list[dict[str, str]],
) -> CreationPromptAssetContent:
    return CreationPromptAssetContent(
        kind="prompt",
        segments=_normalize_segments(segments),
    )


def _media_mime(body: bytes, declared: str | None, filename: str) -> str:
    detected: str | None = None
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        detected = "image/png"
    elif body.startswith(b"\xff\xd8\xff"):
        detected = "image/jpeg"
    elif len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        detected = "image/webp"
    elif body.startswith((b"GIF87a", b"GIF89a")):
        detected = "image/gif"
    elif len(body) >= 12 and body[4:8] == b"ftyp":
        brand = body[8:12]
        if brand in {b"M4A ", b"M4B "}:
            detected = "audio/mp4"
        elif brand == b"qt  ":
            detected = "video/quicktime"
        elif declared == "audio/mp4":
            # ffmpeg 产出的 .m4a brand 常是 mp42 / isom，容器与 mp4 同构，brand 分不出音轨：信声明。
            detected = "audio/mp4"
        else:
            detected = "video/mp4"
    elif body.startswith(b"\x1a\x45\xdf\xa3"):
        detected = "video/webm"
    elif body.startswith(b"ID3") or body[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        detected = "audio/mpeg"
    elif len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WAVE":
        detected = "audio/wav"
    guessed = mimetypes.guess_type(filename)[0]
    mime_type = detected or declared or guessed
    if mime_type not in MEDIA_SUFFIXES:
        raise ValueError(
            "只支持 PNG、JPEG、WebP、GIF 图片，MP4、WebM、MOV 视频，MP3、WAV、M4A 音频"
        )
    if detected and declared and declared != detected:
        raise ValueError("文件内容与声明的文件类型不一致")
    return mime_type


def store_media_blob(
    body: bytes,
    filename: str,
    mime_type: str | None,
) -> CreationMediaAssetContent:
    if not body:
        raise ValueError("文件内容不能为空")
    safe_filename = Path(filename).name or "media"
    detected_mime = _media_mime(body, mime_type, safe_filename)
    family = detected_mime.split("/", 1)[0]
    limit = _MEDIA_SIZE_LIMITS.get(family, 50 * 1024 * 1024)
    if len(body) > limit:
        label = _MEDIA_SIZE_LABELS.get(family, "文件")
        raise ValueError(f"{label}不能超过 {limit // (1024 * 1024)} MiB")
    digest = hashlib.sha256(body).hexdigest()
    suffix = MEDIA_SUFFIXES[detected_mime]
    relative = Path("creation-assets") / "blobs" / f"{digest}{suffix}"
    target = data_root.resolve_data_root() / relative
    if not target.exists():
        atomic_write_bytes(target, body)
    return CreationMediaAssetContent(
        kind="media",
        path=relative.as_posix(),
        mime_type=detected_mime,
        bytes=len(body),
        sha256=digest,
        filename=safe_filename,
    )


def new_creation_asset_id() -> str:
    return f"creation-asset-{secrets.token_hex(10)}"


def _new_asset(
    *,
    kind: Literal["prompt", "media"],
    title: str,
    tags: list[str],
    content: CreationPromptAssetContent | CreationMediaAssetContent,
    project_id: str | None,
    recommendation: CreationAssetRecommendation | None = None,
    adopted_from: AdoptionOrigin | None = None,
) -> CreationAsset:
    timestamp = _now()
    return CreationAsset(
        asset_id=new_creation_asset_id(),
        kind=kind,
        title=_required_text(title, "资产标题"),
        tags=_normalize_tags(tags),
        created_at=timestamp,
        updated_at=timestamp,
        content=content,
        project_ids=[project_id] if project_id else [],
        recommendation=recommendation,
        adopted_from=adopted_from,
    )


def create_prompt_asset(
    title: str,
    segments: list[CreationPromptSegment] | list[dict[str, str]],
    tags: list[str],
    project_id: str | None = None,
    recommendation: CreationAssetRecommendation | None = None,
) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = _new_asset(
            kind="prompt",
            title=title,
            tags=tags,
            content=_prompt_content(segments),
            project_id=project_id,
            recommendation=recommendation,
        )
        _write_catalog_unlocked(current, [asset, *current.assets])
        return asset


def _media_duplicate(catalog: CreationAssetCatalog, digest: str) -> CreationAsset | None:
    for asset in catalog.assets:
        if asset.kind != "media":
            continue
        if asset.content.kind == "media" and asset.content.sha256 == digest:
            return asset
    return None


def create_media_asset_from_bytes(
    *,
    title: str,
    body: bytes,
    filename: str,
    mime_type: str | None,
    tags: list[str],
    project_id: str | None = None,
    allow_existing: bool = False,
) -> CreationAsset:
    content = store_media_blob(body, filename, mime_type)
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        duplicate = _media_duplicate(current, content.sha256)
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
            kind="media",
            title=title,
            tags=tags,
            content=content,
            project_id=project_id,
        )
        _write_catalog_unlocked(current, [asset, *current.assets])
        return asset


def create_media_asset_from_path(
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
        raise ValueError("文件路径不在数据目录内") from error
    if not source.is_file():
        raise FileNotFoundError(source_path)
    return create_media_asset_from_bytes(
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
    kind: Literal["prompt", "media"] | None = None,
    scope: Literal["all", "project"] = "all",
    project_id: str | None = None,
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
            and (scope != "project" or project_id in asset.project_ids)
        ]
        rows.sort(key=lambda asset: asset.last_used_at or asset.created_at, reverse=True)
        return CreationAssetList(revision=current.revision, assets=rows)


def list_prompt_asset_index(
    *,
    tags: list[str] | None = None,
    query: str | None = None,
    project_id: str | None = None,
    limit: int = 20,
) -> dict:
    """Agent 用的提示词资产索引：不带正文，服务端过滤，附全库标签词表。

    tags 为「全部命中」（大小写不敏感）；query 是标题子串。排序：归属当前项目的在前，
    再按最近使用 / 创建时间倒序。tag_facets 统计的是全部提示词资产，不受过滤影响——
    Agent 靠它知道库里有哪些标签可选。
    """
    migrate_legacy_canvas_libraries()
    wanted = {tag.strip().casefold() for tag in (tags or []) if tag.strip()}
    needle = (query or "").strip().casefold()
    with file_lock(_catalog_lock_path()):
        prompts = [asset for asset in _read_catalog_unlocked().assets if asset.kind == "prompt"]
    counts: dict[str, int] = {}
    labels: dict[str, str] = {}
    for asset in prompts:
        for tag in asset.tags:
            key = tag.casefold()
            counts[key] = counts.get(key, 0) + 1
            labels.setdefault(key, tag)
    facets = [{"tag": labels[key], "count": counts[key]}
              for key in sorted(counts, key=lambda k: (-counts[k], labels[k]))]
    rows = [
        asset for asset in prompts
        if wanted <= {tag.casefold() for tag in asset.tags}
        and (not needle or needle in asset.title.casefold())
    ]
    rows.sort(key=lambda asset: asset.last_used_at or asset.created_at, reverse=True)
    if project_id:
        rows.sort(key=lambda asset: 0 if project_id in asset.project_ids else 1)
    return {
        "assets": [{
            "asset_id": asset.asset_id,
            "title": asset.title,
            "tags": asset.tags,
            "last_used_at": asset.last_used_at,
            "has_recommendation": asset.recommendation is not None,
        } for asset in rows[:limit]],
        "total": len(rows),
        "tag_facets": facets,
    }


def read_prompt_asset(asset_id: str, project_id: str | None = None) -> dict:
    """读一条提示词资产全文并记一次使用（Agent 只读它准备采用的那条；浏览走索引接口）。"""
    if get_creation_asset(asset_id).kind != "prompt":
        raise ValueError("只有提示词资产可以通过这个入口读取")
    asset = mark_creation_asset_used(asset_id, project_id)
    segments = asset.content.segments
    return {
        "asset_id": asset.asset_id,
        "title": asset.title,
        "tags": asset.tags,
        "segments": [segment.model_dump() for segment in segments],
        "variables": [{"name": segment.name, "default_value": segment.default_value}
                      for segment in segments if segment.kind == "variable"],
        "prompt": render_prompt_segments(segments, {}),
        "recommendation": asset.recommendation.model_dump() if asset.recommendation else None,
    }


def update_prompt_asset(
    asset_id: str,
    *,
    title: str,
    segments: list[CreationPromptSegment] | list[dict[str, str]],
    tags: list[str],
    recommendation: CreationAssetRecommendation | None = None,
) -> CreationAsset:
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        if asset.kind != "prompt":
            raise ValueError("只有提示词资产可以使用这个编辑入口")
        updated = asset.model_copy(update={
            "title": _required_text(title, "资产标题"),
            "tags": _normalize_tags(tags),
            "content": _prompt_content(segments),
            "recommendation": recommendation,
            "updated_at": _now(),
        })
        _replace_asset(current, updated)
        return updated


def update_media_asset_from_bytes(
    asset_id: str,
    *,
    title: str,
    tags: list[str],
    body: bytes | None = None,
    filename: str = "media",
    mime_type: str | None = None,
) -> CreationAsset:
    orphan_path: Path | None = None
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        if asset.kind != "media":
            raise ValueError("只有媒体资产可以使用这个编辑入口")
        replacement = store_media_blob(body, filename, mime_type) if body is not None else None
        content = replacement or asset.content
        assert content.kind == "media"
        duplicate = _media_duplicate(current, content.sha256)
        if duplicate and duplicate.asset_id != asset_id:
            raise CreationAssetDuplicateError(duplicate.asset_id)
        updated = asset.model_copy(update={
            "title": _required_text(title, "资产标题"),
            "tags": _normalize_tags(tags),
            "content": content,
            "updated_at": _now(),
        })
        _replace_asset(current, updated)
        assert asset.content.kind == "media"
        if content.path != asset.content.path and not any(
            row.asset_id != asset_id
            and row.content.kind == "media"
            and row.content.path == asset.content.path
            for row in current.assets
        ):
            orphan_path = _media_blob_path(asset.content)
    if orphan_path is not None:
        orphan_path.unlink(missing_ok=True)
    return updated


def delete_creation_asset(asset_id: str) -> None:
    """Physically remove one asset and delete its blob when no other asset uses it."""
    orphan_path: Path | None = None
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        asset = next((row for row in current.assets if row.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        remaining = [row for row in current.assets if row.asset_id != asset_id]
        if asset.content.kind == "media" and not any(
            row.content.kind == "media" and row.content.path == asset.content.path
            for row in remaining
        ):
            orphan_path = _media_blob_path(asset.content)
        _write_catalog_unlocked(current, remaining)
    if orphan_path is not None:
        orphan_path.unlink(missing_ok=True)


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


def _media_blob_path(content: CreationMediaAssetContent) -> Path:
    root = data_root.resolve_data_root().resolve()
    path = (root / content.path).resolve()
    try:
        path.relative_to(root / "creation-assets" / "blobs")
    except ValueError as error:
        raise CreationAssetStateError("媒体资产路径越出创作资产目录") from error
    return path


def creation_asset_media_path(asset_id: str) -> Path:
    asset = get_creation_asset(asset_id)
    content = asset.content
    if content.kind != "media":
        raise KeyError(asset_id)
    path = _media_blob_path(content)
    if not path.is_file():
        raise CreationAssetStateError("媒体资产文件缺失")
    return path


def create_adopted_asset(asset: CreationAsset) -> CreationAsset:
    """把已经构造好的采用资产追加进目录（asset_id 由调用方生成）。"""
    migrate_legacy_canvas_libraries()
    with file_lock(_catalog_lock_path()):
        current = _read_catalog_unlocked()
        if any(row.asset_id == asset.asset_id for row in current.assets):
            raise ValueError("creation asset id already exists")
        _write_catalog_unlocked(current, [*current.assets, asset])
        return asset


def find_adopted_asset(library_id: str, asset_id: str) -> CreationAsset | None:
    with file_lock(_catalog_lock_path()):
        for row in _read_catalog_unlocked().assets:
            origin = row.adopted_from
            if origin and origin.library_id == library_id and origin.asset_id == asset_id:
                return row
    return None


def find_media_asset_by_sha256(digest: str) -> CreationAsset | None:
    with file_lock(_catalog_lock_path()):
        return _media_duplicate(_read_catalog_unlocked(), digest)


def insert_creation_asset_into_canvas(
    *,
    project_id: str,
    asset_id: str,
    position,
    expected_revision: int,
    variable_values: dict[str, str] | None = None,
    target_node_id: str | None = None,
):
    """Copy the current asset content into Canvas with a frozen title-only provenance snapshot."""
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
    content = asset.content
    media_body: bytes | None = None
    if content.kind == "media":
        media_body = creation_asset_media_path(asset_id).read_bytes()

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
            if (
                content.kind != "media"
                or not content.mime_type.startswith("image/")
                or draft is None
                or draft.mode not in {"image", "video"}
            ):
                raise ValueError("当前生成面板不能接收这个创作资产")

        timestamp = _now()
        version_id = f"version-{secrets.token_hex(12)}"
        origin = CanvasCreationAssetSnapshotOrigin(
            kind="creation_asset_snapshot",
            title=asset.title,
        )
        write_target: Path | None = None
        if content.kind == "prompt":
            rendered = build_prompt_variable_template(content.segments, values)
            canvas_version = CanvasTextVersion(
                version_id=version_id,
                created_at=timestamp,
                sha256=hashlib.sha256(rendered.encode("utf-8")).hexdigest(),
                origin=origin,
                kind="text",
                text=rendered,
            )
        else:
            assert media_body is not None
            media_kind = content.mime_type.split("/", 1)[0]  # image | video | audio
            suffix = MEDIA_SUFFIXES[content.mime_type]
            relative = Path("uploads") / f"creation-asset-{secrets.token_hex(12)}{suffix}"
            write_target = canvas_project_dir(project_id) / relative
            width = height = None
            if media_kind == "image":
                width, height = _display_image_dimensions(media_body)
            elif media_kind == "video":
                dims = video_dimensions_from_bytes(media_body)
                if dims:
                    width, height = dims
            canvas_version = CanvasMediaVersion(
                version_id=version_id,
                created_at=timestamp,
                sha256=content.sha256,
                origin=origin,
                kind=media_kind,
                path=relative.as_posix(),
                mime_type=content.mime_type,
                bytes=len(media_body),
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
            assert media_body is not None
            _commit_canvas_upload(project_id, project, updated, write_target, media_body, timestamp)
        else:
            atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
            atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))

    mark_creation_asset_used(asset_id, project_id)
    return updated


def migrate_creation_asset_catalog_schema() -> None:
    """读目录前先把 v2 目录升到 v3。

    server 启动时已经跑过一次；Skill CLI / workshop 这些非 server 入口没有 lifespan，
    不在这里补一次就会在 `_read_catalog_unlocked` 里以「创作资产库状态损坏」炸出来。
    延迟 import：迁移模块反向依赖 canvas_projects / jobs。
    """
    from character_workflow.lib.creation_assets_migration import migrate_creation_assets_to_media

    migrate_creation_assets_to_media()


def migrate_legacy_canvas_libraries() -> int:
    migrate_creation_asset_catalog_schema()
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
                content = _prompt_content([{
                    "kind": "text",
                    "text": prompt.content,
                }])
                assets.insert(0, _new_asset(
                    kind="prompt",
                    title=prompt.title,
                    tags=prompt.tags,
                    content=content,
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
                content = store_media_blob(
                    source.read_bytes(),
                    source.name,
                    canvas_version.mime_type,
                )
                duplicate = next((
                    row
                    for row in assets
                    if row.kind == "media"
                    and row.content.kind == "media"
                    and row.content.sha256 == content.sha256
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
                        kind="media",
                        title=legacy_asset.title,
                        tags=legacy_asset.tags,
                        content=content,
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
