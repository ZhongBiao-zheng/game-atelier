"""Process-local text calls and events; the UI subscribes without lib importing server code."""
from collections.abc import Callable
import logging
import threading

listeners: list[Callable[[dict], None]] = []
_calls: dict[str, dict] = {}
_lock = threading.RLock()


def notify(snapshot: dict) -> None:
    for listener in tuple(listeners):
        try:
            listener(dict(snapshot))
        except Exception:  # noqa: BLE001 — UI observers must not interrupt billing or generation
            logging.getLogger(__name__).exception("Gateway live listener failed")


def register(snapshot: dict) -> None:
    with _lock:
        _calls[snapshot["call_id"]] = dict(snapshot)
    notify(snapshot)


def finish(call_id: str, status: str) -> None:
    with _lock:
        snapshot = _calls.pop(call_id, None)
    if snapshot:
        notify({**snapshot, "status": status})


def active() -> list[dict]:
    with _lock:
        return [dict(call) for call in _calls.values()]
