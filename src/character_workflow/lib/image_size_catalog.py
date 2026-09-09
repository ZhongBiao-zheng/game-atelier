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


def image_size_options(provider: str, base_url: str | None, model: str) -> dict[str, list[str]]:
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
    if "seedream-5-0-pro" in normalized:
        resolutions = ["2K"]
    return {"ratios": list(ratios), "resolutions": resolutions}
