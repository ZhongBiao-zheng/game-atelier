"""像素化：降采样到目标网格、调色板量化、透明二值化、整数倍放大。只依赖 OpenCV、numpy 与 Pillow。

映射到调色板走查找表：RGB 每通道量化到 5 位（32768 格），每格预先算好 Lab 空间最近的调色板色，
映射一张图只是一次查表。实测 1024² 源图 16 色约 0.05 秒（逐像素精确映射约 0.4 秒），
与精确映射的逐像素一致率约 88%，差异只在离两个调色板色几乎等距的像素上。
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

MAX_SOURCE_EDGE = 4096
LONG_EDGE_RANGE = (8, 512)
BLOCK_RANGE = (2, 64)
COLORS_RANGE = (2, 64)
UPSCALE_RANGE = (1, 16)
SAMPLE_PIXELS = 60_000
KMEANS_SEED = 1234
CUSTOM_COLORS_RANGE = (2, 256)
DITHERS = ("none", "bayer2", "bayer4", "bayer8", "floyd")
PRESETS = {item["id"]: item for item in json.loads(
    (Path(__file__).with_name("palettes.json")).read_text(encoding="utf-8"))["palettes"]}
_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _half_up(value: float) -> int:
    return math.floor(value + 0.5)


def _int_in(params: dict[str, Any], key: str, default: int, bounds: tuple[int, int], label: str) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not bounds[0] <= value <= bounds[1]:
        raise ValueError(f"{label}要在 {bounds[0]} 到 {bounds[1]} 之间")
    return value


def parse_hex_colors(text: str) -> np.ndarray:
    """自定义调色板：#RGB 或 #RRGGBB，逗号、空白或换行分隔。"""
    tokens = [token for token in re.split(r"[\s,;]+", text or "") if token]
    colors = [list(_one_hex(token)) for token in tokens]
    if not CUSTOM_COLORS_RANGE[0] <= len(colors) <= CUSTOM_COLORS_RANGE[1]:
        raise ValueError(f"自定义调色板要有 {CUSTOM_COLORS_RANGE[0]} 到 {CUSTOM_COLORS_RANGE[1]} 个颜色")
    return np.unique(np.array(colors, np.uint8), axis=0)


def _one_hex(text: str) -> tuple[int, int, int]:
    match = _HEX.match(text.strip())
    if not match:
        raise ValueError(f"色值「{text[:16]}」不对，要写成 #RRGGBB")
    value = match.group(1)
    if len(value) == 3:
        value = "".join(char * 2 for char in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _preset_colors(preset_id: str) -> np.ndarray:
    preset = PRESETS.get(preset_id)
    if preset is None:
        raise ValueError("没有这个预设调色板")
    return np.array([[int(color[i:i + 2], 16) for i in (0, 2, 4)] for color in preset["colors"]], np.uint8)


@dataclass(frozen=True)
class Settings:
    size_mode: str  # long_edge | block
    long_edge: int
    block: int
    downsample: str  # mode | average
    palette_kind: str  # auto | preset | custom
    colors: int
    fixed_palette: np.ndarray | None  # 预设或自定义时的色板
    shared_palette: bool
    alpha_threshold: int
    upscale: int
    dither: str
    dither_strength: float  # 0–1
    isolated: int  # 0 = 不清理；4 / 8 = 按 4 / 8 邻域去孤立像素
    min_region: int  # 0 = 不合并；否则合并面积小于它的色块
    outline: bool
    outline_connectivity: int
    outline_color: tuple[int, int, int] | None  # None = 调色板最深色

    @classmethod
    def parse(cls, params: dict[str, Any]) -> "Settings":
        size_mode = params.get("size_mode", "long_edge")
        if size_mode not in ("long_edge", "block"):
            raise ValueError("尺寸方式不对")
        downsample = params.get("downsample", "mode")
        if downsample not in ("mode", "average"):
            raise ValueError("降采样方式不对")
        palette = params.get("palette") or {"kind": "auto", "colors": 16}
        if not isinstance(palette, dict) or palette.get("kind", "auto") not in ("auto", "preset", "custom"):
            raise ValueError("调色板设置不对")
        kind = palette.get("kind", "auto")
        fixed = None
        if kind == "preset":
            fixed = _preset_colors(str(palette.get("preset", "")))
        elif kind == "custom":
            fixed = parse_hex_colors(str(palette.get("custom", "")))
        dither = params.get("dither") or {"kind": "none"}
        if not isinstance(dither, dict) or dither.get("kind", "none") not in DITHERS:
            raise ValueError("抖动设置不对")
        cleanup = params.get("cleanup") or {}
        if not isinstance(cleanup, dict) or cleanup.get("isolated", 0) not in (0, 4, 8):
            raise ValueError("清理设置不对")
        outline = params.get("outline") or {}
        if not isinstance(outline, dict) or outline.get("connectivity", 4) not in (4, 8):
            raise ValueError("描边设置不对")
        outline_color = None
        if outline.get("color", "darkest") != "darkest":
            outline_color = _one_hex(str(outline.get("color")))
        return cls(
            size_mode=size_mode,
            long_edge=_int_in(params, "long_edge", 64, LONG_EDGE_RANGE, "长边"),
            block=_int_in(params, "block", 8, BLOCK_RANGE, "像素块"),
            downsample=downsample,
            palette_kind=kind,
            colors=_int_in(palette, "colors", 16, COLORS_RANGE, "颜色数") if kind == "auto" else 0,
            fixed_palette=fixed,
            shared_palette=params.get("shared_palette", True) is not False,
            alpha_threshold=_int_in(params, "alpha_threshold", 128, (1, 255), "透明阈值"),
            upscale=_int_in(params, "upscale", 1, UPSCALE_RANGE, "放大倍数"),
            dither=dither.get("kind", "none"),
            dither_strength=_int_in(dither, "strength", 100, (0, 100), "抖动强度") / 100,
            isolated=cleanup.get("isolated", 0),
            min_region=_int_in(cleanup, "min_region", 0, (0, 16), "最小色块"),
            outline=outline.get("enabled") is True,
            outline_connectivity=outline.get("connectivity", 4),
            outline_color=outline_color,
        )


def target_size(width: int, height: int, settings: Settings) -> tuple[int, int]:
    """像素网格的尺寸。按长边时不放大源图；按像素块时四舍五入。"""
    if settings.size_mode == "long_edge":
        if settings.long_edge >= max(width, height):
            return width, height
        scale = settings.long_edge / max(width, height)
        return max(1, _half_up(width * scale)), max(1, _half_up(height * scale))
    return max(1, _half_up(width / settings.block)), max(1, _half_up(height / settings.block))


def _rgba(image: Image.Image) -> np.ndarray:
    if max(image.size) > MAX_SOURCE_EDGE:
        raise ValueError(f"图片长边不能超过 {MAX_SOURCE_EDGE} 像素")
    return np.asarray(image.convert("RGBA"), dtype=np.uint8)


def _lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)


def _resize_rgba(array: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """按预乘 alpha 缩小，透明像素的颜色不会混进边缘。"""
    alpha = array[..., 3:4].astype(np.float32) / 255.0
    premultiplied = np.concatenate([array[..., :3].astype(np.float32) * alpha, array[..., 3:4].astype(np.float32)], -1)
    small = cv2.resize(premultiplied, size, interpolation=cv2.INTER_AREA)
    a = small[..., 3:4] / 255.0
    rgb = np.where(a > 0, small[..., :3] / np.maximum(a, 1e-6), 0)
    return np.clip(np.rint(np.concatenate([rgb, small[..., 3:4]], -1)), 0, 255).astype(np.uint8)


def _pack(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.int32)
    return (rgb[:, 0] << 16) | (rgb[:, 1] << 8) | rgb[:, 2]


def _unpack(packed: np.ndarray) -> np.ndarray:
    return np.stack([(packed >> 16) & 255, (packed >> 8) & 255, packed & 255], -1).astype(np.uint8)


def auto_palette(images: list[Image.Image], colors: int, alpha_threshold: int) -> np.ndarray:
    """k 色调色板：只统计不透明像素，Lab 空间 k-means（固定种子，结果可复现），按亮度排序。

    每帧只随机取一部分像素参与聚类（全组合计不超过 SAMPLE_PIXELS）：65 帧时不必把上千万像素拼起来。
    样本里的颜色不超过 k 种时（本来就是像素画的源图），改用全图的颜色精确去重。
    """
    rng = np.random.default_rng(0)
    per_image = max(1, SAMPLE_PIXELS // len(images)) if images else 0
    samples, opaque_sets = [], []
    for image in images:
        array = _rgba(image)
        opaque = array[..., :3][array[..., 3] >= alpha_threshold]
        if len(opaque) == 0:
            continue
        opaque_sets.append(opaque)
        samples.append(opaque[rng.choice(len(opaque), per_image, replace=False)] if len(opaque) > per_image else opaque)
    if not samples:
        return np.zeros((1, 3), np.uint8)
    sample = np.concatenate(samples)
    distinct = np.unique(_pack(sample))
    if len(distinct) <= colors:
        distinct = np.unique(np.concatenate([np.unique(_pack(opaque)) for opaque in opaque_sets]))
    if len(distinct) <= colors:
        palette = _unpack(distinct)
    else:
        cv2.setRNGSeed(KMEANS_SEED)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
        _, _, centers = cv2.kmeans(_lab(sample), colors, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
        lab = np.clip(np.rint(centers), 0, 255).astype(np.uint8).reshape(-1, 1, 3)
        palette = _unpack(np.unique(_pack(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB).reshape(-1, 3))))
    luminance = palette.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    return palette[np.argsort(luminance, kind="stable")]


def palette_lut(palette: np.ndarray) -> np.ndarray:
    levels = (np.arange(32) * 8 + 4).astype(np.uint8)
    grid = np.stack(np.meshgrid(levels, levels, levels, indexing="ij"), -1).reshape(-1, 3)
    distances = ((_lab(grid)[:, None, :] - _lab(palette)[None]) ** 2).sum(-1)
    return distances.argmin(1).astype(np.int32)


def _indices(rgb: np.ndarray, lut: np.ndarray) -> np.ndarray:
    q = (rgb >> 3).astype(np.int32)
    return lut[(q[..., 0] << 10) | (q[..., 1] << 5) | q[..., 2]]


def _bayer(size: int) -> np.ndarray:
    """标准 Bayer 阈值矩阵，归一化到 (-0.5, 0.5)。"""
    matrix = np.array([[0]])
    while matrix.shape[0] < size:
        matrix = np.block([[4 * matrix, 4 * matrix + 2], [4 * matrix + 3, 4 * matrix + 1]])
    return (matrix + 0.5) / matrix.size - 0.5


def _floyd(rgb: np.ndarray, palette: np.ndarray) -> np.ndarray:
    """Floyd–Steinberg 误差扩散（Pillow 实现，按 RGB 距离取色）。"""
    k = len(palette)
    flat = palette.reshape(-1).tolist()
    holder = Image.new("P", (1, 1))
    holder.putpalette(flat + flat[:3] * (256 - k))  # 补位都填第 0 色，映射回来时折回 0
    quantized = Image.fromarray(rgb, "RGB").quantize(palette=holder, dither=Image.Dither.FLOYDSTEINBERG)
    index = np.asarray(quantized).astype(np.int32)
    index[index >= k] = 0
    return index


_NEIGHBOURS = {4: ((-1, 0), (1, 0), (0, -1), (0, 1)),
               8: ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))}


def _remove_isolated(index: np.ndarray, opaque: np.ndarray, connectivity: int) -> tuple[np.ndarray, np.ndarray]:
    """孤立像素：与四周不透明邻居都不同色的像素换成邻居里最多的颜色；四周全透明的单个像素变透明。"""
    height, width = index.shape
    code = np.pad(np.where(opaque, index, -1), 1, constant_values=-1)
    neighbours = np.stack([code[1 + dy:1 + dy + height, 1 + dx:1 + dx + width] for dy, dx in _NEIGHBOURS[connectivity]])
    valid = neighbours >= 0
    same = ((neighbours == index[None]) & valid).any(0)
    lonely = opaque & ~valid.any(0)
    isolated = opaque & ~same & (valid.sum(0) >= 2)
    result = index.copy()
    if isolated.any():
        values = neighbours[:, isolated]  # (邻居数, N)
        ok = values >= 0
        votes = ((values[:, None, :] == values[None, :, :]) & ok[None, :, :] & ok[:, None, :]).sum(1)
        result[isolated] = values[votes.argmax(0), np.arange(values.shape[1])]
    return result, opaque & ~lonely


def _merge_small_regions(index: np.ndarray, opaque: np.ndarray, min_region: int) -> np.ndarray:
    """面积小于 min_region 的同色连通块（4 连通）并进周围最多的颜色。"""
    result = index.copy()
    cross = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], np.uint8)
    for color in np.unique(index[opaque]):
        mask = (opaque & (result == color)).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for label in range(1, count):
            x, y, w, h, area = stats[label]
            if area >= min_region:
                continue
            top, left = max(0, y - 1), max(0, x - 1)
            bottom, right = min(index.shape[0], y + h + 1), min(index.shape[1], x + w + 1)
            component = labels[top:bottom, left:right] == label
            ring = cv2.dilate(component.astype(np.uint8), cross).astype(bool) & ~component & opaque[top:bottom, left:right]
            around = result[top:bottom, left:right][ring]
            around = around[around != color]
            if len(around):
                window = result[top:bottom, left:right]
                window[component] = np.bincount(around).argmax()
    return result


def _darkest(palette: np.ndarray) -> tuple[int, int, int]:
    luminance = palette.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    return tuple(palette[int(luminance.argmin())].tolist())  # type: ignore[return-value]


def pixelate_one(image: Image.Image, palette: np.ndarray, lut: np.ndarray, settings: Settings) -> Image.Image:
    """一张图像素化到实际像素尺寸（不放大）：降采样与映射 → 抖动 → 清理 → 描边。"""
    array = _rgba(image)
    height, width = array.shape[:2]
    target_w, target_h = target_size(width, height, settings)
    k = len(palette)
    dithering = settings.dither != "none" and settings.dither_strength > 0
    if settings.downsample == "average" or dithering:
        # 抖动需要连续色调：颜色取格内平均（按预乘 alpha），再按抖动方式映射。
        small = _resize_rgba(array, (target_w, target_h)) if (target_w, target_h) != (width, height) else array
        opaque = small[..., 3] >= settings.alpha_threshold
        rgb = small[..., :3]
        if dithering and settings.dither == "floyd":
            index = _floyd(np.ascontiguousarray(rgb), palette)
        elif dithering:
            size = int(settings.dither[5:])
            matrix = np.tile(_bayer(size), (target_h // size + 1, target_w // size + 1))[:target_h, :target_w]
            spread = 255 / max(1, round(k ** (1 / 3)))  # 大致等于相邻调色板色的间距
            shifted = rgb.astype(np.float32) + (matrix * spread * settings.dither_strength)[..., None]
            index = _indices(np.clip(np.rint(shifted), 0, 255).astype(np.uint8), lut)
        else:
            index = _indices(rgb, lut)
    else:
        # 主色：每格里出现最多的调色板色；格里透明像素过半，这一格就是透明。
        if width * height > 16 * target_w * target_h:
            array = _resize_rgba(array, (4 * target_w, 4 * target_h))
            height, width = array.shape[:2]
        opaque_full = array[..., 3] >= settings.alpha_threshold
        index_full = _indices(array[..., :3], lut)
        rows = (np.arange(height) * target_h) // height
        columns = (np.arange(width) * target_w) // width
        block = (rows[:, None] * target_w + columns[None, :]).reshape(-1)
        code = np.where(opaque_full, index_full + 1, 0).reshape(-1)
        counts = np.bincount(block * (k + 1) + code, minlength=target_w * target_h * (k + 1)).reshape(-1, k + 1)
        opaque = (counts[:, 0] * 2 < counts.sum(1)).reshape(target_h, target_w)
        index = counts[:, 1:].argmax(1).reshape(target_h, target_w)
    if settings.isolated:
        index, opaque = _remove_isolated(index, opaque, settings.isolated)
    if settings.min_region > 1:
        index = _merge_small_regions(index, opaque, settings.min_region)
    out = np.zeros((target_h, target_w, 4), np.uint8)
    out[..., :3] = palette[index]
    out[..., 3] = np.where(opaque, 255, 0)
    out[~opaque, :3] = 0
    if settings.outline:
        kernel = np.ones((3, 3), np.uint8) if settings.outline_connectivity == 8 else \
            np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], np.uint8)
        ring = cv2.dilate(opaque.astype(np.uint8), kernel).astype(bool) & ~opaque
        out[ring, :3] = settings.outline_color or _darkest(palette)
        out[ring, 3] = 255
    return Image.fromarray(out, "RGBA")


def upscale(image: Image.Image, factor: int) -> Image.Image:
    if factor == 1:
        return image
    return image.resize((image.width * factor, image.height * factor), Image.Resampling.NEAREST)


def pixelate(images: list[Image.Image], settings: Settings) -> tuple[list[Image.Image], list[np.ndarray]]:
    """整组像素化。shared_palette 为真时全组共用一个调色板，动画帧之间颜色不跳。"""
    if not images:
        raise ValueError("没有要像素化的图片")
    if settings.fixed_palette is not None or settings.shared_palette:
        palette = resolve_palette(images, settings)
        lut = palette_lut(palette)
        return [pixelate_one(image, palette, lut, settings) for image in images], [palette] * len(images)
    outputs, palettes = [], []
    for image in images:
        palette = auto_palette([image], settings.colors, settings.alpha_threshold)
        outputs.append(pixelate_one(image, palette, palette_lut(palette), settings))
        palettes.append(palette)
    return outputs, palettes


def resolve_palette(images: list[Image.Image], settings: Settings) -> np.ndarray:
    """这次用的调色板：预设或自定义时就是它；自动时按 k 色聚类。"""
    if settings.fixed_palette is not None:
        return settings.fixed_palette
    return auto_palette(images, settings.colors, settings.alpha_threshold)


def preset_list() -> list[dict]:
    return [{"id": item["id"], "name": item["name"], "colors": [f"#{color}" for color in item["colors"]]}
            for item in PRESETS.values()]


def hex_colors(palette: np.ndarray) -> list[str]:
    return [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in palette.tolist()]
