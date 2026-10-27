"""Image size intent, shared by saved preferences and frozen generation requests."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from character_workflow.lib.callers.openai_image import (
    _max_pixels_for_seedream,
    _snap_hk_gpt_image_size,
    image_family,
    normalize_image_pixel_size,
    resolve_image_protocol,
)
from character_workflow.lib.keys import KeySpec, ModelSpec, size_channel
from character_workflow.lib.image_size_catalog import (
    image_size_options, is_nano_image_size_model,
)


# Verified 2026-09-09: official/Tuzi Images API, HK GPT Image docs, and OpenRouter's
# public /images/models capability descriptors. A compatible name alone is not evidence.
_OPENAI_AUTO_MODELS = frozenset({
    "gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2",
    "gpt-image-2-2026-04-21", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare-2026-09-08",
})
# 2026-09-17 实测：两家网关的 gpt-image-2.5 系发 size=auto 都正常出图，与 gpt-image-2 同列。
# 名单只收真打过 auto 请求验证过的型号；HK 侧没验过裸 gpt-image-2.5，就不写进来。
_HK_AUTO_MODELS = frozenset({
    "gpt-image-1", "gpt-image-1.5", "gpt-image-2",
    "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
})
_TUZI_AUTO_MODELS = frozenset({
    "gpt-image-1", "gpt-image-1.5", "gpt-image-2",
    "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
})


def supports_auto_image_size(provider: str, base_url: str | None, model: str) -> bool:
    host = (urlsplit(base_url or "").hostname or "").lower()
    if provider == "openrouter":
        return host == "openrouter.ai" and "auto" in image_size_options(
            provider, base_url, model,
        )["ratios"]
    if provider not in {"openai", "custom"}:
        return False
    if host == "tu-zi.com" or host.endswith(".tu-zi.com"):
        return model in _TUZI_AUTO_MODELS
    if host == "openai-hk.com" or host.endswith(".openai-hk.com"):
        return model in _HK_AUTO_MODELS
    return (
        (host == "api.openai.com" or (not host and provider == "openai"))
        and model in _OPENAI_AUTO_MODELS
    )


def normalize_image_size_params(key: KeySpec, model: str, params: dict[str, Any]) -> dict[str, Any]:
    """Freeze only the active intent; inactive editor drafts never reach a Job or caller."""
    if key.provider == "atelier":
        key, channel_model = size_channel(key, next(
            (item for item in key.models if item.id == model), ModelSpec(id=model, name=model)))
        model = channel_model.id
    result = {name: value for name, value in params.items() if value is not None}
    result.pop("custom_size", None)
    mode = result.get("size_mode")
    options = image_size_options(key.provider, key.base_url, model)
    if resolve_image_protocol(key.provider, key.base_url, model) == "evolink":
        # Midjourney owns pixel dimensions. Explicit ratio is passed by the caller as --ar;
        # AUTO leaves that choice to its native prompt and discards stale pixel settings.
        result.pop("size", None)
        result.pop("resolution", None)
        if mode == "custom":
            raise ValueError("当前模型不支持自定义像素尺寸")
        if mode == "auto":
            result["size"] = "auto"
            result.pop("ratio", None)
        elif mode == "ratio":
            ratio = result.get("ratio") or params.get("size") or options["ratios"][0]
            if ratio not in options["ratios"]:
                raise ValueError("当前模型或渠道不支持该图片比例")
            result["ratio"] = ratio
        elif mode is not None:
            raise ValueError("未知图片尺寸模式")
        return result
    if not options["ratios"]:
        for field in ("size_mode", "size", "ratio", "resolution"):
            result.pop(field, None)
        return result
    if mode is None:
        return result
    if mode == "auto":
        spec = next((item for item in key.models if item.id == model), None)
        if not supports_auto_image_size(key.provider, key.base_url, model) or (
            spec and spec.protocol not in {None, "openai", "openrouter"}
        ):
            raise ValueError("当前模型或渠道尚未确认支持 AUTO 尺寸，请选择比例或自定义尺寸")
        result["size"] = "auto"
        result.pop("ratio", None)
        result.pop("resolution", None)
    elif mode == "custom":
        if key.provider != "openrouter" and (
            is_nano_image_size_model(model) or image_family(model) == "midjourney"
        ):
            raise ValueError("当前模型不支持自定义像素尺寸")
        size = str(result.get("size") or "").strip()
        if not re.fullmatch(r"[1-9]\d*x[1-9]\d*", size):
            raise ValueError("请输入有效的自定义宽度和高度")
        width, height = (int(value) for value in size.split("x"))
        if max(width, height) > 100_000:
            raise ValueError("自定义宽度和高度不能超过 100000")
        if image_family(model) == "gpt-image" and max(width, height) / min(width, height) > 3:
            raise ValueError("GPT Image 的长短边比例不能超过 3:1")
        result["size"] = normalized_image_submission_size(key, model, size)
        result.pop("ratio", None)
        result.pop("resolution", None)
    elif mode == "ratio":
        if result.get("size") == "auto":
            raise ValueError("比例模式不能使用 AUTO 尺寸，请重新选择比例")
        ratio = result.get("ratio")
        if ratio is None and ":" in str(result.get("size") or ""):
            ratio = result["size"]
        if ratio is not None and ratio not in options["ratios"]:
            raise ValueError("当前模型或渠道不支持该图片比例")
        if ratio == "auto":
            raise ValueError("比例模式不能使用 AUTO 尺寸，请重新选择比例")
        if key.provider == "openrouter" or is_nano_image_size_model(model):
            result["ratio"] = ratio or options["ratios"][0]
            result["size"] = result["ratio"]
        elif not result.get("size") and image_family(model) != "midjourney":
            # 不经浏览器写的草稿（Agent / MCP）只有比例：size=null 发出去等于 AUTO，横竖由模型定。
            result["ratio"] = ratio or options["ratios"][0]
            result["size"] = ratio_pixel_size(
                result["ratio"], result.get("resolution") or _default_resolution(options), model,
            )
        resolution = result.get("resolution")
        if resolution is not None:
            resolution = str(resolution).upper()
            if resolution not in options["resolutions"]:
                if options["resolutions"]:
                    raise ValueError("当前模型或渠道不支持该图片分辨率")
                result.pop("resolution", None)
            else:
                result["resolution"] = resolution
        if isinstance(result.get("size"), str):
            result["size"] = normalized_image_submission_size(key, model, result["size"])
    else:
        raise ValueError("未知图片尺寸模式")
    return result


# 与 web/src/lib/studioSize.ts 的 SEEDREAM 尺寸表 / computeStudioPixelSize 逐项一致。
_SEEDREAM_SIZE_TABLE: dict[str, dict[str, tuple[int, int]]] = {
    "2K": {
        "1:1": (2048, 2048), "4:3": (2304, 1728), "3:4": (1728, 2304),
        "16:9": (2560, 1440), "9:16": (1440, 2560), "3:2": (2496, 1664),
        "2:3": (1664, 2496), "21:9": (3024, 1296), "4:5": (1792, 2240), "5:4": (2240, 1792),
    },
    "4K": {
        "1:1": (4096, 4096), "4:3": (4096, 3072), "3:4": (3072, 4096),
        "16:9": (4096, 2304), "9:16": (2304, 4096), "3:2": (4096, 2731),
        "2:3": (2731, 4096), "21:9": (4096, 1755), "4:5": (3277, 4096), "5:4": (4096, 3277),
    },
}
_RESOLUTION_EDGE = {"512": 512, "1K": 1024, "2K": 2048, "4K": 4096}


def _default_resolution(options: dict[str, list[str]]) -> str:
    resolutions = options["resolutions"]
    return "2K" if "2K" in resolutions or not resolutions else resolutions[0]


def ratio_pixel_size(ratio: str, resolution: str, model: str) -> str:
    """比例 + 档位 → 像素，浏览器 studioSizeFor 的服务端版本。"""
    if image_family(model) == "seedream":
        max_pixels = _max_pixels_for_seedream(model)
        if all(w * h > max_pixels for w, h in _SEEDREAM_SIZE_TABLE["4K"].values()):
            # 只剩 2K 一档：撑满模型上限（向下取整，多一个像素就越界）。
            w, h = _SEEDREAM_SIZE_TABLE["2K"].get(ratio, _SEEDREAM_SIZE_TABLE["2K"]["1:1"])
            scale = (max_pixels / (w * h)) ** 0.5
            return f"{max(1, int(w * scale))}x{max(1, int(h * scale))}"
        table = _SEEDREAM_SIZE_TABLE["4K" if resolution == "4K" else "2K"]
        w, h = table.get(ratio, table["1:1"])
        return f"{w}x{h}"
    base = _RESOLUTION_EDGE.get(resolution, 2048)
    a, _, b = ratio.partition(":")
    if not (a.isdigit() and b.isdigit()) or int(a) == 0 or int(b) == 0 or a == b:
        return f"{base}x{base}"
    a, b = int(a), int(b)
    if a >= b:
        return f"{base}x{_js_round(b / a * base)}"
    return f"{_js_round(a / b * base)}x{base}"


def _js_round(value: float) -> int:
    # Math.round 是 half-up；Python round 是银行家舍入。
    return int(value + 0.5)


def normalized_image_submission_size(key: KeySpec, model: str, size: str) -> str:
    host = (urlsplit(key.base_url or "").hostname or "").lower()
    if image_family(model) == "gpt-image" and (
        host == "openai-hk.com" or host.endswith(".openai-hk.com")
    ):
        return str(_snap_hk_gpt_image_size(size))
    return normalize_image_pixel_size(model, size)
