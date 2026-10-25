"""Tuzi public pricing snapshots, restricted to configured models and billing groups."""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

SYNC_INTERVAL_SECONDS = 6 * 3600
_ORIGIN = "https://api.tu-zi.com"
_log = logging.getLogger(__name__)
_worker_started = False
_worker_lock = threading.Lock()


def snapshot_path() -> Path:
    return data_root.runtime_dir() / "prices" / "tuzi.json"


def load_snapshot() -> dict[str, Any]:
    try:
        value = json.loads(snapshot_path().read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("models"), dict):
            return value
    except (OSError, ValueError):
        pass
    return {"synced_at": None, "models": {}, "billing_expr": {}, "group_ratio": {}}


def _configured_models() -> dict[str, set[str]]:
    from character_workflow.lib import keys
    from character_workflow.lib.callers.openai_image import tuzi_outbound_image_model

    configured: dict[str, set[str]] = {}
    for key in keys.read_keys_db().keys:
        try:
            parsed = urlsplit(key.base_url or "")
            host = (parsed.hostname or "").lower() if parsed.scheme else ""
        except ValueError:
            continue
        if host != "tu-zi.com" and not host.endswith(".tu-zi.com"):
            continue
        group = (key.billing_group or "").strip()
        if group:
            ids = configured.setdefault(group, set())
            for model in key.models:
                ids.add(model.id)
                if keys.model_modality(model, key) == "image":
                    ids.add(tuzi_outbound_image_model(model.id))
    return configured


def sync() -> dict[str, Any]:
    """Publish both public responses atomically; failed refreshes keep the old snapshot."""
    configured = _configured_models()
    if not configured:
        return load_snapshot()
    try:
        responses = []
        for endpoint in ("pricing", "status"):
            response = requests.get(f"{_ORIGIN}/api/{endpoint}", timeout=30)
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict) or body.get("success") is not True:
                raise ValueError(f"invalid {endpoint} response")
            responses.append(body)
        pricing, status = responses
        rate = status.get("data", {}).get("usd_exchange_rate")
        if (isinstance(rate, bool) or not isinstance(rate, (int, float))
                or not math.isfinite(rate) or rate <= 0):
            raise ValueError("usd_exchange_rate must be positive and finite")
        rows = pricing.get("data")
        groups = pricing.get("group_model_pricing")
        ratios = pricing.get("group_ratio")
        if (not isinstance(rows, list) or not isinstance(groups, dict)
                or not isinstance(ratios, dict)):
            raise ValueError("pricing fields missing")
        model_ids = set().union(*configured.values())
        models = {}
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("invalid model pricing row")
            model_id = row.get("model_name")
            if model_id in model_ids:
                models[model_id] = {
                    field: row.get(field)
                    for field in ("quota_type", "model_price", "enable_groups")
                }
        expressions = {}
        from character_workflow.lib.tuzi_billing_expr import (
            UnsupportedBillingExpr, compile_expression,
        )

        for group, ids in configured.items():
            group_prices = groups.get(group, {})
            if not isinstance(group_prices, dict):
                raise ValueError("invalid group pricing")
            billing = group_prices.get("billing_expr", {})
            if not isinstance(billing, dict):
                raise ValueError("invalid billing expressions")
            expressions[group] = {
                model_id: expression for model_id, expression in billing.items()
                if model_id in ids
            }
            for model_id, expression in expressions[group].items():
                try:
                    compile_expression(expression)
                except UnsupportedBillingExpr as error:
                    _log.warning("Tuzi 模型暂未计价：%s/%s：%s", group, model_id, error)
        snapshot = {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "usd_exchange_rate": rate,
            "group_ratio": {group: ratios[group] for group in configured if group in ratios},
            "billing_expr": expressions,
            "models": models,
        }
        atomic_write_json(snapshot_path(), snapshot)
        return snapshot
    except (requests.RequestException, ValueError, TypeError, AttributeError, OSError) as error:
        _log.warning("Tuzi 价格同步失败，保留旧快照：%s", error)
        return load_snapshot()


def start_background_sync() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    def loop() -> None:
        while True:
            try:
                sync()
            except Exception:  # noqa: BLE001 — refresh must not interrupt the server
                _log.exception("Tuzi 价格同步失败")
            time.sleep(SYNC_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="tuzi-price-sync", daemon=True).start()
