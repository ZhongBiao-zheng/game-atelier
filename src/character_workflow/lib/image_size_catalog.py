"""Image dimensions verified per channel, shared with the browser's controls."""
from __future__ import annotations

import json
import re
from importlib.resources import files
from urllib.parse import urlsplit


_CATALOG = json.loads(
    files("character_workflow").joinpath("image_size_catalog.json").read_text(encoding="utf-8")
)


def is_nano_image_size_model(model: str) -> bool:
    normalized = model.lower().rsplit("/", 1)[-1].replace("_", "-").replace(".", "-")
    return "nano-banana" in normalized or (
        re.match(r"^gemini-.*-image(?:-|$)", normalized) is not None
    )


_TUZI_GPT_TIERED = re.compile(r"^gpt-image-2\.[56](?:-|$)")


def is_tuzi_gpt25(base_url: str | None, model: str) -> bool:
    """Tuzi 上的 GPT Image 2.5 / 2.6 系：五档质量、比例自选、不给 K 分辨率档。"""
    host = (urlsplit(base_url or "").hostname or "").lower()
    return (host == "tu-zi.com" or host.endswith(".tu-zi.com")) and (
        _TUZI_GPT_TIERED.match(model) is not None
    )


def image_size_options(provider: str, base_url: str | None, model: str) -> dict[str, list[str]]:
    # Subscription controls stay hidden until verified against a real account.
    if provider == "chatgpt":
        return {"ratios": [], "resolutions": []}
    if provider == "openrouter":
        options = _CATALOG["openrouter"].get(model)
        return {
            "ratios": list(options["ratios"] if options else _CATALOG["legacy_ratios"]),
            "resolutions": list(options["resolutions"] if options else []),
        }

    host = (urlsplit(base_url or "").hostname or "").lower()
    normalized = model.lower().rsplit("/", 1)[-1].replace("_", "-").replace(".", "-")
    nano = is_nano_image_size_model(model)
    ratios = _CATALOG["common_ratios"]
    if nano and (host == "openai-hk.com" or host.endswith(".openai-hk.com")):
        ratios = _CATALOG["hk_nano_ratios"]
    resolutions = [] if nano or "gpt-image" in normalized or (
        normalized.startswith(("mj-", "niji")) or "midjourney" in normalized
    ) else ["2K", "4K"]
    if "seedream-5-0-pro" in normalized or "seedream-5-5" in normalized:
        # 上限 4624220，4K 档每一挡都超；下限 921600，1K 档可用（与前端 availableResolutions 同判据）。
        resolutions = ["1K", "2K"]
    # Tuzi 的 gpt-image 走 1K / 2K 档位（前端据此去掉自定义像素框）。不给 4K：2026-09-17
    # 实测单边封顶 2880，发 3840 / 4096 都只回 2880²，还比按 2880 发多花一倍 token。
    if "gpt-image" in normalized and (host == "tu-zi.com" or host.endswith(".tu-zi.com")):
        resolutions = [] if _TUZI_GPT_TIERED.match(model) else ["1K", "2K"]
    return {"ratios": list(ratios), "resolutions": resolutions}
