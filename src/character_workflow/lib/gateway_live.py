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
    notify(text_snapshot(snapshot))


def finish(call_id: str, status: str) -> None:
    with _lock:
        snapshot = _calls.pop(call_id, None)
    if snapshot:
        notify(text_snapshot({**snapshot, "status": status}))


def active() -> list[dict]:
    with _lock:
        return [dict(call) for call in _calls.values()]


def text_snapshot(call: dict) -> dict:
    from datetime import datetime, timezone
    return {"task_id": call["call_id"], "kind": "text", "key_name": call["key_name"],
            "route_id": call["route_id"], "member_alias": call["member_alias"],
            "member_trail": [call["member_alias"]], "phase": None,
            "status": call.get("status", "running"), "created_at": call["started_at"],
            "updated_at": datetime.now(timezone.utc).isoformat(), "prompt": None,
            "n": 0, "outputs": 0, "output_types": [], "error": None}
