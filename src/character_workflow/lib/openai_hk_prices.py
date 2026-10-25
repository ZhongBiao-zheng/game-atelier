"""OpenAI-HK public per-call prices; amounts are already in CNY."""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

SYNC_INTERVAL_SECONDS = 6 * 3600
_log = logging.getLogger(__name__)
_worker_started = False
_worker_lock = threading.Lock()


def snapshot_path():
    return data_root.runtime_dir() / "prices" / "openai-hk.json"


def load_snapshot() -> dict:
    try:
        value = json.loads(snapshot_path().read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("models"), dict):
            return value
    except (OSError, ValueError):
        pass
    return {"synced_at": None, "models": {}, "group_ratio": {}}


def sync() -> dict:
    from character_workflow.lib.keys import read_keys_db

    models = set()
    for key in read_keys_db().keys:
        try:
            host = (urlsplit(key.base_url or "").hostname or "").lower()
        except ValueError:
            continue
        if host == "openai-hk.com" or host.endswith(".openai-hk.com"):
            # The HK caller sends configured model IDs unchanged.
            models.update(model.id for model in key.models)
    if not models:
        return load_snapshot()
    try:
        response = requests.get("https://www.openai-hk.com/ccapi/pricing", timeout=30)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("success") is not True:
            raise ValueError("invalid pricing response")
        rows, ratios = body.get("data"), body.get("group_ratio")
        if not isinstance(rows, list) or not isinstance(ratios, dict):
            raise ValueError("pricing fields missing")
        selected = {}
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("invalid model pricing row")
            model = row.get("model_name")
            if model not in models:
                continue
            amount = row.get("model_price")
            if (isinstance(amount, bool) or not isinstance(amount, (int, float))
                    or not math.isfinite(amount) or amount < 0
                    or row.get("quota_type") not in (0, 1)
                    or not isinstance(row.get("enable_groups"), list)):
                raise ValueError("invalid model pricing fields")
            selected[model] = {field: row.get(field) for field in (
                "quota_type", "model_price", "model_ratio", "completion_ratio", "enable_groups",
            )}
        snapshot = {"synced_at": datetime.now(timezone.utc).isoformat(),
                    "models": selected, "group_ratio": ratios}
        atomic_write_json(snapshot_path(), snapshot)
        return snapshot
    except (requests.RequestException, ValueError, TypeError, AttributeError, OSError) as error:
        _log.warning("OpenAI-HK 价格同步失败，保留旧快照：%s", error)
        return load_snapshot()


def start_background_sync() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    def loop():
        while True:
            try:
                sync()
            except Exception:  # noqa: BLE001 — refresh must not interrupt the server
                _log.exception("OpenAI-HK 价格同步失败")
            time.sleep(SYNC_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="openai-hk-price-sync", daemon=True).start()
