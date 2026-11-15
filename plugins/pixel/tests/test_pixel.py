"""像素化算法：纯函数，不碰数据目录（路由的端到端测试在 tests/test_pixel_plugin.py）。"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("pixel_under_test", HERE.parent / "server" / "pixel.py")
pixel = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = pixel  # dataclass 需要模块已登记
_spec.loader.exec_module(pixel)

RED, BLUE, WHITE = (220, 40, 40), (40, 60, 220), (255, 255, 255)


def settings(**overrides):
    return pixel.Settings.parse({"size_mode": "block", "block": 4, "palette": {"kind": "auto", "colors": 8}, **overrides})


def blocks(cells: list[list[tuple[int, int, int]]], size: int = 4) -> Image.Image:
    rows = [np.concatenate([np.full((size, size, 3), color, np.uint8) for color in row], axis=1) for row in cells]
    return Image.fromarray(np.concatenate(rows, axis=0), "RGB").convert("RGBA")


def colors_of(image: Image.Image) -> set[tuple[int, ...]]:
    array = np.asarray(image)
    return {tuple(pixel_) for pixel_ in array[array[..., 3] > 0][:, :3].tolist()}


@pytest.mark.parametrize(("size", "overrides", "expected"), [
    ((1280, 720), {"size_mode": "long_edge", "long_edge": 64}, (64, 36)),
    ((50, 30), {"size_mode": "long_edge", "long_edge": 64}, (50, 30)),   # 不放大源图
    ((30, 18), {"size_mode": "block", "block": 4}, (8, 5)),              # 7.5 → 8，4.5 → 5
    ((3, 3), {"size_mode": "block", "block": 8}, (1, 1)),
])
def test_target_size(size, overrides, expected):
    assert pixel.target_size(*size, pixel.Settings.parse(overrides)) == expected


def test_mode_downsample_takes_the_majority_colour_of_each_block():
    image = np.full((4, 4, 3), RED, np.uint8)
    image[0, 0] = BLUE  # 1 蓝 15 红
    source = Image.fromarray(np.concatenate([image, np.full((4, 4, 3), BLUE, np.uint8)], axis=1), "RGB")
    (out,), _ = pixel.pixelate([source], settings())
    assert out.size == (2, 1)
    assert [tuple(out.getpixel((x, 0))[:3]) for x in range(2)] == [RED, BLUE]


def test_average_downsample_mixes_then_quantizes():
    source = blocks([[RED, BLUE]], size=4).resize((4, 4), Image.Resampling.NEAREST)  # 左红右蓝
    (out,), (palette,) = pixel.pixelate([source], settings(downsample="average", block=4,
                                                           palette={"kind": "auto", "colors": 2}))
    assert out.size == (1, 1)
    assert tuple(out.getpixel((0, 0))[:3]) in {tuple(color) for color in palette.tolist()}


def test_palette_is_reproducible_and_ignores_transparent_pixels():
    rng = np.random.default_rng(3)
    array = np.zeros((64, 64, 4), np.uint8)
    array[16:48, 16:48, :3] = rng.integers(0, 255, (32, 32, 3))
    array[16:48, 16:48, 3] = 255
    array[:16, :, :3] = (0, 255, 0)  # 透明区域里藏一个纯绿，不能进调色板
    image = Image.fromarray(array, "RGBA")
    first = pixel.auto_palette([image], 8, 128)
    second = pixel.auto_palette([image], 8, 128)
    assert np.array_equal(first, second)
    assert len(first) <= 8
    assert not any(tuple(color) == (0, 255, 0) for color in first.tolist())


def test_alpha_threshold_binarizes_transparency():
    array = np.zeros((2, 4, 4), np.uint8)
    array[..., :3] = RED
    array[:, :2, 3] = 127
    array[:, 2:, 3] = 128
    (out,), _ = pixel.pixelate([Image.fromarray(array, "RGBA")], settings(block=2, alpha_threshold=128))
    assert [out.getpixel((x, 0))[3] for x in range(2)] == [0, 255]


def test_upscale_is_integer_nearest_neighbour():
    small = blocks([[RED, BLUE], [WHITE, RED]], size=1)
    big = pixel.upscale(small, 4)
    assert big.size == (8, 8)
    array = np.asarray(big)
    for y in range(0, 8, 4):
        for x in range(0, 8, 4):
            assert len({tuple(v) for v in array[y:y + 4, x:x + 4].reshape(-1, 4).tolist()}) == 1


def test_shared_palette_keeps_frames_on_the_same_colours():
    rng = np.random.default_rng(5)
    frames = []
    for shift in (0, 6):
        array = np.full((32, 32, 3), 30, np.uint8)
        array[8:24, 8:24] = np.clip(rng.integers(100, 230, (16, 16, 3)) + shift, 0, 255)
        frames.append(Image.fromarray(array, "RGB"))
    outputs, palettes = pixel.pixelate(frames, settings(palette={"kind": "auto", "colors": 6}))
    assert np.array_equal(palettes[0], palettes[1])
    allowed = {tuple(color) for color in palettes[0].tolist()}
    assert colors_of(outputs[0]) <= allowed and colors_of(outputs[1]) <= allowed
    separate, own = pixel.pixelate(frames, settings(palette={"kind": "auto", "colors": 6}, shared_palette=False))
    assert len(own) == 2


@pytest.mark.parametrize("bad", [
    {"size_mode": "pixels"}, {"long_edge": 4}, {"block": 1}, {"palette": {"kind": "auto", "colors": 1}},
    {"upscale": 32}, {"alpha_threshold": 0}, {"downsample": "nearest"}, {"long_edge": True},
])
def test_rejects_bad_settings(bad):
    with pytest.raises(ValueError):
        pixel.Settings.parse(bad)


def test_large_source_stays_within_the_time_budget():
    rng = np.random.default_rng(7)
    image = Image.fromarray(rng.integers(0, 255, (1024, 1024, 3), dtype=np.uint8), "RGB")
    started = time.perf_counter()
    pixel.pixelate([image], pixel.Settings.parse({"size_mode": "long_edge", "long_edge": 64,
                                                  "palette": {"kind": "auto", "colors": 16}}))
    # 方案假设 7：单帧 1024² 目标 0.5 秒；CI 机器慢，这里留 4 倍余量只防数量级退化。
    assert time.perf_counter() - started < 2.0
