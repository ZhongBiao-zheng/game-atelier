"""原子写 sidecar/JSON 的统一入口。

唯一临时名 + os.replace：并发写同一目标各自独占 tmp，消除「共享死写 .tmp 被先到者
改名后，后到者 replace 撞空 → 500 / 丢写」的竞态（Skill 与 viewer-server 双进程、
或前端快速连点都可能并发命中同一 sidecar）。写失败清掉孤儿 tmp，避免唯一名累积。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

# Windows 上 os.replace 偶发 PermissionError(WinError 5/32)：Defender 正扫刚写出的
# tmp，或长驻 viewer-server / watcher 正读目标 job 文件 —— 短暂重试即可越过。不重试时这个
# 文件改名错误会顶替掉真正的失败原因（如厂商额度耗尽），落进 job.error 误导画师。
# POSIX 的 replace 原子、不命中此竞态，故仅在 nt 上重试，其它平台行为不变。
_REPLACE_ATTEMPTS = 10
_REPLACE_DELAY = 0.05
# 只有 Windows 会在替换瞬间拒绝访问；测试把它置 True 才能在 POSIX 上模拟这一刻。
_RETRY_PERMISSION_ERRORS = os.name == "nt"
# 改名的一瞬间临时文件已经没了、目标名还没出现：两样都看不到时隔这么久再看一眼。
_MISSING_CONFIRM_DELAY = 0.02


def _replace_with_retry(tmp: Path, path: Path) -> None:
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if not _RETRY_PERMISSION_ERRORS or attempt == _REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(_REPLACE_DELAY)


def _replace_in_flight(path: Path) -> bool:
    """目标名查不到时，判断是不是有一次替换正在进行：目标已经回来了，或者旁边还有本模块的临时文件。

    Windows CI 实测（2026-11-18，4 进程并发负载）：os.replace 进行中，目标名会消失 2–230 ms，
    期间目录里大多只剩 `<stem>.<hex>.tmp`；也有一瞬间两样都看不到，所以都看不到时隔 20 ms
    再看一眼。真不存在的文件只多等这 20 ms。"""
    prefix = f"{path.stem}."

    def visible() -> bool:
        if path.exists():
            return True
        try:
            return any(item.name.startswith(prefix) and item.name.endswith(".tmp")
                       for item in path.parent.iterdir())
        except OSError:
            return False

    if visible():
        return True
    time.sleep(_MISSING_CONFIRM_DELAY)
    return visible()


def read_text_with_retry(path: Path, encoding: str = "utf-8") -> str:
    """读一个会被 `os.replace` 原地替换的文件。

    Windows 上替换进行中，目标要么短暂不可读（PermissionError），要么名字短暂查不到
    （FileNotFoundError，见 `_replace_in_flight`）；两种都重试越过（实例：任务启动读 keys.json
    撞上保存供应商；任务执行线程读任务文件撞上进度回写）。POSIX 的替换是原子的，行为不变。"""
    for attempt in range(_REPLACE_ATTEMPTS):
        last = attempt == _REPLACE_ATTEMPTS - 1
        try:
            return path.read_text(encoding=encoding)
        except FileNotFoundError:
            if not _RETRY_PERMISSION_ERRORS or last or not _replace_in_flight(path):
                raise
        except PermissionError:
            if not _RETRY_PERMISSION_ERRORS or last:
                raise
        time.sleep(_REPLACE_DELAY)
    raise AssertionError("unreachable")


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        _replace_with_retry(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))
