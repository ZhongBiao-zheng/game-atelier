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


def test_frames_are_shrunk_to_the_cell_as_they_are_read():
    frames = video.read_frames(FIXTURE, [0, 12], size=(48, 32))
    assert [frame.size for frame in frames] == [(48, 32), (48, 32)]
    info, picks, data = video.contact_sheet_for(FIXTURE, 4)
    assert len(picks) == 4 and info["duration_ms"] == 1000
    columns, rows, cell = video.layout(96, 64, 4)
    gap, label = video.GAP, video.LABEL_HEIGHT
    assert Image.open(io.BytesIO(data)).size == (gap + columns * (cell[0] + gap),
                                                 gap + rows * (cell[1] + label + gap))


@pytest.fixture
def video_project(isolated_data_root):
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_schema import ImportMediaInput
    from character_workflow.lib.canvas_projects import create_canvas_project

    project_id = create_canvas_project("短片").project_id
    clip = isolated_data_root / "clip.mp4"
    clip.write_bytes(FIXTURE.read_bytes())
    still = isolated_data_root / "still.png"
    Image.new("RGB", (8, 8), "red").save(still)
    video_id = tools.import_media(runtime.LOCAL, ImportMediaInput(
        project_id=project_id, expected_revision=0, path=str(clip)))["version_id"]
    from character_workflow.lib.canvas_projects import read_canvas_document
    image_id = tools.import_media(runtime.LOCAL, ImportMediaInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        path=str(still)))["version_id"]
    return project_id, video_id, image_id


def test_agent_reads_a_video_as_one_attached_contact_sheet(video_project):
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib import canvas_agent_vision as vision

    project_id, video_id, _ = video_project
    result, created = runtime.execute_tool(project_id, "read_video_frames",
                                           {"version_id": video_id, "count": 4})
    assert created == [] and "preview" not in result
    assert [frame["index"] for frame in result["frames"]] == [3, 9, 15, 21]
    [ref] = result[vision.ATTACH_KEY]
    assert ref.startswith(vision.PREVIEW_PREFIX)
    assert vision.preview_data_url(ref).startswith("data:image/jpeg;base64,")
    assert "read_video_frames" in runtime.READ_TOOLS  # 只读，不弹确认


@pytest.mark.parametrize(("arguments", "code"), [
    ({"which": "image"}, "INVALID_TARGET"),
    ({"count": 10}, "参数错误"),  # 入参模型校验失败走所有工具共用的「参数错误」
    ({"start_ms": 900, "end_ms": 500}, "INVALID_PARAMETERS"),
])
def test_agent_gets_a_readable_error(video_project, arguments, code):
    from character_workflow.lib import canvas_agent_runtime as runtime

    project_id, video_id, image_id = video_project
    target = image_id if arguments.pop("which", None) == "image" else video_id
    text, _ = runtime.run_tool_safely(project_id, "read_video_frames", {"version_id": target, **arguments})
    assert runtime.is_tool_error(text) and code in text


def _fake_run(monkeypatch, params, candidates):
    from types import SimpleNamespace

    from character_workflow.lib import canvas_agent_tools as tools

    job = SimpleNamespace(
        job_id="job-1", status=SimpleNamespace(value="partial"), error=None, params=params,
        canvas_run=SimpleNamespace(run_id="run-1", result_node_id="n1", candidates=[
            SimpleNamespace(index=i, status=status, version_id=vid, error=error)
            for i, (status, vid, error) in enumerate(candidates)]))
    monkeypatch.setattr(tools, "_run_job", lambda project_id, run_id: job)


def _checks(view, index=0):
    return {check["name"]: check for check in view["candidates"][index]["checks"]}


def test_check_run_reports_size_transparency_and_format(video_project, monkeypatch, isolated_data_root):
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_schema import GetRunInput, ImportMediaInput
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.schemas import JobParams

    project_id, _, _ = video_project
    sprite = isolated_data_root / "sprite.png"
    image = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (0, 0, 4, 4))  # 四分之一不透明
    image.save(sprite)
    sprite_id = tools.import_media(runtime.LOCAL, ImportMediaInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        path=str(sprite)))["version_id"]
    _fake_run(monkeypatch, JobParams(size="8x8", size_mode="custom"),
              [("succeeded", sprite_id, None), ("failed", None, "上游超时")])
    view = tools.check_run(runtime.LOCAL, GetRunInput(project_id=project_id, run_id="run-1"))
    checks = _checks(view)
    assert checks["size"] == {"name": "size", "expected": "8x8", "actual": "8x8", "ok": True}
    assert checks["transparency"]["actual"] == "有透明通道，不透明区域占 25%"
    assert checks["format"]["actual"] == "image/png"
    assert "checks" not in view["candidates"][1] and view["candidates"][1]["error"] == "上游超时"
    _fake_run(monkeypatch, JobParams(size="16x16", size_mode="custom"), [("succeeded", sprite_id, None)])
    assert _checks(tools.check_run(runtime.LOCAL, GetRunInput(project_id=project_id, run_id="run-1")))[
        "size"]["ok"] is False
    _fake_run(monkeypatch, JobParams(ratio="1:1", size_mode="ratio"), [("succeeded", sprite_id, None)])
    assert _checks(tools.check_run(runtime.LOCAL, GetRunInput(project_id=project_id, run_id="run-1")))[
        "ratio"] == {"name": "ratio", "expected": "1:1", "actual": "8x8", "ok": True}


@pytest.mark.parametrize(("duration", "ok"), [(1, True), (5, False)])
def test_check_run_compares_video_duration(video_project, monkeypatch, duration, ok):
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_schema import GetRunInput
    from character_workflow.lib.schemas import JobParams

    project_id, video_id, _ = video_project
    _fake_run(monkeypatch, JobParams(duration=duration), [("succeeded", video_id, None)])
    checks = _checks(tools.check_run(runtime.LOCAL, GetRunInput(project_id=project_id, run_id="run-1")))
    assert checks["duration"] == {"name": "duration", "expected": f"{duration}s", "actual": "1.0s", "ok": ok}
    assert "transparency" not in checks


def test_finished_wait_carries_checks_and_a_video_contact_sheet(video_project, monkeypatch):
    from character_workflow.lib import canvas_agent_runtime as runtime
    from character_workflow.lib import canvas_agent_vision as vision
    from character_workflow.lib.schemas import JobParams

    project_id, video_id, _ = video_project
    _fake_run(monkeypatch, JobParams(duration=1), [("succeeded", video_id, None)])
    result = runtime._with_run_checks(project_id, "run-1", {"status": "done", "candidates": []})
    assert result["candidates"][0]["checks"][0]["name"] == "duration"
    [ref] = result[vision.ATTACH_KEY]
    assert vision.preview_data_url(ref).startswith("data:image/jpeg;base64,")
    assert "check_run" in runtime.READ_TOOLS
