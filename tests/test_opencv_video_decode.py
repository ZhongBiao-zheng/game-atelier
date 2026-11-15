"""OpenCV 解码 H.264 的三平台冒烟（ADR-0037 补充：序列帧插件依赖 opencv-python-headless）。

夹具 `fixtures/video/h264-24f.mp4`：96×64、24 fps、24 帧、H.264 High / yuv420p，与画布生成的视频同一编码。
第 k 帧在 x = 4k 处有一个 4×8 的白块，用来确认按帧号读到的就是那一帧。
OpenCV 是主程序依赖，这里直接 import：缺了就该失败，不能被跳过。
"""
from pathlib import Path

import cv2
import numpy as np
import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "video" / "h264-24f.mp4"


def _block_x(frame: np.ndarray) -> float:
    green = frame[:, :, 1].astype(float)
    weights = (green * (green > 128)).sum(axis=0)
    assert weights.sum() > 0, "这一帧里没有白块"
    return float(weights.dot(np.arange(frame.shape[1])) / weights.sum()) - 1.5


def test_opencv_has_a_video_backend() -> None:
    info = cv2.getBuildInformation()
    assert "FFMPEG:                      YES" in info or "AVFoundation:                YES" in info


def test_decodes_every_h264_frame_in_order() -> None:
    capture = cv2.VideoCapture(str(FIXTURE))
    assert capture.isOpened()
    assert capture.get(cv2.CAP_PROP_FPS) == pytest.approx(24)
    positions = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        assert frame.shape == (64, 96, 3)
        positions.append(_block_x(frame))
    capture.release()
    assert len(positions) == 24
    assert positions == pytest.approx([4 * index for index in range(24)], abs=0.6)


def test_grab_skips_frames_without_losing_the_index() -> None:
    capture = cv2.VideoCapture(str(FIXTURE))
    for _ in range(10):
        assert capture.grab()
    ok, frame = capture.read()
    capture.release()
    assert ok
    assert _block_x(frame) == pytest.approx(40, abs=0.6)
