"""团队库索引：扫描挂载目录到本机缓存。缓存可随时删除重建，绝不写进挂载目录。"""
from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.schemas import (
    TeamAssetFile,
    TeamLibraryAssetPage,
    TeamLibraryIndex,
    TeamLibraryIndexEntry,
    TeamLibraryMount,
)

RAW_SUFFIXES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
}
_CONFLICT_SUFFIX = re.compile(r"\.(mine|r\d+)$")
_THUMB_WIDTHS = (128, 256, 512)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cache_dir(library_id: str) -> Path:
    return data_root.runtime_dir() / "team-libraries" / library_id


def _index_path(library_id: str) -> Path:
    return cache_dir(library_id) / "index.json"


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _raw_id(relative_path: str) -> str:
    return "raw_" + hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:24]


def _shared_entry(root: Path, asset_dir: Path) -> TeamLibraryIndexEntry | None:
    asset_json = asset_dir / "asset.json"
    relative = asset_dir.relative_to(root).as_posix()
    try:
        asset = TeamAssetFile.model_validate_json(asset_json.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError):
        return TeamLibraryIndexEntry(
            id=asset_dir.name, kind="media", title=asset_dir.name, author=None, tags=[],
            mime_type=None, bytes=0, relative_path=relative, sha256=None,
            updated_at=_mtime_iso(asset_dir), reproducible=False, status="incomplete",
        )
    media_ok = asset.media is None or (asset_dir / asset.media.filename).is_file()
    return TeamLibraryIndexEntry(
        id=asset.asset_id, kind=asset.kind, title=asset.title, author=asset.author.display_name,
        tags=asset.tags, mime_type=asset.media.mime_type if asset.media else "text/plain",
        bytes=asset.media.bytes if asset.media else 0, relative_path=relative,
        sha256=asset.media.sha256 if asset.media else None, updated_at=asset.updated_at,
        reproducible=asset.kind == "generation", status="ready" if media_ok else "incomplete",
    )


def scan_library(mount: TeamLibraryMount) -> TeamLibraryIndex:
    root = Path(mount.mount_path)
    entries: list[TeamLibraryIndexEntry] = []
    shared_root = root / "shared"
    if shared_root.is_dir():
        author_dirs = sorted(
            p for p in shared_root.iterdir() if p.is_dir() and not p.name.startswith(".")
        )
        for author_dir in author_dirs:
            asset_dirs = sorted(
                p for p in author_dir.iterdir() if p.is_dir() and not p.name.startswith(".")
            )
            for asset_dir in asset_dirs:
                if (asset_dir / "asset.json").is_file():
                    entry = _shared_entry(root, asset_dir)
                    if entry:
                        entries.append(entry)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or _CONFLICT_SUFFIX.search(path.name):
            continue
        rel_parts = path.relative_to(root).parts
        if any(part.startswith(".") for part in rel_parts) or rel_parts[0] == "shared":
            continue
        mime = RAW_SUFFIXES.get(path.suffix.lower())
        if not mime:
            continue
        relative = path.relative_to(root).as_posix()
        entries.append(TeamLibraryIndexEntry(
            id=_raw_id(relative), kind="raw", title=path.name, author=None, tags=[], mime_type=mime,
            bytes=path.stat().st_size, relative_path=relative, sha256=None,
            updated_at=_mtime_iso(path), reproducible=False, status="ready",
        ))
    index = TeamLibraryIndex(library_id=mount.library_id, scanned_at=_now(), entries=entries)
    atomic_write_json(_index_path(mount.library_id), index.model_dump(mode="json"))
    return index


def read_index(library_id: str) -> TeamLibraryIndex | None:
    path = _index_path(library_id)
    if not path.is_file():
        return None
    try:
        return TeamLibraryIndex.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        return None


def diff_index(before: TeamLibraryIndex | None, after: TeamLibraryIndex) -> list[dict]:
    old = {e.id: e for e in (before.entries if before else [])}
    new = {e.id: e for e in after.entries}
    changes: list[dict] = []
    for entry_id, entry in new.items():
        prior = old.get(entry_id)
        if prior is None:
            change = "added"
        elif prior.updated_at != entry.updated_at or prior.status != entry.status:
            change = "updated"
        else:
            continue
        changes.append(
            {"asset_id": entry_id, "kind": entry.kind, "author": entry.author, "change": change}
        )
    for entry_id, entry in old.items():
        if entry_id not in new:
            changes.append({
                "asset_id": entry_id, "kind": entry.kind, "author": entry.author,
                "change": "removed",
            })
    return changes


def get_entry(index: TeamLibraryIndex, entry_id: str) -> TeamLibraryIndexEntry:
    for entry in index.entries:
        if entry.id == entry_id:
            return entry
    raise KeyError(entry_id)


def query_index(
    index: TeamLibraryIndex, *, kind: str | None = None, author: str | None = None,
    tag: str | None = None, q: str | None = None, cursor: str | None = None, limit: int = 200,
) -> TeamLibraryAssetPage:
    needle = (q or "").strip().lower()
    rows = [
        e for e in index.entries
        if (kind is None or e.kind == kind)
        and (author is None or e.author == author)
        and (tag is None or tag in e.tags)
        and (not needle or needle in e.title.lower() or needle in e.relative_path.lower()
             or any(needle in t.lower() for t in e.tags))
    ]
    rows.sort(key=lambda e: e.updated_at, reverse=True)
    start = 0
    if cursor:
        try:
            start = int(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("ascii"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("cursor 不合法") from None
    page = rows[start:start + limit]
    next_cursor = None
    if start + limit < len(rows):
        next_cursor = base64.urlsafe_b64encode(str(start + limit).encode("ascii")).decode("ascii")
    return TeamLibraryAssetPage(entries=page, next_cursor=next_cursor)


def entry_content_path(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> Path:
    root = Path(mount.mount_path)
    target = root / entry.relative_path
    if entry.kind != "raw":
        asset = TeamAssetFile.model_validate_json(
            (target / "asset.json").read_text(encoding="utf-8")
        )
        if asset.media is None:
            raise FileNotFoundError(entry.id)
        target = target / asset.media.filename
    resolved = target.resolve()
    if root.resolve() not in resolved.parents:
        raise FileNotFoundError(entry.id)
    if not resolved.is_file():
        raise FileNotFoundError(entry.id)
    return resolved


def thumbnail_bytes(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, width: int
) -> bytes | None:
    if not entry.mime_type or not entry.mime_type.startswith("image/"):
        return None
    snapped = next((w for w in _THUMB_WIDTHS if w >= width), _THUMB_WIDTHS[-1])
    target = cache_dir(mount.library_id) / "thumbs" / f"{entry.id}-{snapped}.webp"
    if target.is_file():
        return target.read_bytes()
    try:
        with Image.open(entry_content_path(mount, entry)) as image:
            image.thumbnail((snapped, snapped))
            buffer = BytesIO()
            mode = "RGBA" if image.mode in {"RGBA", "LA", "P"} else "RGB"
            image.convert(mode).save(buffer, "WEBP", quality=80)
    except (OSError, UnidentifiedImageError, ValueError):
        return None
    data = buffer.getvalue()
    atomic_write_bytes(target, data)
    return data
