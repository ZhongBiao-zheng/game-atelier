"""团队库索引：扫描挂载目录到本机缓存。缓存可随时删除重建，绝不写进挂载目录。"""
from __future__ import annotations

import base64
import hashlib
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePath

from PIL import Image, ImageOps, UnidentifiedImageError
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
_QUERY_LIMIT_RANGE = (1, 500)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cache_dir(library_id: str) -> Path:
    return data_root.runtime_dir() / "team-libraries" / library_id


def _index_path(library_id: str) -> Path:
    return cache_dir(library_id) / "index.json"


def parse_instant(value: str) -> datetime | None:
    """团队侧时间戳可能是 Z / +00:00 / +08:00：按时刻比，不按字符串比。无时区当 UTC。"""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


_EARLIEST = datetime.min.replace(tzinfo=timezone.utc)


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def raw_entry_id(relative_path: str) -> str:
    """原始文件的条目 id 只由库内相对路径得来：改名即新资产。"""
    # 活工作副本里可能有非 UTF-8 文件名（os.walk 以 surrogateescape 解出），不能让哈希在此炸掉。
    return "raw_" + hashlib.sha1(relative_path.encode("utf-8", "surrogateescape")).hexdigest()[:24]


def _escapes_root(path: Path, root_resolved: Path) -> bool:
    """库内指向库外的 symlink：不属于这个库，扫描与读取都不认。"""
    try:
        if not path.is_symlink():
            return False
        return not path.resolve().is_relative_to(root_resolved)
    except OSError:
        return True


def _incomplete_entry(asset_dir: Path, relative: str) -> TeamLibraryIndexEntry:
    try:
        updated_at = _mtime_iso(asset_dir)
    except OSError:
        updated_at = _now()
    return TeamLibraryIndexEntry(
        id=asset_dir.name, kind="media", title=asset_dir.name, author=None, tags=[],
        mime_type=None, bytes=0, relative_path=relative, sha256=None,
        updated_at=updated_at, reproducible=False, status="incomplete",
    )


def _needs_resolve(asset_dir: Path, relative: str, plain_dirs: set[str]) -> bool:
    """字面在目录内且沿途没有 symlink 的路径不必 resolve；已确认不是 symlink 的中间目录记进 plain_dirs。"""
    pure = PurePath(relative)
    if pure.anchor or not pure.parts or ".." in pure.parts:
        return True
    current = asset_dir
    for depth, part in enumerate(pure.parts):
        current = current / part
        is_last = depth == len(pure.parts) - 1
        key = "/".join(pure.parts[:depth + 1])
        if not is_last and key in plain_dirs:
            continue
        if current.is_symlink():
            return True
        if not is_last:
            plain_dirs.add(key)
    return False


def _inside_file(asset_dir: Path, relative: str, plain_dirs: set[str]) -> Path | None:
    target = asset_dir / relative
    try:
        if _needs_resolve(asset_dir, relative, plain_dirs):
            resolved = target.resolve()
            resolved.relative_to(asset_dir.resolve())
            target = resolved
        return target if target.is_file() else None
    except (OSError, ValueError):
        return None


def asset_dir_file(asset_dir: Path, relative: str) -> Path | None:
    """资产目录内的文件：必须真在资产目录里（挡 ../ 与指向外面的 symlink），否则 None。"""
    return _inside_file(asset_dir, relative, set())


def shared_asset_dir(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> Path:
    """分享资产的目录（已 resolve，且在库根之内）；不在 → FileNotFoundError。"""
    try:
        root = Path(mount.mount_path).resolve()
        asset_dir = (root / entry.relative_path).resolve()
        if root not in asset_dir.parents or not asset_dir.is_dir():
            raise FileNotFoundError(entry.id)
    except OSError as error:
        raise FileNotFoundError(entry.id) from error
    return asset_dir


def _asset_files_present(asset_dir: Path, asset: TeamAssetFile) -> bool:
    """成片与每份参考都在：SVN 还没同步完的资产标 incomplete，不让人点采用再失败。"""
    names = [asset.media.filename] if asset.media else []
    if asset.snapshot is not None:
        names.extend(row.path for row in asset.snapshot.inputs)
    plain_dirs: set[str] = set()
    return all(_inside_file(asset_dir, name, plain_dirs) is not None for name in names)


def _shared_entry(root: Path, asset_dir: Path) -> TeamLibraryIndexEntry:
    relative = asset_dir.relative_to(root).as_posix()
    try:
        asset = TeamAssetFile.model_validate_json(
            (asset_dir / "asset.json").read_text(encoding="utf-8")
        )
    except (OSError, ValidationError, ValueError):
        return _incomplete_entry(asset_dir, relative)
    if asset.asset_id != asset_dir.name:
        # 目录名就是资产 id：对不上说明是手工拷贝 / 改名，采用与撤回都会找错目录。
        return _incomplete_entry(asset_dir, relative)
    snapshot = asset.snapshot
    return TeamLibraryIndexEntry(
        id=asset.asset_id, kind=asset.kind, title=asset.title, author=asset.author.display_name,
        tags=asset.tags, mime_type=asset.media.mime_type if asset.media else "text/plain",
        bytes=asset.media.bytes if asset.media else 0, relative_path=relative,
        sha256=asset.media.sha256 if asset.media else None, updated_at=asset.updated_at,
        reproducible=asset.kind == "generation",
        status="ready" if _asset_files_present(asset_dir, asset) else "incomplete",
        model=snapshot.model if snapshot else None,
        cost_cny=snapshot.cost_cny if snapshot else None,
        input_sha256=(
            [row.sha256 for row in sorted(snapshot.inputs, key=lambda row: row.order)]
            if snapshot and asset.kind == "generation" else []
        ),
    )


def _child_dirs(parent: Path, root_resolved: Path) -> list[Path]:
    """可见子目录；指向库外的 symlink 目录不属于这个库，剪掉。"""
    return sorted(
        p for p in parent.iterdir()
        if not p.name.startswith(".") and p.is_dir() and not _escapes_root(p, root_resolved)
    )


def _scan_shared(root: Path) -> list[TeamLibraryIndexEntry]:
    shared_root = root / "shared"
    entries: list[TeamLibraryIndexEntry] = []
    try:
        root_resolved = root.resolve()
        if not shared_root.is_dir() or _escapes_root(shared_root, root_resolved):
            return entries
        author_dirs = _child_dirs(shared_root, root_resolved)
    except OSError:
        return entries
    for author_dir in author_dirs:
        try:
            asset_dirs = _child_dirs(author_dir, root_resolved)
        except OSError:
            continue
        for asset_dir in asset_dirs:
            try:
                has_manifest = (asset_dir / "asset.json").is_file()
            except OSError:
                continue
            if has_manifest:
                entries.append(_shared_entry(root, asset_dir))
    return entries


def _scan_raw(root: Path) -> list[TeamLibraryIndexEntry]:
    root_resolved = root.resolve()
    entries: list[TeamLibraryIndexEntry] = []
    # os.walk + 就地剪枝：不下潜 .svn / .git 等隐藏目录（rglob 会把整棵工作副本元数据走一遍）。
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        rel_dir = current.relative_to(root)
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        if rel_dir.parts and rel_dir.parts[0] == "shared":
            dirnames[:] = []
            continue
        if not rel_dir.parts:
            dirnames[:] = [d for d in dirnames if d != "shared"]
        for filename in sorted(filenames):
            if filename.startswith(".") or _CONFLICT_SUFFIX.search(filename):
                continue
            path = current / filename
            mime = RAW_SUFFIXES.get(path.suffix.lower())
            if not mime:
                continue
            if _escapes_root(path, root_resolved):
                continue
            # 活工作副本会在扫描期间被 SVN 改写：单个文件消失不该让整次扫描失败。
            try:
                if not path.is_file():
                    continue
                stat_result = path.stat()
            except OSError:
                continue
            relative = path.relative_to(root).as_posix()
            entries.append(TeamLibraryIndexEntry(
                id=raw_entry_id(relative), kind="raw", title=path.name, author=None, tags=[],
                mime_type=mime, bytes=stat_result.st_size, relative_path=relative, sha256=None,
                updated_at=datetime.fromtimestamp(
                    stat_result.st_mtime, tz=timezone.utc
                ).isoformat(),
                reproducible=False, status="ready",
            ))
    return entries


def scan_library(mount: TeamLibraryMount) -> TeamLibraryIndex:
    root = Path(mount.mount_path)
    entries = [*_scan_shared(root), *_scan_raw(root)]
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


def _change(entry: TeamLibraryIndexEntry, change: str) -> dict:
    """TeamLibraryChangeEvent 除 library_id 外的字段；removed 不带 title / status / mime_type。"""
    present = change != "removed"
    return {
        "asset_id": entry.id, "kind": entry.kind, "author": entry.author, "change": change,
        "title": entry.title if present else None,
        "status": entry.status if present else None,
        "mime_type": entry.mime_type if present else None,
    }


def diff_index(before: TeamLibraryIndex | None, after: TeamLibraryIndex) -> list[dict]:
    """两次扫描之间的变化。没有上一份索引（首扫 / 缓存丢了）→ 不产生事件：
    那时整库都会算成 added，逐条广播就是给每条老资产弹一次提醒。"""
    if before is None:
        return []
    old = {e.id: e for e in before.entries}
    new = {e.id: e for e in after.entries}
    changes: list[dict] = []
    for entry_id, entry in new.items():
        prior = old.get(entry_id)
        if prior is None:
            changes.append(_change(entry, "added"))
        elif (
            prior.updated_at != entry.updated_at
            or prior.status != entry.status
            or prior.bytes != entry.bytes
        ):
            changes.append(_change(entry, "updated"))
    changes.extend(
        _change(entry, "removed") for entry_id, entry in old.items() if entry_id not in new
    )
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
    low, high = _QUERY_LIMIT_RANGE
    limit = max(low, min(high, limit))
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
        if start < 0:
            raise ValueError("cursor 不合法")
    page = rows[start:start + limit]
    next_cursor = None
    if start + limit < len(rows):
        next_cursor = base64.urlsafe_b64encode(str(start + limit).encode("ascii")).decode("ascii")
    return TeamLibraryAssetPage(entries=page, next_cursor=next_cursor)


def related_entries(index: TeamLibraryIndex, *, limit: int = 20) -> list[TeamLibraryIndexEntry]:
    """团队栏「相关配方」：可复刻（generation 且 ready）的条目，最近更新的在前。"""
    rows = [e for e in index.entries if e.kind == "generation" and e.status == "ready"]
    rows.sort(key=lambda e: parse_instant(e.updated_at) or _EARLIEST, reverse=True)
    return rows[:max(0, limit)]


def related_by_input_sha(
    index: TeamLibraryIndex, sha256: str, *, limit: int = 20
) -> list[TeamLibraryIndexEntry]:
    """推荐 a：参考里用过这份内容（按 sha256）的可复刻配方，最近更新的在前。"""
    rows = [e for e in related_entries(index, limit=len(index.entries)) if sha256 in e.input_sha256]
    return rows[:max(0, limit)]


def _raw_content_path(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> Path:
    root_resolved = Path(mount.mount_path).resolve()
    resolved = (Path(mount.mount_path) / entry.relative_path).resolve()
    if root_resolved not in resolved.parents or not resolved.is_file():
        raise FileNotFoundError(entry.id)
    return resolved


def entry_content_path(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> Path:
    """条目的媒体本体。未同步完整的条目不给读；分享资产的文件必须在它自己的资产目录里。"""
    if entry.status != "ready":
        raise FileNotFoundError(entry.id)
    if entry.kind == "raw":
        return _raw_content_path(mount, entry)
    asset_dir = shared_asset_dir(mount, entry)
    manifest = asset_dir_file(asset_dir, "asset.json")
    if manifest is None:
        raise FileNotFoundError(entry.id)
    try:
        asset = TeamAssetFile.model_validate_json(manifest.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as error:
        raise FileNotFoundError(entry.id) from error
    target = asset_dir_file(asset_dir, asset.media.filename) if asset.media else None
    if target is None:
        raise FileNotFoundError(entry.id)
    return target


def _thumb_path(library_id: str, entry: TeamLibraryIndexEntry, width: int) -> Path:
    # 内容版本进缓存键：SVN 覆盖同名文件后 updated_at 变化，旧缩略图不再命中。
    version = hashlib.sha1(entry.updated_at.encode("utf-8")).hexdigest()[:10]
    return cache_dir(library_id) / "thumbs" / f"{entry.id}-{width}-{version}.webp"


def thumbnail_bytes(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, width: int
) -> bytes | None:
    if not entry.mime_type or not entry.mime_type.startswith("image/"):
        return None
    snapped = next((w for w in _THUMB_WIDTHS if w >= width), _THUMB_WIDTHS[-1])
    target = _thumb_path(mount.library_id, entry, snapped)
    try:
        if target.is_file():
            return target.read_bytes()
    except OSError:
        return None
    try:
        with Image.open(entry_content_path(mount, entry)) as opened:
            image = ImageOps.exif_transpose(opened) or opened
            image.thumbnail((snapped, snapped))
            buffer = BytesIO()
            mode = "RGBA" if image.mode in {"RGBA", "LA", "P"} else "RGB"
            image.convert(mode).save(buffer, "WEBP", quality=80)
    # DecompressionBombError 直接继承 Exception，不在 OSError 之下：漏抓就是路由层 500。
    except (OSError, UnidentifiedImageError, ValueError, Image.DecompressionBombError):
        return None
    data = buffer.getvalue()
    atomic_write_bytes(target, data)
    return data
