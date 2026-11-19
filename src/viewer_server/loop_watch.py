"""事件循环卡顿监测（第 4 批 4-2）。

每个被监测的事件循环里跑一个打点协程（每 0.5 秒醒一次，记下最近一次醒来的时间）；另有一个独立的
看守线程每秒检查一遍。事件循环卡住时打点协程醒不来，但看守线程不受影响：

- 卡住超过 `dump_after`（默认 30 秒）：把所有线程的栈写进 server.log，同一次卡顿只写一次；恢复后记一条
  「已恢复，卡了多久」。常驻看护（bootstrap --service）约 2 分钟无应答才结束进程，栈会先落盘，
  进程被结束后仍能查到当时卡在哪。
- `warn_after`（网关用 0.2 秒）：打点协程醒来时发现比预期晚了这么多，记一条延迟告警（限频，见 timed_lock）。

栈里只有文件、行号、函数名和源码行，不带变量值。
"""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback

from character_workflow.lib.timed_lock import Throttle

TICK_SECONDS = 0.5
DUMP_AFTER_SECONDS = 30.0
_CHECK_SECONDS = 1.0

logger = logging.getLogger(__name__)


class LoopWatch:
    def __init__(self, name: str, *, dump_after: float = DUMP_AFTER_SECONDS,
                 warn_after: float | None = None, tick: float = TICK_SECONDS) -> None:
        self.name = name
        self.dump_after = dump_after
        self.warn_after = warn_after
        self.tick = tick
        self.last_tick = time.monotonic()
        self.dumped_at: float | None = None  # 这次卡顿已经写过栈（卡顿开始的时间）
        self._throttle = Throttle()

    async def run(self) -> None:
        _register(self)
        try:
            while True:
                expected = time.monotonic() + self.tick
                await asyncio.sleep(self.tick)
                now = time.monotonic()
                self._ticked(now, now - expected)
        finally:
            _unregister(self)

    def _ticked(self, now: float, lag: float) -> None:
        stalled_since, self.last_tick = self.last_tick, now
        if self.dumped_at is not None:
            logger.warning("事件循环已恢复 loop=%s 卡住=%.1fs", self.name, now - stalled_since)
            self.dumped_at = None
        if self.warn_after is not None and lag > self.warn_after:
            log, suppressed, worst = self._throttle.pass_through(lag)
            if log:
                extra = f"（此前 10 秒内另有 {suppressed} 次，最长 {worst:.2f}s）" if suppressed else ""
                logger.warning("事件循环延迟 loop=%s 延迟=%.2fs%s", self.name, lag, extra)

    def check(self, now: float) -> None:
        """看守线程调用：卡住超过阈值且这次还没写过栈就写一次。"""
        stalled = now - self.last_tick
        if stalled < self.dump_after or self.dumped_at is not None:
            return
        self.dumped_at = self.last_tick
        logger.error("事件循环卡住 loop=%s 已卡=%.1fs，所有线程的栈：\n%s",
                     self.name, stalled, thread_stacks())


def thread_stacks() -> str:
    names = {thread.ident: thread.name for thread in threading.enumerate()}
    parts = []
    for ident, frame in sys._current_frames().items():
        parts.append(f"--- 线程 {names.get(ident, '?')} ({ident})\n"
                     + "".join(traceback.format_stack(frame)))
    return "\n".join(parts)


_watches: set[LoopWatch] = set()
_watches_lock = threading.Lock()
_watcher: threading.Thread | None = None


def _register(watch: LoopWatch) -> None:
    global _watcher
    with _watches_lock:
        _watches.add(watch)
        if _watcher is None or not _watcher.is_alive():
            _watcher = threading.Thread(target=_watch_loop, daemon=True, name="loop-watch")
            _watcher.start()


def _unregister(watch: LoopWatch) -> None:
    with _watches_lock:
        _watches.discard(watch)


def _watch_loop() -> None:
    while True:
        time.sleep(_CHECK_SECONDS)
        with _watches_lock:
            watches = list(_watches)
        now = time.monotonic()
        for watch in watches:
            try:
                watch.check(now)
            except Exception:  # noqa: BLE001 — 看守线程不能因为一次写日志失败退出
                pass


def start(name: str, **options) -> asyncio.Task:
    """在当前事件循环里开始监测；返回的任务在关停时取消。"""
    return asyncio.get_running_loop().create_task(LoopWatch(name, **options).run(),
                                                  name=f"loop-watch-{name}")
