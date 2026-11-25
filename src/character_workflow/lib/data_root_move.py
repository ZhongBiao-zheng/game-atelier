"""更换数据目录：按目标内容分流（ADR 见规格 D1）。

- 目标不存在或是空文件夹 → 复制当前数据、校验、切换指针；原目录保留不删。
- 目标已是 Atelier 数据目录（有 `.config/` 或 `canvases/`）→ 直接切换指针。
- 目标非空且不是 Atelier 数据 → 拒绝，让用户新建子文件夹。

复制在后台线程里跑，进度经 `snapshot()` 读；复制期间 `active()` 为真，服务端据此拒绝写入请求，
避免复制开始后的改动只落在旧目录里。任务记录里的产物路径是绝对路径，复制 JSON 时把旧目录前缀
换成新目录，否则新目录里的历史全部指回旧目录。
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from character_workflow.lib import data_root

ATELIER_MARKERS = (".config", "canvases")
INCOMPLETE_MARKER = ".atelier-moving"
# 不复制：运行环境（.venv 里的脚本写死了旧路径，换目录后由启动器重建）与本次服务的运行文件。
_SKIP_TOP = {".venv"}
_SKIP_RUNTIME = {"server.pid", "server.port", "server.log", "locks", "maintenance"}
_REWRITE_SUFFIXES = {".json", ".jsonl"}

Phase = Literal["idle", "copying", "verifying", "done", "failed"]


class MoveRejected(ValueError):
    """目标不能用；message 是给用户看的一句话。"""


@dataclass
class MoveState:
    phase: Phase = "idle"
    source: str | None = None
    target: str | None = None
    total_bytes: int = 0
    copied_bytes: int = 0
    total_files: int = 0
    copied_files: int = 0
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    mode: Literal["copy", "switch"] | None = None
    # 技术原文（异常类型与信息），界面收在「查看技术详情」里。
    detail: str | None = None


_lock = threading.Lock()
_state = MoveState()


def snapshot() -> dict:
    with _lock:
        return asdict(_state)


def active() -> bool:
    with _lock:
        return _state.phase in ("copying", "verifying")


def _set(**changes) -> None:
    with _lock:
        for key, value in changes.items():
            setattr(_state, key, value)


def _is_atelier_root(path: Path) -> bool:
    return any((path / name).is_dir() for name in ATELIER_MARKERS)


def classify(target: Path, current: Path) -> Literal["same", "switch", "copy"]:
    if target == current:
        return "same"
    if target.is_relative_to(current):
        raise MoveRejected("不能把数据目录放进它自己的子文件夹")
    if current.is_relative_to(target):
        raise MoveRejected("不能选择当前数据目录的上级文件夹，请新建一个子文件夹")
    if target.exists() and not target.is_dir():
        raise MoveRejected("选中的不是文件夹")
    if not target.exists():
        return "copy"
    if (target / INCOMPLETE_MARKER).exists():
        raise MoveRejected("这个文件夹里有一次没完成的迁移，请清空后再选")
    if _is_atelier_root(target):
        return "switch"
    if any(target.iterdir()):
        raise MoveRejected("这个文件夹不是空的，请在里面新建一个子文件夹再选")
    return "copy"


def _skipped(relative: Path) -> bool:
    parts = relative.parts
    if not parts:
        return False
    head = parts[0].casefold()
    if head in _SKIP_TOP:
        return True
    return head == ".runtime" and len(parts) > 1 and parts[1].casefold() in _SKIP_RUNTIME


def _plan(source: Path) -> tuple[list[Path], list[Path], int]:
    """→ (目录, 文件或链接, 总字节)；路径均相对 source。"""
    dirs: list[Path] = []
    files: list[Path] = []
    total = 0
    for current, dirnames, filenames in os.walk(source):
        base = Path(current)
        relative_base = base.relative_to(source)
        kept = []
        for name in dirnames:
            relative = relative_base / name
            if _skipped(relative):
                continue
            if (base / name).is_symlink():
                files.append(relative)  # 目录链接按链接本身复制，不跟进去
                continue
            dirs.append(relative)
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            relative = relative_base / name
            if _skipped(relative):
                continue
            files.append(relative)
            path = base / name
            if not path.is_symlink():
                total += path.stat().st_size
    return dirs, files, total


def _prefix_forms(path: Path) -> list[str]:
    raw = str(path)
    forms = [raw, json.dumps(raw)[1:-1]]
    if os.sep == "\\":
        forms.append(path.as_posix())
    return list(dict.fromkeys(forms))


def _rewriter(source: Path, target: Path):
    pairs = [
        (re.compile(re.escape(old) + r'(?=$|[\\/"])'), new)
        for old, new in zip(_prefix_forms(source), _prefix_forms(target))
    ]

    def rewrite(text: str) -> str:
        for pattern, new in pairs:
            text = pattern.sub(lambda _match, value=new: value, text)
        return text

    return rewrite


def _copy_file(src: Path, dst: Path, rewrite) -> bool:
    """复制一个文件；JSON 里出现旧目录前缀时改写。返回是否改写过。"""
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
        return False
    if src.suffix.casefold() in _REWRITE_SUFFIXES:
        try:
            text = src.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = None
        if text is not None:
            changed = rewrite(text)
            if changed != text:
                dst.write_text(changed, encoding="utf-8", newline="")
                shutil.copystat(src, dst)
                return True
    shutil.copy2(src, dst)
    return False


def _verify(source: Path, target: Path, files: list[Path], rewritten: set[Path]) -> None:
    for relative in files:
        src, dst = source / relative, target / relative
        if src.is_symlink():
            if not dst.is_symlink():
                raise OSError(f"缺少链接 {relative}")
            continue
        if not dst.is_file():
            raise OSError(f"缺少文件 {relative}")
        if relative in rewritten:
            if relative.suffix.casefold() == ".json":
                json.loads(dst.read_text(encoding="utf-8"))
            continue
        if src.stat().st_size != dst.stat().st_size:
            raise OSError(f"文件大小不一致 {relative}")


def _cleanup(target: Path, created: bool) -> None:
    if created:
        shutil.rmtree(target, ignore_errors=True)
        return
    for child in target.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def switch_to(target: Path) -> None:
    """切换指针：写全局配置，并让本进程（及其子进程）立刻用新目录。"""
    data_root.write_global_config(target)
    os.environ["GAME_ATELIER_DATA_ROOT"] = str(target)


def _copy(source: Path, target: Path, created: bool, on_switched) -> None:
    try:
        dirs, files, total = _plan(source)
        _set(total_bytes=total, total_files=len(files))
        target.mkdir(parents=True, exist_ok=True)
        (target / INCOMPLETE_MARKER).write_text("", encoding="utf-8")
        for relative in dirs:
            (target / relative).mkdir(parents=True, exist_ok=True)
        rewrite = _rewriter(source, target)
        rewritten: set[Path] = set()
        copied = 0
        for index, relative in enumerate(files, start=1):
            src = source / relative
            (target / relative).parent.mkdir(parents=True, exist_ok=True)
            if _copy_file(src, target / relative, rewrite):
                rewritten.add(relative)
            if not src.is_symlink():
                copied += src.stat().st_size
            _set(copied_bytes=copied, copied_files=index)
        _set(phase="verifying")
        _verify(source, target, files, rewritten)
        (target / INCOMPLETE_MARKER).unlink(missing_ok=True)
        switch_to(target)
    except Exception as error:  # noqa: BLE001 — 任何失败都要清掉半成品并报给界面
        _cleanup(target, created)
        reason = "目标磁盘空间不足" if isinstance(error, OSError) and error.errno == 28 else (
            "没有写入目标文件夹的权限" if isinstance(error, PermissionError) else "复制数据时出错")
        _set(phase="failed", error=reason, finished_at=time.time(),
             detail=f"{type(error).__name__}: {error}")
        return
    # 已切换：之后的善后（重建文件监听等）失败不能再回滚新目录。
    _set(phase="done", finished_at=time.time())
    try:
        on_switched()
    except Exception:  # noqa: BLE001
        logging.getLogger(__name__).exception("data root switched, follow-up failed")


def start(target_text: str, on_switched=lambda: None) -> dict:
    """开始更换；直接切换的情形同步完成。调用方负责先确认没有进行中的生成。"""
    global _state
    current = data_root.resolve_data_root().resolve()
    target = Path(target_text).expanduser().resolve()
    mode = classify(target, current)
    if mode == "same":
        return snapshot()
    now = time.time()
    created = not target.exists()
    with _lock:
        if _state.phase in ("copying", "verifying"):
            raise MoveRejected("正在迁移数据目录，请等它完成")
        _state = MoveState(
            phase="copying" if mode == "copy" else "done", source=str(current), target=str(target),
            mode=mode, started_at=now, finished_at=None if mode == "copy" else now,
        )
    if mode == "switch":
        switch_to(target)
        on_switched()
        return snapshot()
    threading.Thread(
        target=_copy, args=(current, target, created, on_switched),
        name="data-root-move", daemon=True,
    ).start()
    return snapshot()
