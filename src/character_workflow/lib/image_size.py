"""Image size intent, shared by saved preferences and frozen generation requests."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from character_workflow.lib.callers.openai_image import (
    _snap_hk_gpt_image_size,
    image_family,
    normalize_image_pixel_size,
)
from character_workflow.lib.keys import KeySpec
from character_workflow.lib.image_size_catalog import image_size_options, is_nano_image_size_model


# Verified 2026-09-09: official/Tuzi Images API, HK GPT Image docs, and OpenRouter's
# public /images/models capability descriptors. A compatible name alone is not evidence.
_OPENAI_AUTO_MODELS = frozenset({
    "gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2",
    "gpt-image-2-2026-04-21", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare-2026-09-08",
})
_HK_AUTO_MODELS = frozenset({"gpt-image-1", "gpt-image-1.5", "gpt-image-2"})
_TUZI_AUTO_MODELS = frozenset({"gpt-image-1", "gpt-image-1.5", "gpt-image-2"})


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
    result = {name: value for name, value in params.items() if value is not None}
    result.pop("custom_size", None)
    mode = result.get("size_mode")
    options = image_size_options(key.provider, key.base_url, model)
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


def normalized_image_submission_size(key: KeySpec, model: str, size: str) -> str:
    host = (urlsplit(key.base_url or "").hostname or "").lower()
    if image_family(model) == "gpt-image" and (
        host == "openai-hk.com" or host.endswith(".openai-hk.com")
    ):
        return str(_snap_hk_gpt_image_size(size))
    return normalize_image_pixel_size(model, size)
