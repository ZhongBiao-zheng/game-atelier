"""持久回收站：删除项目、对话、已付费的一轮结果时整体移进 `.runtime/trash/<trash_id>/`，30 天后清理。

布局：`<trash_id>/items/<序号>` 是原样移过来的文件或目录，`<trash_id>/manifest.json` 记原路径（数据目录相对、
POSIX 分隔符，换了数据目录也能还原）、类型、名称、删除时间、调用方的 `meta` 与事务状态。

移入、移回都是可恢复的事务：清单先于任何移动落盘，进程中途被终止时，启动恢复按清单收尾。

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
TrashKind = Literal["project", "conversation", "round", "library"]
TrashState = Literal["moving", "stored", "restoring"]
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
    # 事务状态：moving = 正在移入（清单先于任何移动落盘）；stored = 已在回收站；restoring = 正在移回。
    # 进程在 moving / restoring 中被终止时，启动恢复把它移回原处（两者的收尾都是「还原」）。
    state: TrashState = "stored"

    def expires_at(self) -> datetime:
        return _parse_time(self.deleted_at) + timedelta(days=TRASH_DAYS)

    def days_left(self, now: datetime | None = None) -> int:
        remaining = self.expires_at() - (now or datetime.now(timezone.utc))
        return max(0, math.ceil(remaining.total_seconds() / 86400))


# restore_files(after=None)：在回收站锁里把文件移回；after 在文件全部移回后、条目删除前执行（例如回写任务的
# 输出索引），抛错则文件一起移回回收站。
RestoreFiles = Callable[..., None]
RestoreHandler = Callable[[TrashEntry, RestoreFiles], None]
_RESTORE_HANDLERS: dict[str, RestoreHandler] = {}


def register_restore_handler(kind: TrashKind, handler: RestoreHandler) -> None:
    """某类条目还原时要先拿领域锁或做善后：handler(entry, restore_files) 在自己的锁里调 restore_files()。

    启动恢复也走这个 handler 把移入到一半的条目移回，所以善后必须可重复执行。"""
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


def _write_entry(entry: TrashEntry) -> None:
    atomic_write_json(_entry_dir(entry.trash_id) / _MANIFEST, entry.model_dump(mode="json"))


def move_to_trash(
    kind: TrashKind,
    label: str,
    paths: Iterable[str | Path],
    meta: dict[str, Any] | None = None,
    *,
    commit: Callable[[], None] | None = None,
) -> str:
    """把一组文件 / 目录整体移进回收站，返回 trash_id。任一步失败全部移回，不留半条。

    先落盘 moving 状态的清单再移动；`commit`（例如回写任务的输出索引）在全部移入后、标记 stored 前执行，
    抛错则一起回滚。进程中途被终止时，启动恢复按清单移回。调用方负责自己的领域锁并确认内容不在使用中。"""
    targets = [_target(path) for path in paths]
    if not targets and commit is None:
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
        meta=meta or {}, state="moving",
    )
    with file_lock(_lock_path()):
        entry_dir = trash_root() / trash_id
        items_dir = entry_dir / "items"
        items_dir.mkdir(parents=True)
        moved: list[tuple[Path, Path]] = []
        try:
            _write_entry(entry)
            for (source, _), item in zip(targets, entry.items):
                destination = items_dir / item.stored
                _rename(source, destination)
                moved.append((source, destination))
            if commit is not None:
                commit()
        except BaseException:
            # 移不回的留着 moving 清单，交给启动恢复；全部移回才删掉这一条。
            if _move_back(moved):
                shutil.rmtree(entry_dir, ignore_errors=True)
            raise
        # commit 已落盘：此后不在这里回滚文件（领域改动撤不回），标记失败就留着 moving 清单，
        # 启动恢复经还原 handler 把文件与领域状态一起移回。
        _write_entry(entry.model_copy(update={"state": "stored"}))
    return trash_id


def _move_back(moved: list[tuple[Path, Path]]) -> bool:
    """把已移动的 (原处, 新处) 逆序移回原处；有一项移不回就停下并返回 False。"""
    for source, destination in reversed(moved):
        if not (destination.exists() or destination.is_symlink()):
            continue
        try:
            _rename(destination, source)
        except OSError:
            logger.exception("trash rollback failed: %s", destination)
            return False
    return True


def list_trash() -> list[TrashEntry]:
    """回收站全部条目，新删的在前。移入 / 移回到一半的条目不列（启动时恢复），读不出清单的跳过。"""
    try:
        children = list(trash_root().iterdir())
    except FileNotFoundError:
        return []
    entries: list[TrashEntry] = []
    for child in children:
        if not _TRASH_ID.fullmatch(child.name):
            continue
        try:
            entry = _read_entry(child.name)
        except (TrashNotFound, OSError, ValidationError, ValueError):
            logger.warning("skipping unreadable trash entry: %s", child.name)
            continue
        if entry.state == "stored":
            entries.append(entry)
    return sorted(entries, key=lambda entry: entry.deleted_at, reverse=True)


def restore(trash_id: str) -> TrashEntry:
    """原样移回原路径并删掉这一条；任一原路径被占用时整条不动，抛 TrashConflict。"""
    entry = _read_entry(trash_id)
    if entry.state != "stored":
        raise TrashNotFound(trash_id)
    _run_restore(entry, resume=False)
    return entry


def _run_restore(entry: TrashEntry, *, resume: bool) -> None:
    """resume=False：用户还原 stored 条目；resume=True：启动恢复收尾 moving / restoring 条目。"""
    trash_id = entry.trash_id

    def restore_files(after: Callable[[], None] | None = None) -> None:
        with file_lock(_lock_path()):
            try:
                current = _read_entry(trash_id)
            except TrashNotFound:
                if resume:
                    return  # 别的进程已经收尾
                raise
            if (current.state != "stored") != resume:
                if resume:
                    return
                raise TrashNotFound(trash_id)
            _restore_files_locked(current, after)

    handler = _RESTORE_HANDLERS.get(entry.kind)
    if handler is None:
        restore_files()
    else:
        handler(entry, restore_files)


def _restore_files_locked(entry: TrashEntry, after: Callable[[], None] | None) -> None:
    """持回收站锁逐项移回。回收站里已没有的项视为已在原处（移入或移回到一半时被终止）。"""
    entry_dir = _entry_dir(entry.trash_id)
    plan = [(entry_dir / "items" / item.stored, _target(item.original)[0]) for item in entry.items]
    pending = [(stored, target) for stored, target in plan if stored.exists() or stored.is_symlink()]
    if any(target.exists() or target.is_symlink() for _, target in pending):
        # 不拼原路径：任务记录的原位置是 `.runtime/jobs/…` 这类内部路径。
        raise TrashConflict(f"「{entry.label}」的原位置已有同名内容，先移走或改名后再还原")
    previous = entry.state
    if previous == "stored":
        _write_entry(entry.model_copy(update={"state": "restoring"}))
    moved: list[tuple[Path, Path]] = []
    try:
        for stored, target in pending:
            target.parent.mkdir(parents=True, exist_ok=True)
            _rename(stored, target)
            moved.append((stored, target))
        if after is not None:
            after()
    except BaseException:
        if _move_back(moved) and previous == "stored":
            _write_entry(entry)
        raise
    _remove_tree(entry_dir)


def recover_interrupted() -> int:
    """把移入或移回到一半就被终止的条目移回原处，返回处理的条数。

    走各类型的还原 handler：领域锁与善后（任务输出索引、对话归属…）和正常还原一致。原处已被占用的
    转成普通条目留在回收站。"""
    _load_restore_handlers()
    try:
        children = [child for child in trash_root().iterdir() if _TRASH_ID.fullmatch(child.name)]
    except FileNotFoundError:
        return 0
    recovered = 0
    for child in children:
        try:
            entry = _read_entry(child.name)
        except (TrashNotFound, OSError, ValidationError, ValueError):
            continue
        if entry.state == "stored":
            continue
        try:
            _run_restore(entry, resume=True)
            recovered += 1
        except TrashConflict:
            _keep_visible(entry.trash_id)
            logger.warning("interrupted trash entry kept in trash: %s", child.name)
        except Exception:
            logger.exception("trash recovery failed: %s", child.name)
    return recovered


def _keep_visible(trash_id: str) -> None:
    """回不去的半成品转成普通条目，让用户在回收站里看得见、能彻底删除。"""
    with file_lock(_lock_path()):
        try:
            current = _read_entry(trash_id)
        except TrashNotFound:
            return
        if current.state != "stored":
            _write_entry(current.model_copy(update={"state": "stored"}))


def _load_restore_handlers() -> None:
    # 还原 handler 随领域模块导入注册；启动恢复可能早于这些模块被导入。
    from character_workflow.lib import canvas_packages, jobs, library, studio_agent_sessions  # noqa: F401


def purge(trash_id: str) -> None:
    """彻底删除一条，不可恢复。"""
    with file_lock(_lock_path()):
        entry_dir = _entry_dir(trash_id)
        if not entry_dir.is_dir():
            raise TrashNotFound(trash_id)
        _remove_tree(entry_dir)


def _entries_locked() -> list[tuple[Path, TrashEntry | None]]:
    """持回收站锁列条目目录：(目录, 清单)。读不出清单的给 None；移入 / 移回到一半的不列（交给恢复）。"""
    try:
        children = [child for child in trash_root().iterdir() if child.is_dir()]
    except FileNotFoundError:
        return []
    rows: list[tuple[Path, TrashEntry | None]] = []
    for child in children:
        try:
            entry = _read_entry(child.name)
        except (TrashNotFound, OSError, ValidationError, ValueError):
            rows.append((child, None))
            continue
        if entry.state == "stored":
            rows.append((child, entry))
    return rows


def _holds_nothing(entry_dir: Path) -> bool:
    try:
        return not any((entry_dir / "items").iterdir())
    except FileNotFoundError:
        return True


def purge_all() -> int:
    """清空回收站，返回删掉的条目数。没有清单却还装着文件的目录不删：无从判断原位置，删了就找不回。"""
    removed = 0
    with file_lock(_lock_path()):
        for child, entry in _entries_locked():
            if entry is None:
                if _holds_nothing(child):
                    _remove_tree(child)
                continue
            _remove_tree(child)
            removed += 1
    return removed


def purge_expired(days: int = TRASH_DAYS, now: datetime | None = None) -> int:
    """服务启动时跑一次：先恢复中断的移入 / 移回，再删掉超过保留期的条目，返回删掉的条数。

    没有清单却还装着文件的目录保留并记日志（旧版移入到一半的产物）。"""
    recover_interrupted()
    cutoff = (now or _now()) - timedelta(days=days)
    removed = 0
    with file_lock(_lock_path()):
        for child, entry in _entries_locked():
            if entry is None:
                if _holds_nothing(child):
                    _remove_tree(child)
                else:
                    logger.warning("keeping trash folder without manifest: %s", child.name)
                continue
            if _parse_time(entry.deleted_at) <= cutoff:
                _remove_tree(child)
                removed += 1
    return removed
