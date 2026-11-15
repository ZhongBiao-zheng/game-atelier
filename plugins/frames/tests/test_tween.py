"""补间算法：交叉淡化与光流。纯函数，不碰数据目录。"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("frames_tween_under_test", HERE.parent / "server" / "tween.py")
tween = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tween)

H, W = 64, 96
PATCH = (np.random.default_rng(1).random((16, 16, 3)) * 255).astype(np.uint8)


def textured(x: int, *, background_alpha: int = 255) -> Image.Image:
    """深色底上一块带纹理的方块，左上角在 (x, 24)。"""
    array = np.zeros((H, W, 4), np.uint8)
    array[..., :3] = 40
    array[..., 3] = background_alpha
    array[24:40, x:x + 16, :3] = PATCH
    array[24:40, x:x + 16, 3] = 255
    return Image.fromarray(array, "RGBA")


def error(image: Image.Image, expected: Image.Image) -> float:
    a = np.asarray(image, dtype=float)[..., :3]
    b = np.asarray(expected, dtype=float)[..., :3]
    return float(np.abs(a - b).mean())


def test_crossfade_endpoints_and_midpoint():
    a, b = Image.new("RGBA", (4, 4), (200, 0, 0, 255)), Image.new("RGBA", (4, 4), (0, 0, 100, 255))
    start, middle, end = tween.between_pair(a, b, [0.0, 0.5, 1.0], "crossfade")
    assert start.getpixel((0, 0)) == (200, 0, 0, 255)
    assert middle.getpixel((0, 0)) == (100, 0, 50, 255)
    assert end.getpixel((0, 0)) == (0, 0, 100, 255)


def test_crossfade_blends_in_premultiplied_alpha_without_dark_fringes():
    opaque_red = Image.new("RGBA", (2, 2), (255, 0, 0, 255))
    transparent = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
    (middle,) = tween.between_pair(opaque_red, transparent, [0.5], "crossfade")
    assert middle.getpixel((0, 0)) == (255, 0, 0, 128), "颜色保持纯红，只有透明度减半"


def test_flow_moves_the_content_instead_of_ghosting_it():
    a, b, ideal = textured(20), textured(36), textured(28)
    (flow,) = tween.between_pair(a, b, [0.5], "flow")
    (fade,) = tween.between_pair(a, b, [0.5], "crossfade")
    assert error(flow, ideal) < 1.0
    assert error(fade, ideal) > 4 * error(flow, ideal)


def test_flow_carries_transparency_with_the_motion():
    a, b = textured(20, background_alpha=0), textured(36, background_alpha=0)
    (middle,) = tween.between_pair(a, b, [0.5], "flow")
    alpha = np.asarray(middle)[..., 3]
    assert alpha[32, 28 + 8] > 200, "方块移到中间位置，那里不透明"
    assert alpha[32, 5] < 30 and alpha[32, 90] < 30, "背景仍然透明"


def test_sequence_interleaves_originals_and_in_betweens():
    frames = [textured(x) for x in (10, 30, 50)]
    result = tween.tween_sequence(frames, 1, "crossfade")
    assert len(result) == 5
    assert np.array_equal(np.asarray(result[2]), np.asarray(frames[1].convert("RGBA")))
    only_new = tween.tween_sequence(frames, 2, "crossfade", keep_originals=False)
    assert len(only_new) == 4


def test_sequence_limits():
    with pytest.raises(ValueError, match="至少要两帧"):
        tween.tween_sequence([textured(10)], 1, "flow")
    with pytest.raises(ValueError, match="补 1 到 15 帧"):
        tween.tween_sequence([textured(10)] * 2, 16, "flow")
    with pytest.raises(ValueError, match="最多输出 65 帧，现在是 81 帧"):
        tween.tween_sequence([textured(10)] * 6, 15, "crossfade")
    with pytest.raises(ValueError, match="补间方式"):
        tween.between_pair(textured(10), textured(20), [0.5], "morph")


def test_second_frame_is_resized_only_when_the_aspect_matches():
    a = Image.new("RGBA", (96, 64), (0, 0, 0, 255))
    assert tween.match_size(a, Image.new("RGBA", (192, 128))).size == (96, 64)
    with pytest.raises(ValueError, match="宽高比不一致"):
        tween.match_size(a, Image.new("RGBA", (100, 100)))
