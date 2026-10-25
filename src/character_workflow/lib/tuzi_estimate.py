"""Tuzi estimates use the outbound image model and verified snapshot rules."""
from __future__ import annotations

import math

from character_workflow.lib.callers.openai_image import (
    _image_generation_payload, _normalize_size_for_provider, image_family,
    supports_image_quality, tuzi_image_quality, tuzi_outbound_image_model,
)
from character_workflow.lib.image_size_catalog import (
    image_size_options, is_nano_image_size_model, uses_tuzi_gpt25_tiers,
)
from character_workflow.lib.tuzi_billing_expr import UnsupportedBillingExpr, evaluate
from character_workflow.lib.tuzi_prices import load_snapshot


def request_fields(*, model_id, provider, base_url, billing_group, n, size, quality,
                   reference_image_count=0):
    family = image_family(model_id)
    size = _normalize_size_for_provider(size, family == "seedream", model_id)
    if is_nano_image_size_model(model_id) and size in image_size_options(
        provider or "custom", base_url, model_id,
    )["ratios"]:
        size = str(size).replace(":", "x")
    outbound_quality = quality if supports_image_quality(model_id) and quality in {
        "low", "medium", "high", "auto",
    } else None
    if uses_tuzi_gpt25_tiers(base_url, billing_group, model_id):
        outbound_quality = quality if quality in {"1k", "2k", "4k"} else None
    if family == "nano-banana":
        outbound_quality = tuzi_image_quality(model_id, outbound_quality)
    # Reference contents are never needed for supported pricing probes. Only the
    # actual single-string / multi-image-array shape is represented here.
    refs = ["reference"] * reference_image_count
    return _image_generation_payload(
        model=tuzi_outbound_image_model(model_id), prompt="", size=size, n=n,
        quality=outbound_quality, image=refs[0] if len(refs) == 1 else refs or None,
        seedream=family == "seedream", seedream_png=False,
    )


def estimate(*, model_id, provider, base_url, billing_group, protocol, n, size, quality,
             reference_image_count=0, layer_decomposition=False):
    group = (billing_group or "").strip()
    if not group or protocol not in {None, "openai", "ark"} or layer_decomposition:
        return None
    if image_family(model_id) == "midjourney":
        return None  # Explicit user decision: MJ remains unpriced pending billing evidence.
    snapshot = load_snapshot()
    try:
        rate = snapshot.get("usd_exchange_rate")
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
            return None
        params = request_fields(
            model_id=model_id, provider=provider, base_url=base_url, billing_group=group,
            n=n, size=size, quality=quality, reference_image_count=reference_image_count,
        )
        model = params["model"]
        pricing = snapshot.get("models", {}).get(model, {})
        if group not in pricing.get("enable_groups", []):
            return None
        expression = snapshot.get("billing_expr", {}).get(group, {}).get(model)
        if expression is not None:
            amount, _tier = evaluate(expression, params=params, variables={
                "output_image_count": n, "input_image_count": reference_image_count,
            })
            # Tuzi 按请求扣费（2026-10-25 账单：每次 generations 请求 quantity=1、与张数无关），
            # Nano Banana 一次只回 1 张，caller 补足循环按张再请求：出 n 张 = n 次扣费。
            if image_family(model_id) == "nano-banana" and "output_image_count" not in expression:
                amount *= max(1, int(n or 1))
        else:
            amount = pricing.get("model_price")
            ratio = snapshot.get("group_ratio", {}).get(group)
            if pricing.get("quota_type") != 0 or any(
                isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0
                for value in (amount, ratio)
            ):
                return None
            amount *= ratio
        result = amount * rate
        return math.floor(result * 1_000_000 + 0.5) / 1_000_000 if math.isfinite(result) else None
    except (UnsupportedBillingExpr, ValueError, TypeError, AttributeError, OverflowError):
        return None
