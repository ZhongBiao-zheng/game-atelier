from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ImageProtocol(str, Enum):
    GPT_SIZE = "gpt-size"
    BANANA_RATIO = "banana-ratio"
    FAL = "fal"
    MJ = "mj"


@dataclass(frozen=True)
class MultipartFields:
    text: dict[str, str]
    needs_white_placeholder: bool = False


GPT_SIZE_MAP = {
    "1:1_1k": "1024x1024", "1:1_2k": "2048x2048", "1:1_4k": "2880x2880",
    "3:2_1k": "1248x832", "3:2_2k": "2496x1664", "3:2_4k": "3504x2336",
    "2:3_1k": "832x1248", "2:3_2k": "1664x2496", "2:3_4k": "2336x3504",
    "4:3_1k": "1152x864", "4:3_2k": "2304x1728", "4:3_4k": "3264x2448",
    "3:4_1k": "864x1152", "3:4_2k": "1728x2304", "3:4_4k": "2448x3264",
    "5:4_1k": "1120x896", "5:4_2k": "2240x1792", "5:4_4k": "3200x2560",
    "4:5_1k": "896x1120", "4:5_2k": "1792x2240", "4:5_4k": "2560x3200",
    "16:9_1k": "1280x720", "16:9_2k": "2560x1440", "16:9_4k": "3840x2160",
    "9:16_1k": "720x1280", "9:16_2k": "1440x2560", "9:16_4k": "2160x3840",
    "2:1_1k": "2048x1024", "2:1_2k": "2688x1344", "2:1_4k": "3840x1920",
    "1:2_1k": "1024x2048", "1:2_2k": "1344x2688", "1:2_4k": "1920x3840",
    "21:9_1k": "1456x624", "21:9_2k": "3024x1296", "21:9_4k": "3696x1584",
    "9:21_1k": "624x1456", "9:21_2k": "1296x3024", "9:21_4k": "1584x3696",
}


def detect_image_protocol(model: str, param_kind: str | None = None) -> ImageProtocol:
    if param_kind == "gpt-size":
        return ImageProtocol.GPT_SIZE
    if param_kind == "banana-ratio":
        return ImageProtocol.BANANA_RATIO
    if param_kind == "mj":
        return ImageProtocol.MJ
    m = str(model or "").lower()
    if m.endswith("-fal") or "/fal/" in m or "fal-ai/" in m:
        return ImageProtocol.FAL
    if "midjourney" in m or m == "mj" or m.startswith("mj"):
        return ImageProtocol.MJ
    if "nano-banana" in m or "nanobanana" in m:
        return ImageProtocol.BANANA_RATIO
    return ImageProtocol.GPT_SIZE


def aspect_to_gpt_size(aspect_ratio: str | None, size_level: str | None) -> str:
    ar = str(aspect_ratio or "").strip()
    lvl = str(size_level or "1K").lower()
    if not ar or ar in ("Auto", "AUTO", "empty"):
        return "auto"
    return GPT_SIZE_MAP.get(f"{ar}_{lvl}", "1024x1024")


def build_gpt_size_fields(
    *,
    prompt: str,
    model: str,
    n: int,
    aspect_ratio: str | None,
    image_size: str | None,
    size: str | None,
    quality: str | None,
    refs: list[str],
) -> MultipartFields:
    ar = str(aspect_ratio or "").strip()
    is_auto = not ar or ar in ("Auto", "AUTO", "empty")
    resolution = str(image_size or "2K").lower()
    px = size or aspect_to_gpt_size(ar, resolution)
    return MultipartFields(
        text={
            "prompt": prompt,
            "model": model,
            "n": str(n or 1),
            "quality": quality or "auto",
            "moderation": "auto",
            "size": px,
            "aspectRatio": "" if is_auto else ar,
            "resolution": resolution,
        },
        needs_white_placeholder=not bool(refs),
    )


def build_banana_json_payload(
    *,
    prompt: str,
    model: str,
    n: int,
    aspect_ratio: str | None,
    image_size: str | None = None,  # kept for backward compat signature, ignored
    quality: str | None = None,
) -> dict[str, Any]:
    ar = str(aspect_ratio or "").strip()
    is_auto = not ar or ar in ("Auto", "AUTO", "empty")
    # nano-banana API expects x-separator format (4x3), internal uses colon (4:3)
    api_size = "1x1" if is_auto else ar.replace(":", "x")
    return {
        "prompt": prompt,
        "model": model,
        "n": max(1, int(n or 1)),
        "size": api_size,
        "quality": quality or "medium",
    }


def build_mj_payload(
    *,
    prompt: str,
    base64_array: list[str],
    ar: str | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    return {
        "base64Array": base64_array,
        "instanceId": "",
        "modes": [],
        "notifyHook": "",
        "prompt": prompt,
        "remix": True,
        "state": "",
        "ar": ar,
        "no": None,
        "c": None,
        "s": None,
        "iw": None,
        "tile": False,
        "r": None,
        "video": False,
        "sw": None,
        "cw": None,
        "sv": None,
        "seed": seed,
    }
