"""OpenRouter generation usage helpers shared by image and video callers."""
from __future__ import annotations

import math
from typing import Any


def cost_usd(payload: dict[str, Any]) -> float | None:
    usage = payload.get("usage")
    raw = usage.get("cost") if isinstance(usage, dict) else None
    try:
        cost = float(raw)
    except (TypeError, ValueError):
        return None
    return cost if math.isfinite(cost) and cost >= 0 else None
