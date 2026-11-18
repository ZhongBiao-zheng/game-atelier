"""Tuzi estimates use the outbound image model and verified snapshot rules."""
from __future__ import annotations

import math

from character_workflow.lib.callers.openai_image import (
    _image_generation_payload, _normalize_size_for_provider, image_family,
    supports_image_quality, tuzi_image_quality, tuzi_outbound_image_model,
)
from character_workflow.lib.image_size_catalog import (
    image_size_options, is_nano_image_size_model,
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
        "low", "medium", "high", "xhigh", "max", "auto",
    } else None
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
            amount *= snapshot.get("expr_multiplier", {}).get(group, {}).get(model, 1)
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


# new-api 的额度单位：500000 = 1 美元；倍率 1 = 每百万 token 2 美元。
_QUOTA_PER_USD = 500_000


def text_cost_cny(*, billing_group, model_id, input_tokens, output_tokens, cached_tokens=0):
    """按 token 计费的文本模型；只认 2026-11-18 付费小测逐位核对过的情形，其余返回 None（未计价）。

    账单公式：quota = (输入 - 缓存命中 + 缓存命中 × cache_ratio + 输出 × completion_ratio)
    × model_ratio × 分组倍率；再按 500000 quota = 1 美元、乘 usd_exchange_rate 换成人民币。
    核对过的只有分组倍率 1、没有生效分组倍率与模型乘数的情形（default 分组下 group_override
    与 global_fallback 各一条），其余倍率组合没对过账，先不计价。缓存命中的折扣没有实测。
    """
    group = (billing_group or "").strip()
    if not group:
        return None
    snapshot = load_snapshot()
    rate = snapshot.get("usd_exchange_rate")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or rate <= 0:
        return None
    if group not in snapshot.get("models", {}).get(model_id, {}).get("enable_groups", []):
        return None
    entry = snapshot.get("text_ratio", {}).get(group, {}).get(model_id)
    if not isinstance(entry, dict) or snapshot.get("group_ratio", {}).get(group) != 1:
        return None
    if (entry.get("pricing_source") not in ("group_override", "global_fallback")
            or entry.get("effective_group_ratio") not in (None, 1)
            or entry.get("model_multiplier") not in (None, 1)):
        return None
    ratio, completion = entry.get("model_ratio"), entry.get("completion_ratio")
    cache = entry.get("cache_ratio")
    if not isinstance(ratio, (int, float)) or not isinstance(completion, (int, float)):
        return None
    cached = min(max(0, cached_tokens or 0), input_tokens)
    weighted = (input_tokens - cached + cached * (cache if isinstance(cache, (int, float)) else 1)
                + output_tokens * completion)
    # 账单的 quota 是整数（31.1 记 31）。
    result = math.floor(weighted * ratio + 0.5) / _QUOTA_PER_USD * rate
    return math.floor(result * 1_000_000 + 0.5) / 1_000_000 if math.isfinite(result) else None
