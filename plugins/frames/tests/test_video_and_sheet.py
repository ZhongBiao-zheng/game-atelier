"""视频取帧与拼表：纯函数，不碰数据目录（路由的端到端测试在 tests/test_frames_plugin.py）。"""
from __future__ import annotations

import importlib.util
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
FIXTURE = REPO / "tests" / "fixtures" / "video" / "h264-24f.mp4"  # 96×64、24 帧，第 k 帧白块在 x=4k


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


video = _load("frames_video_under_test", HERE.parent / "server" / "video.py")
sheet = _load("frames_sheet_under_test", HERE.parent / "server" / "sheet.py")
sprite_sheet = _load("sprite_sheet_for_frames_test", REPO / "plugins" / "sprite-sheet" / "server" / "sheet.py")


def block_x(image: Image.Image) -> float:
    green = np.asarray(image)[:, :, 1].astype(float)
    weights = (green * (green > 128)).sum(axis=0)
    return float(weights.dot(np.arange(image.width)) / weights.sum()) - 1.5


def test_probe_reads_size_rate_and_frame_count():
    assert video.probe(FIXTURE) == {"width": 96, "height": 64, "fps": 24.0, "frame_count": 24, "duration_ms": 1000}


def test_reads_exactly_the_requested_frames():
    images = video.read_frames(FIXTURE, [0, 5, 23], (96, 64))
    assert [image.size for image in images] == [(96, 64)] * 3
    assert [block_x(image) for image in images] == pytest.approx([0, 20, 92], abs=0.6)


def test_scales_frames_to_the_output_size():
    images = video.read_frames(FIXTURE, [10], (48, 32))
    assert images[0].size == (48, 32)
    assert block_x(images[0]) == pytest.approx(20, abs=1)


def test_reading_past_the_last_frame_fails_with_a_reason():
    with pytest.raises(ValueError, match="读不出来"):
        video.read_frames(FIXTURE, [3, 30], (96, 64))


def test_unreadable_file_is_rejected(tmp_path):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    with pytest.raises(ValueError, match="读不出这个视频"):
        video.probe(broken)


def test_thumbnail_is_a_small_jpeg_data_url():
    url = video.thumbnail_url(Image.new("RGB", (1280, 720), (10, 20, 30)))
    assert url.startswith("data:image/jpeg;base64,")
    import base64
    thumb = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert max(thumb.size) == video.THUMB_EDGE


def opaque_frames(count: int, size=(10, 6)) -> list[Image.Image]:
    return [Image.new("RGB", size, (index * 40 % 256, 90, 160)) for index in range(count)]


def test_sheet_puts_frames_in_rows_with_transparent_gutters():
    png, data = sheet.compose(opaque_frames(5), columns=3)
    image = Image.open(io.BytesIO(png))
    assert image.size == (3 * 10 + 2 * sheet.GUTTER, 2 * 6 + sheet.GUTTER)
    assert [(frame["x"], frame["y"]) for frame in data["frames"]] == [(0, 0), (12, 0), (24, 0), (0, 8), (12, 8)]
    assert data["meta"] == {"size": {"w": 34, "h": 14}, "columns": 3, "rows": 2, "cell": {"w": 10, "h": 6},
                            "anchor": {"x": 5, "y": 6}}
    assert image.getpixel((10, 0))[3] == 0, "格间是全透明的"


def test_sprite_sheet_auto_detects_frames_even_when_they_are_fully_opaque():
    png, data = sheet.compose(opaque_frames(5), columns=3)
    found = sprite_sheet.detect_frames(Image.open(io.BytesIO(png)).convert("RGBA"))
    assert (found["columns"], found["rows"], len(found["frames"])) == (3, 2, 5)
    assert found["frames"] == [{key: frame[key] for key in ("x", "y", "w", "h")} for frame in data["frames"]]


def test_sheet_rejects_oversized_output():
    with pytest.raises(ValueError, match="长边超过"):
        sheet.compose(opaque_frames(3, size=(4000, 10)), columns=3)
