"""画布 Agent 看视频：等间隔取到的是哪几帧、联系表的排布与尺寸、读不出与越界。"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_video as video

FIXTURE = Path(__file__).parent / "fixtures" / "video" / "h264-24f.mp4"  # 24 帧，第 k 帧白块在 x=4k


def _block_x(frame: Image.Image) -> int:
    return int(np.argmax(np.asarray(frame.convert("L")).max(axis=0) > 200))


def test_probe_reads_the_container():
    assert video.probe(FIXTURE) == {"width": 96, "height": 64, "fps": 24.0, "frame_count": 24,
                                    "duration_ms": 1000}


def test_frames_are_evenly_spaced_and_decoded_exactly():
    info = video.probe(FIXTURE)
    picks = video.sample_indices(info, 6)
    assert picks == [(2, 83), (6, 250), (10, 417), (14, 583), (18, 750), (22, 917)]
    frames = video.read_frames(FIXTURE, [index for index, _ in picks])
    assert [_block_x(frame) for frame in frames] == [4 * index for index, _ in picks]


def test_sampling_respects_a_window_and_drops_duplicates():
    info = video.probe(FIXTURE)
    assert video.sample_indices(info, 2, start_ms=500, end_ms=1000) == [(15, 625), (21, 875)]
    # 窗口里只有 2 帧时要 9 个点，重复的帧号只留一个。
    assert video.sample_indices(info, 9, start_ms=0, end_ms=84) == [(0, 0), (1, 42)]


@pytest.mark.parametrize(("count", "start", "end"), [(0, None, None), (10, None, None),
                                                    (3, 600, 500), (3, None, 1001), (3, -1, None)])
def test_sampling_rejects_bad_requests(count, start, end):
    with pytest.raises(ValueError):
        video.sample_indices(video.probe(FIXTURE), count, start_ms=start, end_ms=end)


def test_contact_sheet_lays_frames_in_a_labelled_grid():
    info = video.probe(FIXTURE)
    picks = video.sample_indices(info, 6)
    frames = video.read_frames(FIXTURE, [index for index, _ in picks])
    sheet = Image.open(io.BytesIO(video.contact_sheet([(t, f) for (_, t), f in zip(picks, frames)])))
    assert sheet.format == "JPEG"
    # 6 帧 → 3 列 2 行；小视频不放大，每格保持 96×64，下方留时间码。
    gap, label = video.GAP, video.LABEL_HEIGHT
    assert sheet.size == (gap + 3 * (96 + gap), gap + 2 * (64 + label + gap))
    assert video._label(917) == "0:00.9" and video._label(61_500) == "1:01.5"


def test_contact_sheet_shrinks_large_frames_to_the_long_edge():
    big = Image.new("RGB", (1920, 1080), "gray")
    sheet = Image.open(io.BytesIO(video.contact_sheet([(i * 1000, big) for i in range(9)])))
    assert max(sheet.size) <= video.SHEET_LONG_EDGE


def test_unreadable_files_raise_a_video_error(tmp_path):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    with pytest.raises(video.VideoReadError):
        video.probe(broken)
    with pytest.raises(video.VideoReadError):
        video.read_frames(broken, [0])
