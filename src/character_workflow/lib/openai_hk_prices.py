"""OpenAI-HK public per-call prices; amounts are already in CNY."""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from urllib.parse import urlsplit

import requests

from character_workflow.lib.periodic_sync import PeriodicSync
from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry

SYNC_INTERVAL_SECONDS = 6 * 3600
_log = logging.getLogger(__name__)
_worker = PeriodicSync("openai-hk-price-sync")
stop_background_sync = _worker.stop


def snapshot_path():
    return data_root.runtime_dir() / "prices" / "openai-hk.json"


def load_snapshot() -> dict:
    try:
        value = json.loads(read_text_with_retry(snapshot_path()))
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
    _worker.start(sync, SYNC_INTERVAL_SECONDS, _log, "OpenAI-HK 价格同步失败")


def estimate(*, model_id: str, n: int, billing_group: str | None) -> float | None:
    # Verified against existing bills; no inferred aliases, quality tiers or multi-image fees.
    if n != 1 or model_id not in {
        "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
        "gpt-image-2.6-flare", "gpt-image-2.6-sunburst",
        "nano-banana", "nano-banana-hd",
    } or (billing_group or "default").strip() != "default":
        return None
    row = load_snapshot().get("models", {}).get(model_id)
    if not isinstance(row, dict) or row.get("quota_type") != 1:
        return None
    if "default" not in (row.get("enable_groups") or []):
        return None
    amount = row.get("model_price")
    if (isinstance(amount, bool) or not isinstance(amount, (int, float))
            or not math.isfinite(amount) or amount <= 0):
        return None
    return math.floor(amount * 1_000_000 + 0.5) / 1_000_000


# 倍率 1 = 每百万 token 2 元；1 元 = 10000 积分。
_YUAN_PER_MILLION_AT_RATIO_1 = 2
_CREDITS_PER_YUAN = 10000


def _positive(value) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return Decimal(str(value)) if value > 0 else None


def text_cost_cny(*, model_id: str, input_tokens: int, output_tokens: int,
                  billing_group: str | None) -> float | None:
    """按 token 计费的文本：积分 = ⌈(输入 + 输出 × completion_ratio) × model_ratio × 2 × 分组倍率
    ÷ 1e6 × 10000⌉，再 ÷ 10000 换成元。

    2026-11-19 用 gpt-4.1-nano default 分组三条账单核对（14/1 → 1 积分、18015/1 → 127、
    22/1500 → 22）。只认 default 分组、`quota_type=0`；缓存命中按全价（价格表没有读缓存倍率，
    未核实）。其余返回 None。
    """
    group = (billing_group or "default").strip()
    if group != "default" or input_tokens < 0 or output_tokens < 0:
        return None
    snapshot = load_snapshot()
    row = snapshot.get("models", {}).get(model_id)
    if not isinstance(row, dict) or row.get("quota_type") != 0:
        return None
    if group not in (row.get("enable_groups") or []):
        return None
    model_ratio = _positive(row.get("model_ratio"))
    completion_ratio = _positive(row.get("completion_ratio"))
    group_ratio = _positive((snapshot.get("group_ratio") or {}).get(group))
    if model_ratio is None or completion_ratio is None or group_ratio is None:
        return None
    credits = ((input_tokens + output_tokens * completion_ratio) * model_ratio
               * _YUAN_PER_MILLION_AT_RATIO_1 * group_ratio * _CREDITS_PER_YUAN / 1_000_000)
    return float(credits.to_integral_value(rounding=ROUND_CEILING) / _CREDITS_PER_YUAN)
