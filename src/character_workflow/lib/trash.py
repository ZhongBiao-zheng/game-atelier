"""持久回收站：删除项目、对话、已付费的一轮结果时整体移进 `.runtime/trash/<trash_id>/`，30 天后清理。

布局：`<trash_id>/items/<序号>` 是原样移过来的文件或目录，`<trash_id>/manifest.json` 记原路径（数据目录相对、
POSIX 分隔符，换了数据目录也能还原）、类型、名称、删除时间与调用方的 `meta`。

锁顺序：调用方的领域锁（项目锁、任务锁…）在外，回收站锁在内。`move_to_trash` 由调用方在自己的锁里调；
还原需要领域锁或善后的类型用 `register_restore_handler` 包住真正的移回动作。回收站锁放在
`.runtime/locks/`，不放在被整体移动的目录里（Windows 不许改名内部有打开句柄的目录）。
"""
from __future__ import annotations

import errno
import logging
import math
import os
import re
import secrets
import shutil
import time
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.file_lock import file_lock

logger = logging.getLogger(__name__)

TRASH_DAYS = 30
# project = 画布项目；conversation = 创作台 / 画布 Agent 对话；round = 已付费的一轮结果。
TrashKind = Literal["project", "conversation", "round"]
TRASH_ID_PATTERN = r"^trash-[0-9]{14}-[0-9a-f]{8}$"
_TRASH_ID = re.compile(TRASH_ID_PATTERN)
_MANIFEST = "manifest.json"
# Windows 上改名偶发瞬时拒访（Defender / 索引器正扫刚动过的文件），短暂重试即可越过；POSIX 不重试。
_RENAME_ATTEMPTS = 10
_RENAME_DELAY = 0.05
_RETRY_PERMISSION_ERRORS = os.name == "nt"


class TrashError(ValueError):
    """请求本身不合规（路径越界、受保护目录、找不到要删的内容）。"""


class TrashNotFound(LookupError):
    """回收站里没有这一条（已还原、已彻底删除或已过期清理）。"""


class TrashConflict(RuntimeError):
    """原位置已被占用，不能还原。"""


class TrashItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original: str
    stored: str = Field(pattern=r"^[0-9]+$")


class TrashEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trash_id: str = Field(pattern=TRASH_ID_PATTERN)
    kind: TrashKind
    label: str
    deleted_at: str
    items: list[TrashItem]
    meta: dict[str, Any] = Field(default_factory=dict)

    def expires_at(self) -> datetime:
        return _parse_time(self.deleted_at) + timedelta(days=TRASH_DAYS)

    def days_left(self, now: datetime | None = None) -> int:
        remaining = self.expires_at() - (now or datetime.now(timezone.utc))
        return max(0, math.ceil(remaining.total_seconds() / 86400))


RestoreHandler = Callable[[TrashEntry, Callable[[], None]], None]
_RESTORE_HANDLERS: dict[str, RestoreHandler] = {}


def register_restore_handler(kind: TrashKind, handler: RestoreHandler) -> None:
    """某类条目还原时要先拿领域锁或做善后：handler(entry, restore_files) 在自己的锁里调 restore_files()。"""
    _RESTORE_HANDLERS[kind] = handler


def trash_root() -> Path:
    return data_root.runtime_dir() / "trash"


def _lock_path() -> Path:
    return data_root.runtime_dir() / "locks" / "trash.lock"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _folded(parts: Iterable[str]) -> list[str]:
    # macOS / Windows 默认大小写不敏感，resolve() 不规范化大小写；Windows 还吞掉尾随点与空格。
    return [part.casefold().rstrip(". ") for part in parts]


def _target(value: str | Path) -> tuple[Path, str]:
    """数据目录内的一个可移动路径 → (绝对路径, 数据目录相对的 POSIX 路径)。

    只解析父目录、保留末段：符号链接本身被移走，不追到链接目标。数据目录本身、`.config/`、`.runtime/`
    顶层、回收站与锁目录不能移。"""
    text = str(value)
    if not text or "\x00" in text:
        raise TrashError("路径无效")
    root = data_root.resolve_data_root().resolve()
    raw = Path(text)
    candidate = raw if raw.is_absolute() else root / raw
    if candidate.name in {"", ".", ".."}:
        raise TrashError("路径无效")
    try:
        target = candidate.parent.resolve() / candidate.name
        relative = target.relative_to(root)
    except (OSError, RuntimeError) as error:
        raise TrashError("路径无效") from error
    except ValueError as error:
        raise TrashError("只能删除数据目录内的内容") from error
    parts = _folded(relative.parts)
    if not parts or parts[0] == ".config" or parts == [".runtime"] or (
        parts[0] == ".runtime" and parts[1] in {"trash", "locks"}
    ):
        raise TrashError("受保护的目录不能移进回收站")
    return target, relative.as_posix()


def _rename(source: Path, destination: Path) -> None:
    for attempt in range(_RENAME_ATTEMPTS):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if not _RETRY_PERMISSION_ERRORS or attempt == _RENAME_ATTEMPTS - 1:
                raise
            time.sleep(_RENAME_DELAY)
        except OSError as error:
            # 数据目录里的子目录是挂到另一块盘的链接时，改名跨设备，退回复制 + 删除。
            if error.errno != errno.EXDEV:
                raise
            shutil.move(str(source), str(destination))
            return


def _remove_tree(path: Path) -> None:
    for attempt in range(_RENAME_ATTEMPTS):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if not _RETRY_PERMISSION_ERRORS or attempt == _RENAME_ATTEMPTS - 1:
                raise
            time.sleep(_RENAME_DELAY)


def _new_trash_id() -> str:
    return f"trash-{_now().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(4)}"


def _entry_dir(trash_id: str) -> Path:
    if not _TRASH_ID.fullmatch(trash_id):
        raise TrashNotFound(trash_id)
    return trash_root() / trash_id


def _read_entry(trash_id: str) -> TrashEntry:
    path = _entry_dir(trash_id) / _MANIFEST
    try:
        entry = TrashEntry.model_validate_json(read_text_with_retry(path))
    except FileNotFoundError as error:
        raise TrashNotFound(trash_id) from error
    if entry.trash_id != trash_id:
        raise TrashNotFound(trash_id)
    return entry


def move_to_trash(
    kind: TrashKind,
    label: str,
    paths: Iterable[str | Path],
    meta: dict[str, Any] | None = None,
) -> str:
    """把一组文件 / 目录整体移进回收站，返回 trash_id。任一步失败全部移回，不留半条。

    调用方负责自己的领域锁（例如项目锁、任务锁）并确认内容不在使用中。"""
    targets = [_target(path) for path in paths]
    if not targets:
        raise TrashError("没有要删除的内容")
    keys = [relative.casefold() for _, relative in targets]
    for index, key in enumerate(keys):
        if any(other == key or key.startswith(f"{other}/") for other in keys[:index] + keys[index + 1:]):
            raise TrashError("要删除的路径重复或互相包含")
    missing = [relative for target, relative in targets if not target.exists() and not target.is_symlink()]
    if missing:
        raise TrashError(f"找不到要删除的内容：{missing[0]}")
    trash_id = _new_trash_id()
    entry = TrashEntry(
        trash_id=trash_id, kind=kind, label=label.strip() or "未命名", deleted_at=_now().isoformat(),
        items=[TrashItem(original=relative, stored=str(index)) for index, (_, relative) in enumerate(targets)],
        meta=meta or {},
    )
    with file_lock(_lock_path()):
        entry_dir = trash_root() / trash_id
        items_dir = entry_dir / "items"
        items_dir.mkdir(parents=True)
        moved: list[tuple[Path, Path]] = []
        try:
            for (source, _), item in zip(targets, entry.items):
                destination = items_dir / item.stored
                _rename(source, destination)
                moved.append((source, destination))
            atomic_write_json(entry_dir / _MANIFEST, entry.model_dump(mode="json"))
        except BaseException:
            for source, destination in reversed(moved):
                if destination.exists() or destination.is_symlink():
                    _rename(destination, source)
            shutil.rmtree(entry_dir, ignore_errors=True)
            raise
    return trash_id


def list_trash() -> list[TrashEntry]:
    """回收站全部条目，新删的在前。读不出清单的条目跳过（启动时按目录时间过期清理）。"""
    try:
        children = list(trash_root().iterdir())
    except FileNotFoundError:
        return []
    entries: list[TrashEntry] = []
    for child in children:
        if not _TRASH_ID.fullmatch(child.name):
            continue
        try:
            entries.append(_read_entry(child.name))
        except (TrashNotFound, OSError, ValidationError, ValueError):
            logger.warning("skipping unreadable trash entry: %s", child.name)
    return sorted(entries, key=lambda entry: entry.deleted_at, reverse=True)


def restore(trash_id: str) -> TrashEntry:
    """原样移回原路径并删掉这一条；任一原路径被占用时整条不动，抛 TrashConflict。"""
    entry = _read_entry(trash_id)

    def restore_files() -> None:
        with file_lock(_lock_path()):
            current = _read_entry(trash_id)
            entry_dir = _entry_dir(trash_id)
            plan = [(entry_dir / "items" / item.stored, _target(item.original)[0], item.original)
                    for item in current.items]
            occupied = [original for _, target, original in plan if target.exists() or target.is_symlink()]
            if occupied:
                raise TrashConflict(f"原位置已有同名内容（{occupied[0]}），先移走或改名后再还原")
            moved: list[tuple[Path, Path]] = []
            try:
                for stored, target, _ in plan:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _rename(stored, target)
                    moved.append((stored, target))
            except BaseException:
                for stored, target in reversed(moved):
                    if target.exists() or target.is_symlink():
                        _rename(target, stored)
                raise
            _remove_tree(entry_dir)

    handler = _RESTORE_HANDLERS.get(entry.kind)
    if handler is None:
        restore_files()
    else:
        handler(entry, restore_files)
    return entry


def purge(trash_id: str) -> None:
    """彻底删除一条，不可恢复。"""
    with file_lock(_lock_path()):
        entry_dir = _entry_dir(trash_id)
        if not entry_dir.is_dir():
            raise TrashNotFound(trash_id)
        _remove_tree(entry_dir)


def purge_all() -> int:
    """清空回收站，返回删掉的条目数。"""
    with file_lock(_lock_path()):
        try:
            children = [child for child in trash_root().iterdir() if child.is_dir()]
        except FileNotFoundError:
            return 0
        for child in children:
            _remove_tree(child)
        return len(children)


def purge_expired(days: int = TRASH_DAYS, now: datetime | None = None) -> int:
    """删掉超过保留期的条目（服务启动时跑一次）。读不出清单的条目按目录修改时间算。"""
    cutoff = (now or _now()) - timedelta(days=days)
    removed = 0
    with file_lock(_lock_path()):
        try:
            children = [child for child in trash_root().iterdir() if child.is_dir()]
        except FileNotFoundError:
            return 0
        for child in children:
            try:
                deleted_at = _parse_time(_read_entry(child.name).deleted_at)
            except (TrashNotFound, OSError, ValidationError, ValueError):
                deleted_at = datetime.fromtimestamp(child.stat().st_mtime, timezone.utc)
            if deleted_at <= cutoff:
                _remove_tree(child)
                removed += 1
    return removed
