"""主机进程启停记录：`.runtime/host-lifecycle.jsonl`，供在线时长与异常结束次数统计。

每次启动追加一条 start（时间、版本、是否服务模式、上次是正常停止还是异常结束），每次停止追加
一条 stop（normal / update / unresponsive）。Windows 上 `server.py stop` 用 taskkill /F 强杀，服务进程自己的
关闭钩子不会执行，所以停止记录由发起停止的一方（命令行 / 更新执行器）写；前台 Ctrl+C 等
优雅退出由服务进程自己补一条。上一条是 start 而后面没有 stop = 上次异常结束。

异常结束时不知道进程死在哪一刻：服务每 5 分钟刷新一次 `host-lifecycle.alive` 的修改时间，
下次启动把它记成 previous_last_alive_at，在线时长按它截止（误差不超过一个心跳周期）。

文件超过 1 MiB 时轮转为 `host-lifecycle.1.jsonl`，只保留这一份旧文件；一行约 250 字节，
1 MiB 约 4000 次启停。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text, read_text_with_retry
from character_workflow.lib.file_lock import file_lock

HEARTBEAT_SECONDS = 300
MAX_BYTES = 1024 * 1024

# unresponsive：常驻看护（bootstrap --service）判定无应答后结束了进程，记录里带无应答开始的时间。
StopReason = Literal["normal", "update", "unresponsive"]


def lifecycle_file(runtime: Path | None = None) -> Path:
    return (runtime or data_root.runtime_dir()) / "host-lifecycle.jsonl"


def _rotated_file(runtime: Path | None = None) -> Path:
    return (runtime or data_root.runtime_dir()) / "host-lifecycle.1.jsonl"


def alive_file(runtime: Path | None = None) -> Path:
    return (runtime or data_root.runtime_dir()) / "host-lifecycle.alive"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _read_lines(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return []
    rows = []
    for line in raw.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("event") in ("start", "stop") and isinstance(row.get("time"), str):
            rows.append(row)
    return rows


def read_events(runtime: Path | None = None) -> list[dict[str, Any]]:
    """按写入顺序返回全部可读事件（含轮转出去的旧文件）；坏行跳过。"""
    return [*_read_lines(_rotated_file(runtime)), *_read_lines(lifecycle_file(runtime))]


def _append(row: dict[str, Any], runtime: Path | None = None) -> None:
    path = lifecycle_file(runtime)
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        if path.exists() and path.stat().st_size >= MAX_BYTES:
            os.replace(path, _rotated_file(runtime))
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def heartbeat() -> None:
    # 把时间写进文件内容，和启停记录用同一个时钟。不能只 touch 用修改时间：Linux 的文件时间戳
    # 取自内核粗粒度时钟，可能比紧挨着之前读到的 Python 时间还早约 1 ms（CI 实测 3000 次里 290 次），
    # 刚启动就写的心跳会被判成「早于上次启动」而丢掉最后存活时间。
    atomic_write_text(alive_file(), _now().isoformat())


def last_alive() -> datetime | None:
    """最后一次心跳的时间。旧版本只 touch 不写内容：内容为空时退回修改时间。"""
    path = alive_file()
    try:
        text = read_text_with_retry(path).strip()
        if text:
            parsed = datetime.fromisoformat(text)
            return parsed if parsed.tzinfo is not None else None
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except (OSError, ValueError):
        return None


def _alive_at() -> str | None:
    alive = last_alive()
    return alive.isoformat() if alive is not None else None


def record_start(*, version: str, service_mode: bool, pid: int, instance_id: str | None) -> dict[str, Any]:
    events = read_events()
    last = events[-1] if events else None
    previous = "first" if last is None else "clean" if last["event"] == "stop" else "abnormal"
    last_alive = _alive_at() if previous == "abnormal" else None
    if last_alive is not None and last is not None and last_alive < last["time"]:
        last_alive = None  # 心跳早于上次启动：上次没活到第一次心跳之后，不能当截止时间
    row = {
        "event": "start", "time": _now().isoformat(), "version": version,
        "service_mode": service_mode, "pid": pid, "instance_id": instance_id,
        "previous": previous, "previous_last_alive_at": last_alive,
    }
    _append(row)
    heartbeat()
    return row


def record_stop(*, reason: StopReason, pid: int, source: Literal["cli", "server", "watchdog"],
                runtime: Path | None = None, unresponsive_since: str | None = None) -> None:
    if source == "server":
        events = read_events(runtime)
        if events and events[-1]["event"] == "stop" and events[-1].get("pid") == pid:
            return  # 发起停止的命令行已经记过（它知道是不是更新），服务端不再重复
    row = {"event": "stop", "time": _now().isoformat(), "reason": reason, "pid": pid,
           "source": source}
    if unresponsive_since is not None:
        row["unresponsive_since"] = unresponsive_since
    _append(row, runtime)
