"""Shared server-side video model limits used by submission and provider callers."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class VideoModelLimits:
    min_duration: int | None
    max_duration: int | None
    max_images: int
    max_videos: int
    max_audios: int
    max_mixed_references: int | None


def seedance_limits(model: str) -> VideoModelLimits:
    normalized = (model or "").lower().replace("_", "-").replace(".", "-")
    if "seedance-2-5" in normalized:
        return VideoModelLimits(4, 30, 30, 10, 10, None)
    if "seedance-2-0" in normalized:
        return VideoModelLimits(4, 15, 9, 3, 3, 12)
    return VideoModelLimits(None, None, 9, 3, 3, None)


def validate_seedance_request(model: str, params: dict, prompt: str) -> None:
    normalized = (model or "").lower().replace("_", "-").replace(".", "-")
    if "seedance" not in normalized:
        return
    limits = seedance_limits(model)
    duration = int(params["duration"])
    if (
        limits.min_duration is not None
        and limits.max_duration is not None
        and not limits.min_duration <= duration <= limits.max_duration
    ):
        generation = "2.5" if "seedance-2-5" in normalized else "2.0"
        raise ValueError(
            f"Seedance {generation} 生成时长必须在 "
            f"{limits.min_duration}–{limits.max_duration} 秒之间"
        )

    images = params["reference_images"]
    videos = params["reference_videos"]
    audios = params["reference_audios"]
    if (
        len(images) > limits.max_images
        or len(videos) > limits.max_videos
        or len(audios) > limits.max_audios
    ):
        generation = "2.5" if "seedance-2-5" in normalized else "2.0"
        raise ValueError(
            f"Seedance {generation} 最多参考 {limits.max_images} 张图、"
            f"{limits.max_videos} 个视频、{limits.max_audios} 个音频"
        )
    if (
        limits.max_mixed_references is not None
        and len(images) + len(videos) + len(audios) > limits.max_mixed_references
    ):
        raise ValueError(
            f"Seedance 2.0 混合参考素材总数不能超过 {limits.max_mixed_references} 个"
        )
    if "seedance-2-0" in normalized and _TIMESTAMP_RE.search(prompt):
        raise ValueError("Seedance 2.0 Prompt 不能使用时间戳，请改用镜头 1–N")
    if "seedance-2-5" in normalized:
        _validate_timeline(prompt, duration)


_TIMELINE_RE = re.compile(
    r"\[(?P<start_m>\d{1,2}):(?P<start_s>\d{2})\s*[-–—]\s*"
    r"(?P<end_m>\d{1,2}):(?P<end_s>\d{2})\]"
)
_TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{2}(?:\s*[-–—]|\])")


def _validate_timeline(prompt: str, duration: int) -> None:
    segments: list[tuple[int, int]] = []
    for match in _TIMELINE_RE.finditer(prompt):
        start = int(match.group("start_m")) * 60 + int(match.group("start_s"))
        end = int(match.group("end_m")) * 60 + int(match.group("end_s"))
        if start >= end:
            raise ValueError(f"Seedance 2.5 时间段起点必须早于终点: {match.group(0)}")
        if end > duration:
            raise ValueError(f"Seedance 2.5 时间段超过请求时长 {duration}s: {match.group(0)}")
        segments.append((start, end))
    for previous, current in zip(sorted(segments), sorted(segments)[1:]):
        if current[0] < previous[1]:
            raise ValueError("Seedance 2.5 时间段不能重叠")


@dataclass(frozen=True)
class KlingSpec:
    """可灵新版接口（contents[] + settings）各型号能力，契约见 provider-config.md「视频契约 — 可灵新版接口」。

    endpoints 是该型号在网关上挂的端点；omni 端点承载参考图 / 参考视频。
    max_images / max_videos 只算全能参考素材（refer_image / feature_video），首尾帧另计。
    """
    label: str
    endpoint_version: str  # 词元跳动路径段：4.x = v2，3.x = v1
    endpoints: tuple[str, ...]
    max_duration: int
    resolutions: tuple[str, ...]
    ratios: tuple[str, ...]
    max_frames: int  # 2 = 首 + 尾，1 = 仅首帧
    audio_toggle: bool  # settings.audio native/off；4.x 恒有声、Turbo 无该参数
    max_images: int
    max_videos: int
    min_duration: int = 3
    max_mixed_references: int | None = None


_KLING_4_RATIOS = ("21:9", "16:9", "9:16", "1:1")
_KLING_3_RATIOS = ("16:9", "9:16", "1:1")
_ALL_KLING_ENDPOINTS = ("text2video", "image2video", "omni-video")


def kling_spec(model: str) -> KlingSpec | None:
    """按模型 id 判可灵代际与变体；不是 3.x / 4.x 可灵返回 None。

    兼容词元跳动（kling-4.0-flash）与 EvoLink（kling-v4-flash-text-to-video）两种 id。
    """
    m = (model or "").lower().replace("_", "-")
    if not m.startswith("kling"):
        return None
    if re.match(r"^kling-v?4(?:[.-]0)?(?:-|$)", m):
        if "flash" in m:
            return KlingSpec("Kling 4.0 Flash", "v2", _ALL_KLING_ENDPOINTS, 20, ("720p",),
                             _KLING_4_RATIOS, 1, False, 10, 5, max_mixed_references=15)
        return KlingSpec("Kling 4.0", "v2", _ALL_KLING_ENDPOINTS, 30, ("720p", "1080p"),
                         _KLING_4_RATIOS, 2, False, 10, 5, max_mixed_references=15)
    if re.match(r"^kling-(?:v?3(?:[.-]0)?|o3)(?:-|$)", m):
        if "omni" in m or m.startswith("kling-o3"):
            return KlingSpec("Kling 3.0 Omni", "v1", ("omni-video",), 15, ("720p", "1080p", "4k"),
                             _KLING_3_RATIOS, 2, True, 7, 1)
        if "turbo" in m:
            return KlingSpec("Kling 3.0 Turbo", "v1", ("text2video", "image2video"), 15,
                             ("720p", "1080p"), _KLING_3_RATIOS, 1, False, 0, 0)
        return KlingSpec("Kling 3.0", "v1", ("text2video", "image2video"), 15,
                         ("720p", "1080p", "4k"), _KLING_3_RATIOS, 2, True, 0, 0)
    return None
