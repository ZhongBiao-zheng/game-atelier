"""网关共享库：显式公开字段，逐请求校验共享状态，只输出派生缩略图。"""
from __future__ import annotations

import hashlib
import re
from collections import Counter
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import team_library as libraries
from character_workflow.lib import team_library_index as indexer
from character_workflow.lib.schemas import (
    TEAM_ASSET_ID_PATTERN, TEAM_LIBRARY_ID_PATTERN, TeamLibraryIndexEntry, TeamLibraryMount,
)


class SharedLibrary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    name: str
    owner_name: str
    updated_at: str
    counts: dict[str, int]


class SharedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry_id: str = Field(pattern=TEAM_ASSET_ID_PATTERN)
    kind: Literal["raw", "media", "generation", "prompt"]
    title: str
    author: str | None = None
    mime_type: str | None = None
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    tags: list[str]
    category: str | None = None
    prompt_text: str | None = None
    preview_count: int = Field(default=0, ge=0, le=8)


def public_id(entry: TeamLibraryIndexEntry) -> str:
    if entry.kind == "raw":
        return "ta_" + hashlib.sha256(entry.id.encode()).hexdigest()[:26].upper()
    return entry.id


def shared_mount(library_id: str) -> TeamLibraryMount:
    try:
        if not re.fullmatch(TEAM_LIBRARY_ID_PATTERN, library_id):
            raise KeyError(library_id)
        if library_id not in libraries.shared_library_ids():
            raise KeyError(library_id)
        mount = libraries.get_mount(library_id)
        if libraries.read_manifest(Path(mount.mount_path)).library_id != library_id:
            raise KeyError(library_id)
        return mount
    except (KeyError, OSError, ValueError):
        raise HTTPException(404, "共享库不可用") from None


def _safe_path(mount: TeamLibraryMount, relative: str, *, raw: bool = False) -> Path:
    root = Path(mount.mount_path).resolve()
    path = root / relative
    resolved = path.resolve()
    # 同时检查声明路径与解析后的路径，挡住大小写别名、反斜线与指向隐藏目录的软链接。
    for candidate in (path, resolved):
        parts = candidate.relative_to(root).parts
        if not parts or any(p.startswith(".") or "\\" in p or ":" in p for p in parts):
            raise ValueError("路径不可用")
        if raw and any(p.casefold() == "shared" for p in parts):
            raise ValueError("路径不可用")
    return resolved


def available_entries(mount: TeamLibraryMount) -> list[TeamLibraryIndexEntry]:
    index = indexer.read_index(mount.library_id) or indexer.build_index(mount)
    entries = []
    for entry in index.entries:
        if entry.status != "ready" or not re.fullmatch(TEAM_ASSET_ID_PATTERN, public_id(entry)):
            continue
        try:
            path = _safe_path(mount, entry.relative_path, raw=entry.kind == "raw")
            if not path.exists():
                continue
            if entry.kind != "raw":
                manifest = indexer.asset_dir_file(path, "asset.json")
                if manifest is None:
                    continue
                _safe_path(mount, str(manifest.relative_to(Path(mount.mount_path).resolve())))
            entries.append(entry)
        except (OSError, ValueError):
            continue
    return entries


def _entry(library_id: str, entry_id: str):
    mount = shared_mount(library_id)
    if not re.fullmatch(TEAM_ASSET_ID_PATTERN, entry_id):
        raise HTTPException(404, "条目不可用")
    entry = next((e for e in available_entries(mount) if public_id(e) == entry_id), None)
    if entry is None:
        raise HTTPException(404, "条目不可用")
    return mount, entry


def create_router(require_key) -> APIRouter:
    router = APIRouter(prefix="/gateway/v1/libraries", dependencies=[Depends(require_key)])

    @router.get("", response_model=list[SharedLibrary])
    def list_libraries():
        profile = libraries.read_profile()
        result = []
        for library_id in sorted(libraries.shared_library_ids()):
            try:
                mount = shared_mount(library_id)
                entries = available_entries(mount)
                result.append(SharedLibrary(
                    id=library_id, name=mount.name,
                    owner_name=profile.display_name if profile else "未署名",
                    updated_at=max((e.updated_at for e in entries), default=mount.mounted_at),
                    counts=dict(Counter(e.kind for e in entries)),
                ))
            except HTTPException:
                continue
        return result

    @router.get("/{library_id}/assets", response_model=list[SharedEntry], response_model_exclude_none=True)
    def list_assets(library_id: str):
        mount = shared_mount(library_id)
        result = [SharedEntry(
            entry_id=public_id(e), kind=e.kind, title=e.title, author=e.author,
            mime_type=e.mime_type, tags=e.tags, category=e.category,
            prompt_text=e.prompt_text if e.kind == "prompt" else None,
            preview_count=len(e.preview_images) if e.kind == "prompt" else 0,
        ) for e in available_entries(mount)]
        shared_mount(library_id)
        return result

    def thumbnail(library_id: str, entry_id: str, w: int, n: int | None = None):
        mount, entry = _entry(library_id, entry_id)
        try:
            if n is None:
                content = indexer.entry_content_path(mount, entry)
                _safe_path(mount, str(content.relative_to(Path(mount.mount_path).resolve())),
                           raw=entry.kind == "raw")
                body = indexer.thumbnail_bytes(mount, entry, w)
            else:
                if entry.kind != "prompt" or not 0 <= n < len(entry.preview_images):
                    raise ValueError("效果图不存在")
                body = indexer.prompt_preview_thumbnail_bytes(mount, entry, entry.preview_images[n].file, w)
        except (OSError, ValueError):
            body = None
        shared_mount(library_id)  # 缓存命中也不能越过关闭共享的闸门。
        if body is None:
            raise HTTPException(404, "缩略图不可用")
        return Response(body, media_type="image/webp", headers={"Cache-Control": "no-store"})

    @router.get("/{library_id}/assets/{entry_id}/thumb")
    def image_thumb(library_id: str, entry_id: str, w: int = Query(512, ge=1, le=1024)):
        return thumbnail(library_id, entry_id, w)

    @router.get("/{library_id}/assets/{entry_id}/previews/{n}/thumb")
    def preview_thumb(library_id: str, entry_id: str, n: int, w: int = Query(512, ge=1, le=1024)):
        return thumbnail(library_id, entry_id, w, n)

    return router
