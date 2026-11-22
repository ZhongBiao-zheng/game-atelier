"""Versioned native video tools. Only host-resolved local files enter these commands."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import tempfile
from typing import Callable


class VideoError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Encoder:
    ffmpeg: Path
    ffprobe: Path
    windows: bool

    def codec(self, kbps: int) -> list[str]:
        native = (["-c:v", "h264_mf", "-pix_fmt", "nv12", "-rate_control", "cbr"]
                  if self.windows else
                  ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-allow_sw", "1"])
        return [*native, "-b:v", f"{kbps}k"]


def resolve_encoder() -> Encoder:
    system = (platform.system(), platform.machine().lower())
    target = {("Darwin", "arm64"): "macos-arm64", ("Windows", "amd64"): "windows-x64",
              ("Windows", "x86_64"): "windows-x64"}.get(system)
    if not target:
        raise VideoError("unsupported_platform", "此平台没有视频处理运行包")
    app = Path(__file__).resolve().parents[3]
    override = os.environ.get("ATELIER_VIDEO_ENCODER_DIR") if (app / ".git").exists() else None
    folder = Path(override) if override else app / "video-encoder" / target
    windows = target == "windows-x64"
    names = [name + (".exe" if windows else "") for name in ("ffmpeg", "ffprobe")]
    try:
        hashes = dict(line.split(maxsplit=1)[::-1] for line in
                      (folder / "SHA256SUMS").read_text(encoding="utf-8").splitlines())
        for name in names:
            with (folder / name).open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != hashes.get(name):
                    raise VideoError("binary_integrity", "视频程序校验失败，请重新安装运行包")
    except (OSError, ValueError) as exc:
        if isinstance(exc, VideoError):
            raise
        raise VideoError("binary_missing", "找不到可用的视频程序或校验清单") from exc
    return Encoder(folder / names[0], folder / names[1], windows)


async def _terminate(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(process.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    await process.wait()


async def command(args: list, *, progress: Callable[[int], None] | None = None) -> bytes:
    options = {"creationflags": 0x00000200} if os.name == "nt" else {"start_new_session": True}
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, **options,
    ))
    try:
        process = await asyncio.shield(spawn)
    except asyncio.CancelledError:
        await _terminate(await spawn)
        raise
    except OSError as exc:
        raise VideoError("binary_launch", "视频程序无法启动，请检查运行包及执行权限") from exc

    async def drain(stream, limit):
        data = bytearray()
        while chunk := await stream.read(16384):
            data.extend(chunk)
            del data[:-limit]
        return bytes(data)

    async def stdout():
        if progress is None:
            return await drain(process.stdout, 512 * 1024)
        async for line in process.stdout:
            key, _, value = line.strip().partition(b"=")
            if key == b"out_time_us" and value.isdigit():
                progress(int(value) // 1000)
        return b""

    try:
        output, errors = await asyncio.gather(stdout(), drain(process.stderr, 8192))
        if await process.wait():
            detail = errors.decode(errors="replace").lower()
            if any(s in detail for s in ("space left", "disk full", "permission denied",
                                         "access is denied", "no such file or directory")):
                raise VideoError("storage", "视频文件路径不可写或磁盘空间不足")
            raise VideoError("codec_failed", "视频编解码失败")
        return output
    finally:
        await _terminate(process)


async def metadata(encoder: Encoder, path: Path) -> dict:
    raw = await command([encoder.ffprobe, "-v", "error", "-protocol_whitelist", "file",
                         "-format_whitelist", "mov,matroska,webm", "-show_streams", "-show_format",
                         "-of", "json", path])
    try:
        info = json.loads(raw)
        streams = info["streams"]
        video = next(s for s in streams if s["codec_type"] == "video")
        audio = [s for s in streams if s["codec_type"] == "audio"]
        if video["codec_name"] not in {"h264", "hevc", "vp8", "vp9"} or any(
            s["codec_name"] not in {"aac", "opus"} for s in audio
        ):
            raise VideoError("unsupported_codec", "不支持这种视频编码")
        rotation = next((int(d["rotation"]) for d in video.get("side_data_list", [])
                         if "rotation" in d), 0)
        w, h = int(video["width"]), int(video["height"])
        sar = video.get("sample_aspect_ratio", "1:1")
        if sar not in {"N/A", "0:1", None}:
            w = max(1, round(w * Fraction(sar.replace(":", "/"))))
        if rotation % 180:
            w, h = h, w
        return {"width": w, "height": h, "duration_ms": round(float(info["format"]["duration"]) * 1000),
                "audio_tracks": len(audio), "codec": video["codec_name"], "pix_fmt": video["pix_fmt"],
                "fps": video.get("avg_frame_rate"), "nominal_fps": video.get("r_frame_rate")}
    except (KeyError, StopIteration, TypeError, ValueError, OverflowError) as exc:
        if isinstance(exc, VideoError):
            raise
        raise VideoError("invalid_media", "视频文件损坏或缺少媒体信息") from exc


async def smoke(encoder: Encoder, directory: Path) -> None:
    try:
        with tempfile.TemporaryDirectory(dir=directory) as temp:
            path = Path(temp) / "检测 sample.mp4"
            try:
                await command([encoder.ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                               "testsrc2=size=320x192:rate=24:duration=0.25", *encoder.codec(420),
                               "-movflags", "+faststart", path])
            except VideoError as exc:
                if exc.code != "codec_failed":
                    raise
                message = ("系统 H.264 编码器不可用，请检查媒体组件；Windows N 版请安装媒体功能包并重启后重试。"
                           if encoder.windows else "系统 H.264 编码器不可用，请检查 VideoToolbox。")
                raise VideoError("system_encoder", message) from exc
            try:
                info = await metadata(encoder, path)
                if (info["codec"], info["pix_fmt"], info["duration_ms"]) != ("h264", "yuv420p", 250):
                    raise VideoError("invalid_media", "视频探测输出不符合预期")
                await command([encoder.ffmpeg, "-nostdin", "-v", "error", "-xerror", "-i", path,
                               "-f", "null", "-"])
            except VideoError as exc:
                if exc.code in {"binary_launch", "storage"}:
                    raise
                raise VideoError("corrupt_output", "视频编码器生成了损坏的输出") from exc
    except OSError as exc:
        raise VideoError("storage", "视频文件路径不可写或磁盘空间不足") from exc

