"""Timestamp-based local video edits on immutable project versions."""
from __future__ import annotations

import asyncio
from pathlib import Path

from .canvas_media_operations import _file_sha256
from .schemas import VideoTrim
from .video_encoder import Encoder, VideoError, command, metadata, resolve_encoder, smoke
from .video_operations import Submit, source


class VideoRenderer:
    def __init__(self):
        self._encoder = None
        self._probe_lock = asyncio.Lock()

    async def encoder(self, directory: Path) -> Encoder:
        async with self._probe_lock:
            if self._encoder is None:
                native = await asyncio.to_thread(resolve_encoder)
                await asyncio.wait_for(smoke(native, directory), timeout=45)
                self._encoder = native
        return self._encoder

    async def render(self, project: str, body: Submit, output: Path, progress):
        path, version = await asyncio.to_thread(source, project, body.version_id)
        if await asyncio.to_thread(_file_sha256, path) != version.sha256:
            raise VideoError("source_changed", "源视频与登记版本不一致")
        native = await self.encoder(output.parent)
        info = await metadata(native, path)
        return await encode(native, path, output, info, body.operation, progress)


async def encode(native, path, output, info, operation, progress):
    duration = info["duration_ms"]
    width, height = info["width"], info["height"]
    if not isinstance(operation, VideoTrim):
        raise VideoError("unsupported_operation", "不支持这种视频操作")
    if not (0 <= operation.start_ms < operation.end_ms <= duration):
        raise VideoError("invalid_range", "裁剪区间超出视频时长")
    duration = operation.end_ms - operation.start_ms
    timing = ["-ss", f"{operation.start_ms / 1000:.3f}", "-t", f"{duration / 1000:.3f}"]
    width, height = max(2, width // 2 * 2), max(2, height // 2 * 2)
    rate = max(700, round(700 * width * height / (320 * 192)))
    await command([
        native.ffmpeg, "-nostdin", "-v", "error", "-xerror", "-progress", "pipe:1",
        "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm",
        "-i", path, *timing, "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"fps=24,scale={width}:{height},setsar=1", *native.codec(rate),
        "-c:a", "aac", "-ar", "48000", "-map_metadata", "-1", "-map_chapters", "-1",
        "-movflags", "+faststart", output,
    ], progress=progress)
    result = await metadata(native, output)
    if (result["codec"] != "h264" or result["pix_fmt"] != "yuv420p"
            or (result["width"], result["height"]) != (width, height)
            or bool(result["audio_tracks"]) != bool(info["audio_tracks"])
            or abs(result["duration_ms"] - duration) > 42):
        raise VideoError("corrupt_output", "视频输出未通过格式或时长检查")
    return result

