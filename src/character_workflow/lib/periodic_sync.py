"""Immediately refresh a snapshot, then wait for the next interval or shutdown."""
import logging
import threading
from collections.abc import Callable


class PeriodicSync:
    def __init__(self, name: str):
        self.name = name
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, sync: Callable, interval: float, logger: logging.Logger, message: str) -> None:
        def run():
            while not self._stop.is_set():
                try:
                    sync()
                except Exception:  # A failed refresh leaves the previous snapshot available.
                    logger.exception(message)
                if self._stop.wait(interval):
                    return

        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=run, name=self.name, daemon=True)
            self._thread.start()

    def stop(self) -> threading.Thread | None:
        """Wake the worker and return the thread so the caller can join any active refresh."""
        with self._lock:
            self._stop.set()
            return self._thread
