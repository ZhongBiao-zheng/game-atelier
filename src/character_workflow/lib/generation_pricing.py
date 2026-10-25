"""Synchronous CNY estimates, kept in parity with web/lib/generationCost.ts.

Unknown channels/models remain unpriced. Prices are packaged resources shared
with the frontend; never infer a price from a similarly named model.
"""
from __future__ import annotations

import json
import math
import re
from importlib.resources import files
from typing import Any
from urllib.parse import urlsplit

_PRICES = json.loads(
    files("character_workflow").joinpath("data/generation_prices.json").read_text(encoding="utf-8")
)

_MODERN_DIMENSIONS = {
    "480p": [(864, 496), (752, 560), (640, 640), (560, 752), (496, 864), (992, 432)],
    "720p": [(1280, 720), (1112, 834), (960, 960), (834, 1112), (720, 1280), (1470, 630)],
    "1080p": [(1920, 1080), (1664, 1248), (1440, 1440), (1248, 1664), (1080, 1920), (2206, 946)],
}
_LEGACY_DIMENSIONS = {
    "480p": [(864, 480), (736, 544), (640, 640), (544, 736), (480, 864), (960, 416)],
    "720p": [(1248, 704), (1120, 832), (960, 960), (832, 1120), (704, 1248), (1504, 640)],
    "1080p": [(1920, 1088), (1664, 1248), (1440, 1440), (1248, 1664), (1088, 1920), (2176, 928)],
}
_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]
_GEMINI_PRO = {
    "gemini-3-pro-image", "gemini-3-pro-image-preview", "nano-banana-pro",
    "nano-banana-pro-2k", "nano-banana-pro-4k",
}


def _normalize(value: str | None) -> str:
    return re.sub(r"[._]", "-", (value or "").strip().lower())


def _hostname(base_url: str | None) -> str:
    try:
        parsed = urlsplit(base_url or "")
        return (parsed.hostname or "").lower() if parsed.scheme else ""
    except ValueError:
        return ""


def _domain(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _priced(amount: float) -> float:
    # JS Math.round (positive money), rather than Python's ties-to-even round.
    return math.floor(amount * 1_000_000 + 0.5) / 1_000_000


def _pixels(size: str | None) -> tuple[int, int] | None:
    match = re.fullmatch(r"([0-9]+)x([0-9]+)", (size or "").strip())
    return (int(match[1]), int(match[2])) if match else None


def _tuzi(*, model_id, model, billing_group, n, size, size_mode, quality, resolution):
    group = (billing_group or "").strip()
    if not group:
        return None
    exact = model_id.strip()
    p = _PRICES
    if group == "default":
        if exact == "gpt-image-2.5-1k":
            return _priced(p["TUZI_GPT_IMAGE_25_1K_YUAN_PER_IMAGE"] * n)
        prices = p["TUZI_GPT_IMAGE_25_YUAN_PER_IMAGE"].get(exact)
        if prices:
            explicit = None if size_mode == "auto" else (
                resolution if resolution is not None else (quality or "").upper()
            )
            if explicit in ("1K", "2K", "4K"):
                tier = explicit
            else:
                dimensions = _pixels(size)
                pixels = dimensions[0] * dimensions[1] if dimensions else 0
                whitelisted = exact in ("gpt-image-2.5", "gpt-image-2.5-vip") and (
                    (size or "").lower() in p["TUZI_GPT_IMAGE_2_1K_SIZES"]
                )
                limits = p["TUZI_GPT_IMAGE_25_PIXEL_LIMITS"]
                tier = "1K" if whitelisted else (
                    "4K" if pixels > limits["2K"] else "2K" if pixels > limits["1K"] else "1K"
                )
            return _priced(prices[tier] * n)
        if model == "mj-imagine":
            return p["TUZI_MIDJOURNEY_YUAN_PER_TASK"]
        if model in _GEMINI_PRO:
            tier = "4k" if model.endswith("-4k") else "2k" if model.endswith("-2k") else (
                "4k" if quality == "high" else "2k" if quality == "medium" else "1k"
            )
            return _priced(p["TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE"][tier] * n)
        if exact == "gpt-image-2-1k":
            return _priced(p["TUZI_GPT_IMAGE_2_1K_YUAN_PER_IMAGE"] * n)
        if exact == "gpt-image-2":
            raw = (size or "").lower()
            dimensions = _pixels(raw)
            if not dimensions or any(x < 1 or x > 2**53 - 1 for x in dimensions):
                return None
            pixels = dimensions[0] * dimensions[1]
            if pixels > 2**53 - 1:
                return None
            limits = p["TUZI_GPT_IMAGE_2_PIXEL_LIMITS"]
            low = raw in p["TUZI_GPT_IMAGE_2_1K_SIZES"] or pixels <= limits["1k"]
            tier = "1k" if low else "2k" if pixels <= limits["2k"] else "4k"
            return _priced(p["TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE"][tier] * n)
    rate = p["TUZI_GROUP_YUAN_PER_IMAGE"].get(group, {}).get(model)
    return None if rate is None else _priced(rate * n)


def _rate(value: Any) -> float | None:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return None
    return rate if math.isfinite(rate) and rate >= 0 else None


def _tokendance(*, kind, model_id, n, size, duration, resolution, ratio, has_reference_video):
    """按 TokenDance 价格快照估价：图片按张（可按输出千像素分段），视频按输出 token 或按秒。"""
    from character_workflow.lib.tokendance_prices import model_pricing

    pricing = model_pricing(model_id)
    items = [item for item in (pricing or {}).get("items") or [] if isinstance(item, dict)]
    if kind == "image":
        item = next((item for item in items
                     if str(item.get("id", "")).endswith(("generated_images", ":images"))), None)
        plans = [plan for plan in (item or {}).get("plans") or []
                 if isinstance(plan, dict) and plan.get("unit") == "images"]
        dimensions = _pixels(size)
        kpixels = dimensions[0] * dimensions[1] / 1000 if dimensions else None

        def fits(plan: dict) -> bool:
            bounds = plan.get("range")
            if not isinstance(bounds, dict) or kpixels is None:
                return True
            return (float(bounds.get("lower", 0)) <= kpixels
                    and ("upper" not in bounds or kpixels < float(bounds["upper"])))

        # 不知道输出尺寸时，只有各档同价才能估。
        rates = {_rate(plan.get("rate")) for plan in plans if fits(plan)}
        if len(rates) != 1 or None in rates:
            return None
        return _priced(rates.pop() * n)
    if duration is None or not math.isfinite(duration) or duration <= 0:
        return None
    res = (resolution or "").strip().lower()
    video = "true" if has_reference_video else "false"
    candidates = []
    for item in items:
        for sku in item.get("skus") or []:
            specs = sku.get("specs") or {} if isinstance(sku, dict) else {}
            sku_res = str(specs.get("resolution", "*")).lower()
            if sku_res not in ("*", res) or specs.get("has_video", video) != video:
                continue
            candidates.append((sku_res != "*", sku))
    if not candidates:
        return None
    sku = max(candidates, key=lambda pair: pair[0])[1]  # 指定分辨率的价格优先于通配
    rate = _rate(sku.get("rate"))
    if rate is None:
        return None
    if sku.get("unit") == "seconds":
        return _priced(rate * duration * n)
    if sku.get("unit") == "millionTokens":
        aspect = (ratio or "").strip()
        if res not in _MODERN_DIMENSIONS or aspect not in _RATIOS:
            return None
        width, height = _MODERN_DIMENSIONS[res][_RATIOS.index(aspect)]
        return _priced(duration * width * height * 24 / 1024 * rate * n / 1_000_000)
    return None


def estimate_cost_cny(
    *, kind: str, provider: str | None = None, base_url: str | None = None,
    billing_group: str | None = None, model_id: str | None = None,
    protocol: str | None = None, n: float | None = 1, size: str | None = None,
    size_mode: str | None = None, quality: str | None = None, duration: float | None = None,
    resolution: str | None = None, ratio: str | None = None, generate_audio: bool = False,
    has_reference_video: bool = False, image_edit: bool = False,
) -> float | None:
    """Estimate one generation request; None means no verified price."""
    if not model_id:
        return None
    count = max(1, math.floor(n)) if n is not None and math.isfinite(n) else 1
    model = _normalize(model_id)
    host = _hostname(base_url)
    proto = _normalize(protocol)
    p = _PRICES
    ark = host == "ark.cn-beijing.volces.com" if (base_url or "").strip() else (
        _normalize(provider) in ("seedream", "seedance", "volces", "volcengine-video")
    )
    if kind == "image":
        if provider == "evolink":
            if (host and host != "api.evolink.ai") or model_id != "mj-v8.2" or (
                proto and proto != "evolink"
            ):
                return None
            route = "imageEdit" if image_edit else "generation"
            return _priced(p["EVOLINK_MIDJOURNEY_USD_PER_REQUEST"][route]
                           * p["GENERATION_USD_TO_CNY"])
        if _domain(host, "tu-zi.com"):
            return _tuzi(model_id=model_id, model=model, billing_group=billing_group,
                         n=count, size=size, size_mode=size_mode, quality=quality,
                         resolution=resolution)
        if _domain(host, "openai-hk.com") and proto in ("", "openai"):
            rate = p["OPENAI_HK_NANO_BANANA_2_YUAN"].get(quality) if model == "nano-banana-2" else (
                p["OPENAI_HK_FIXED_YUAN_PER_IMAGE"].get(model)
            )
        elif _normalize(provider) == "tokendance":
            return _tokendance(kind=kind, model_id=model_id, n=count, size=size, duration=duration,
                               resolution=resolution, ratio=ratio,
                               has_reference_video=has_reference_video)
        elif ark and proto in ("", "ark"):
            rate = p["ARK_SEEDREAM_YUAN_PER_IMAGE"].get(model)
        else:
            return None
        return None if rate is None else _priced(rate * count)
    if kind != "video" or duration is None or not math.isfinite(duration) or duration <= 0:
        return None
    res = _normalize(resolution)
    if _normalize(provider) == "tokendance":
        return _tokendance(kind=kind, model_id=model_id, n=count, size=size, duration=duration,
                           resolution=resolution, ratio=ratio,
                           has_reference_video=has_reference_video)
    if ark and proto in ("", "seedance"):
        if has_reference_video:
            return None
        aspect = (ratio or "").strip()
        table = _LEGACY_DIMENSIONS if model == "doubao-seedance-1-0-pro-250528" else (
            _MODERN_DIMENSIONS
        )
        if res not in table or aspect not in _RATIOS:
            return None
        width, height = table[res][_RATIOS.index(aspect)]
        rate = p["ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS"].get(model)
        if model == "doubao-seedance-2-0-260128":
            rate = rate["1080p" if res == "1080p" else "standard"]
        elif model == "doubao-seedance-1-5-pro-260428":
            rate = rate["audio" if generate_audio else "silent"]
        if rate is None:
            return None
        return _priced(duration * width * height * 24 / 1024 * rate * count / 1_000_000)
    if host == "dashscope.aliyuncs.com" and proto in ("", "dashscope"):
        for version in ("1-0", "1-1"):
            if model in {f"happyhorse-{version}-{mode}" for mode in ("t2v", "i2v", "r2v")}:
                rate = p[f"HAPPYHORSE_{version.replace('-', '_')}_YUAN_PER_SECOND"].get(res)
                return None if rate is None else _priced(rate * duration * count)
    return None


def estimate_text_cost_cny(
    model_id: str, input_tokens: int, output_tokens: int,
) -> float | None:
    """Exact model IDs only; an empty price table intentionally leaves text unpriced."""
    rate = _PRICES["text_yuan_per_million_tokens"].get(model_id)
    if rate is None:
        return None
    return _priced((input_tokens * rate["input"] + output_tokens * rate["output"]) / 1_000_000)
