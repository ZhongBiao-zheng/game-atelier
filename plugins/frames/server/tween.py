"""补间：在相邻两帧之间补出中间帧。只依赖 OpenCV、numpy 与 Pillow。

- 交叉淡化：按预乘 alpha 线性混合，透明边不出黑边。只适合不位移的变化（淡入淡出、发光、烟雾）。
- 光流：DIS 稠密光流双向估计，两帧各自按 t 反向变形后混合。小位移可用；大幅度姿势变化、
  遮挡、像素画会糊或撕裂，那部分交给生成模型的首尾帧补间。
光流在合成到中性灰底的 RGB 上估计，再用同一组光流变形 RGBA 四个通道。
"""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

METHODS = ("crossfade", "flow")
MAX_BETWEEN = 15
MAX_FRAMES = 65
ASPECT_TOLERANCE = 0.01


def _premultiplied(image: Image.Image) -> np.ndarray:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3:4] / 255.0
    return np.concatenate([rgba[..., :3] * alpha, rgba[..., 3:4]], axis=-1)


def _from_premultiplied(array: np.ndarray) -> Image.Image:
    alpha = array[..., 3:4]
    rgb = np.where(alpha > 0, array[..., :3] * 255.0 / np.maximum(alpha, 1e-6), 0)
    out = np.concatenate([rgb, alpha], axis=-1)
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8), "RGBA")


def match_size(first: Image.Image, second: Image.Image) -> Image.Image:
    """第二帧缩放到第一帧的尺寸；宽高比不一致时拒绝，不拉伸。"""
    if first.size == second.size:
        return second
    ratio_a, ratio_b = first.width / first.height, second.width / second.height
    if abs(ratio_a - ratio_b) / ratio_a > ASPECT_TOLERANCE:
        raise ValueError("两帧的宽高比不一致，不能补间")
    return second.resize(first.size, Image.Resampling.LANCZOS)


def _gray(premultiplied: np.ndarray) -> np.ndarray:
    alpha = premultiplied[..., 3:4] / 255.0
    rgb = premultiplied[..., :3] + 128.0 * (1.0 - alpha)
    return cv2.cvtColor(np.clip(rgb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)


def between_pair(first: Image.Image, second: Image.Image, ts: list[float], method: str) -> list[Image.Image]:
    """first 与 second 之间、时间点为 ts（0–1）的中间帧。"""
    if method not in METHODS:
        raise ValueError("补间方式不对")
    a = _premultiplied(first)
    b = _premultiplied(match_size(first, second))
    if method == "crossfade":
        return [_from_premultiplied((1 - t) * a + t * b) for t in ts]
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    gray_a, gray_b = _gray(a), _gray(b)
    forward = dis.calc(gray_a, gray_b, None)
    backward = dis.calc(gray_b, gray_a, None)
    height, width = gray_a.shape
    grid_y, grid_x = np.mgrid[0:height, 0:width].astype(np.float32)
    frames = []
    for t in ts:
        from_a = cv2.remap(a, grid_x - t * forward[..., 0], grid_y - t * forward[..., 1],
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        from_b = cv2.remap(b, grid_x - (1 - t) * backward[..., 0], grid_y - (1 - t) * backward[..., 1],
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        frames.append(_from_premultiplied((1 - t) * from_a + t * from_b))
    return frames


def output_count(frame_count: int, between: int, keep_originals: bool) -> int:
    added = (frame_count - 1) * between
    return frame_count + added if keep_originals else added


def tween_sequence(frames: list[Image.Image], between: int, method: str,
                   keep_originals: bool = True) -> list[Image.Image]:
    """在每对相邻帧之间补 between 帧。keep_originals 为假时只返回补出的帧。"""
    if len(frames) < 2:
        raise ValueError("至少要两帧才能补间")
    if not 1 <= between <= MAX_BETWEEN:
        raise ValueError(f"每两帧之间补 1 到 {MAX_BETWEEN} 帧")
    total = output_count(len(frames), between, keep_originals)
    if total > MAX_FRAMES:
        raise ValueError(f"最多输出 {MAX_FRAMES} 帧，现在是 {total} 帧")
    base = frames[0].convert("RGBA")
    normalized = [base, *(match_size(base, frame).convert("RGBA") for frame in frames[1:])]
    ts = [index / (between + 1) for index in range(1, between + 1)]
    result: list[Image.Image] = []
    for current, following in zip(normalized, normalized[1:]):
        if keep_originals:
            result.append(current)
        result.extend(between_pair(current, following, ts, method))
    if keep_originals:
        result.append(normalized[-1])
    return result
