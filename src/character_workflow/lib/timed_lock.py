"""持有时间可观测的锁与限频告警（第 4 批 4-2 的测量）。

`TimedLock` 是可重入锁（与 `threading.RLock` 用法相同：`with`、`acquire` / `release`），最外层持有超过阈值时记一条
WARNING：锁名、持有秒数、拿锁的调用点（文件名:行号）。日志只有这些，不带参数与数据。
同一把锁的告警每 10 秒最多一条，期间被压下的条数与最长时长并进下一条。
"""
from __future__ import annotations

import logging
import sys
import threading
import time
from pathlib import Path


class Throttle:
    """同一类告警每 `interval` 秒最多记一条；压下的条数和最大值并进下一条。"""

    def __init__(self, interval: float = 10.0) -> None:
        self.interval = interval
        self._lock = threading.Lock()
        self._last = float("-inf")
        self._suppressed = 0
        self._worst = 0.0

    def pass_through(self, value: float) -> tuple[bool, int, float]:
        """返回（这次是否记、之前压下几条、压下期间连同这次的最大值）。"""
        now = time.monotonic()
        with self._lock:
            self._worst = max(self._worst, value)
            if now - self._last < self.interval:
                self._suppressed += 1
                return False, 0, 0.0
            suppressed, worst = self._suppressed, self._worst
            self._last, self._suppressed, self._worst = now, 0, 0.0
            return True, suppressed, worst


class TimedLock:
    def __init__(self, name: str, *, warn_after: float = 0.2,
                 logger: logging.Logger | None = None) -> None:
        self.name = name
        self.warn_after = warn_after
        self._lock = threading.RLock()
        self._depth = 0  # 只有持锁线程会改它
        self._since = 0.0
        self._site = ""
        self._logger = logger or logging.getLogger(__name__)
        self._throttle = Throttle()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        acquired = self._lock.acquire(blocking, timeout)
        if acquired:
            self._enter(sys._getframe(1))
        return acquired

    def release(self) -> None:
        self._depth -= 1
        if self._depth:
            self._lock.release()
            return
        held = time.monotonic() - self._since
        site = self._site
        self._lock.release()
        if held > self.warn_after:
            self._warn(held, site)

    def __enter__(self) -> TimedLock:
        self._lock.acquire()
        self._enter(sys._getframe(1))
        return self

    def __exit__(self, *_exc) -> None:
        self.release()

    def _enter(self, frame) -> None:
        self._depth += 1
        if self._depth == 1:  # 只量最外层
            self._since = time.monotonic()
            self._site = f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno}"

    def _warn(self, held: float, site: str) -> None:
        log, suppressed, worst = self._throttle.pass_through(held)
        if not log:
            return
        extra = f"（此前 10 秒内另有 {suppressed} 次超时，最长 {worst:.2f}s）" if suppressed else ""
        self._logger.warning("锁持有过久 lock=%s 持有=%.2fs 调用点=%s%s",
                             self.name, held, site, extra)
