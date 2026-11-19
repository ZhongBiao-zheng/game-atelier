"""画布 Agent 看视频：等间隔取帧，拼成一张带时间码的联系表给模型看。

一张联系表而不是 N 张单帧：附图越多，之后每次调模型的请求越大（见 canvas_agent_vision 的附图规则）。
取帧按帧号顺序解码（不需要的帧只 grab），不按时间跳转：跳转落在关键帧上，等间隔会变成不等间隔。
核心不依赖 frames 插件（插件可以关掉），这里只留看视频需要的最小部分。
"""
from __future__ import annotations

import io
import math
from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

MAX_FRAMES = 9
DEFAULT_FRAMES = 6
SHEET_LONG_EDGE = 1024
LABEL_HEIGHT = 22
GAP = 4


class VideoReadError(ValueError):
    """视频读不出来（格式、编码或文件损坏）。"""


def probe(path: Path) -> dict:
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise VideoReadError("读不出这个视频")
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if count <= 0:
            count = 0
            while capture.grab():
                count += 1
    finally:
        capture.release()
    if width < 1 or height < 1 or count < 1 or not math.isfinite(fps) or fps <= 0:
        raise VideoReadError("读不出这个视频")
    return {"width": width, "height": height, "fps": round(fps, 3), "frame_count": count,
            "duration_ms": math.floor(count / fps * 1000)}


def sample_indices(info: dict, count: int, start_ms: int | None = None,
                   end_ms: int | None = None) -> list[tuple[int, int]]:
    """在 [start, end) 里等间隔取 count 个点（取每段的中点），返回 [(帧号, 毫秒)]，去重、升序。"""
    duration = info["duration_ms"]
    start = 0 if start_ms is None else start_ms
    end = duration if end_ms is None else end_ms
    if not 1 <= count <= MAX_FRAMES:
        raise ValueError(f"count 需在 1 到 {MAX_FRAMES} 之间")
    if not 0 <= start < end <= duration:
        raise ValueError(f"时间范围需在 0 到 {duration} 毫秒之间，且开始早于结束")
    fps, last = info["fps"], info["frame_count"] - 1
    picked: dict[int, int] = {}
    for i in range(count):
        t_ms = start + (end - start) * (2 * i + 1) / (2 * count)
        index = min(last, int(t_ms / 1000 * fps))
        picked.setdefault(index, round(index / fps * 1000))
    return sorted(picked.items())


def read_frames(path: Path, indices: list[int]) -> list[Image.Image]:
    wanted, found = set(indices), {}
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise VideoReadError("读不出这个视频")
        for index in range(max(indices) + 1):
            if index in wanted:
                ok, frame = capture.read()
                if ok:
                    found[index] = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), "RGB")
            else:
                ok = capture.grab()
            if not ok:
                raise VideoReadError(f"视频在第 {index} 帧读不出来")
    finally:
        capture.release()
    return [found[index] for index in indices]


def _label(t_ms: int) -> str:
    seconds = t_ms / 1000
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


def contact_sheet(frames: list[tuple[int, Image.Image]]) -> bytes:
    """[(毫秒, 帧)] → JPEG：近似方阵排布，每格下方标时间，整张长边不超过 SHEET_LONG_EDGE。"""
    columns = math.ceil(math.sqrt(len(frames)))
    rows = math.ceil(len(frames) / columns)
    width, height = frames[0][1].size
    scale = min(1.0, (SHEET_LONG_EDGE - GAP * (columns + 1)) / (columns * width),
                (SHEET_LONG_EDGE - (GAP + LABEL_HEIGHT) * rows - GAP) / (rows * height))
    cell = (max(1, int(width * scale)), max(1, int(height * scale)))
    sheet = Image.new("RGB", (GAP + columns * (cell[0] + GAP),
                              GAP + rows * (cell[1] + LABEL_HEIGHT + GAP)), "black")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=14)
    for position, (t_ms, frame) in enumerate(frames):
        x = GAP + (position % columns) * (cell[0] + GAP)
        y = GAP + (position // columns) * (cell[1] + LABEL_HEIGHT + GAP)
        sheet.paste(frame.resize(cell, Image.Resampling.LANCZOS), (x, y))
        draw.text((x + 4, y + cell[1] + 3), _label(t_ms), fill="white", font=font)
    buffer = io.BytesIO()
    sheet.save(buffer, "JPEG", quality=82)
    return buffer.getvalue()
