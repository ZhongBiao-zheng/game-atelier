"""视频读取：探测元数据、按帧号精确取帧。只依赖 OpenCV 与 Pillow。

取帧按顺序解码（不需要的帧只 grab 不解出像素），不用按时间跳转：跳转落在关键帧上，
等间隔抽帧会出现节奏不均。
"""
from __future__ import annotations

import base64
import io
import math
from pathlib import Path

import cv2
from PIL import Image

THUMB_EDGE = 160


def _open(path: Path) -> cv2.VideoCapture:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise ValueError("读不出这个视频")
    return capture


def probe(path: Path) -> dict:
    capture = _open(path)
    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if count <= 0:
            # 容器没写帧数时数一遍；只 grab 不解像素。
            count = 0
            while capture.grab():
                count += 1
    finally:
        capture.release()
    if width < 1 or height < 1 or count < 1:
        raise ValueError("读不出这个视频")
    fps = round(fps, 3) if math.isfinite(fps) and fps > 0 else 0.0
    return {"width": width, "height": height, "fps": fps, "frame_count": count,
            "duration_ms": math.floor(count / fps * 1000) if fps else None}


def read_frames(path: Path, indices: list[int], size: tuple[int, int]) -> list[Image.Image]:
    """按帧号取帧（RGB），缩放到 size。indices 必须升序。"""
    wanted = set(indices)
    last = max(indices)
    found: dict[int, Image.Image] = {}
    capture = _open(path)
    try:
        for index in range(last + 1):
            if index in wanted:
                ok, frame = capture.read()
                if ok:
                    found[index] = _to_image(frame, size)
            else:
                ok = capture.grab()
            if not ok:
                raise ValueError(f"视频在第 {index} 帧之后读不出来")
    finally:
        capture.release()
    return [found[index] for index in indices]


def _to_image(frame, size: tuple[int, int]) -> Image.Image:
    height, width = frame.shape[:2]
    if (width, height) != size:
        shrinking = size[0] * size[1] < width * height
        frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_CUBIC)
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), "RGB")


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def thumbnail_url(image: Image.Image) -> str:
    """面板预览用的小图：长边 160 的 JPEG data URL（沙箱允许 img-src data:）。"""
    thumb = image.copy()
    thumb.thumbnail((THUMB_EDGE, THUMB_EDGE))
    buffer = io.BytesIO()
    thumb.convert("RGB").save(buffer, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
