"""精灵表像素处理：识别、手动网格、重排。"""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

import pytest
from PIL import Image

_spec = importlib.util.spec_from_file_location(
    "sprite_sheet_under_test", Path(__file__).resolve().parents[1] / "server" / "sheet.py")
sheet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sheet)

RED, GREEN = (229, 83, 75, 255), (82, 171, 105, 255)


def strip(cells: int, cell: int = 16, box=(4, 2, 12, 14), rows: int = 1, gap: int = 0, margin: int = 0):
    width = 2 * margin + cells * cell + (cells - 1) * gap
    height = 2 * margin + rows * cell + (rows - 1) * gap
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for row in range(rows):
        for column in range(cells):
            x, y = margin + column * (cell + gap), margin + row * (cell + gap)
            image.paste(Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), RED), (x + box[0], y + box[1]))
    return image


def decode(png: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png)).convert("RGBA")


def test_detects_a_regular_strip():
    found = sheet.detect_frames(strip(4))
    assert (found["columns"], found["rows"], len(found["frames"])) == (4, 1, 4)
    assert found["frames"][0] == {"x": 4, "y": 2, "w": 8, "h": 12}
    assert found["frames"][3]["x"] == 3 * 16 + 4


def test_detects_rows_gaps_and_margins():
    found = sheet.detect_frames(strip(3, rows=2, gap=5, margin=7))
    assert (found["columns"], found["rows"], len(found["frames"])) == (3, 2, 6)
    assert found["frames"][4] == {"x": 7 + 21 + 4, "y": 7 + 21 + 2, "w": 8, "h": 12}


def test_fully_transparent_image_has_no_frames():
    found = sheet.detect_frames(Image.new("RGBA", (32, 32), (0, 0, 0, 0)))
    assert found["frames"] == [] and found["columns"] == 0


def test_opaque_image_is_one_frame():
    found = sheet.detect_frames(Image.new("RGB", (40, 20), (10, 20, 30)).convert("RGBA"))
    assert found["frames"] == [{"x": 0, "y": 0, "w": 40, "h": 20}]


def test_single_pixel_columns_are_not_lost_in_tall_images():
    image = Image.new("RGBA", (9, 4000), (0, 0, 0, 0))
    image.putpixel((1, 3000), RED)
    image.putpixel((7, 10), RED)
    found = sheet.detect_frames(image)
    assert found["columns"] == 2 and len(found["frames"]) == 2


def test_faint_alpha_is_treated_as_empty():
    image = Image.new("RGBA", (10, 10), (255, 255, 255, 4))
    assert sheet.detect_frames(image)["frames"] == []


def test_too_many_frames_is_rejected():
    image = Image.new("RGBA", (70, 70), (0, 0, 0, 0))
    for y in range(0, 70, 2):
        for x in range(0, 70, 2):
            image.putpixel((x, y), RED)
    with pytest.raises(ValueError, match="手动网格"):
        sheet.detect_frames(image)


def test_manual_grid_with_non_divisible_size():
    frames = sheet.grid_frames(100, 50, 3, 2)
    assert len(frames) == 6 and frames[0] == {"x": 0, "y": 0, "w": 33, "h": 25}
    assert frames[5] == {"x": 66, "y": 25, "w": 33, "h": 25}


def test_manual_grid_margin_and_spacing():
    frames = sheet.grid_frames(110, 50, 2, 1, margin=5, spacing=10)
    assert frames == [{"x": 5, "y": 5, "w": 45, "h": 40}, {"x": 60, "y": 5, "w": 45, "h": 40}]


@pytest.mark.parametrize("args", [(100, 50, 0, 1), (100, 50, 1, 0), (10, 10, 40, 40), (10, 10, 2, 2, 6, 0), (10, 10, 2, 2, -1, 0)])
def test_manual_grid_rejects_bad_arguments(args):
    with pytest.raises(ValueError):
        sheet.grid_frames(*args)


def test_repack_trims_and_aligns_to_bottom_center():
    image = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
    image.paste(Image.new("RGBA", (4, 10), RED), (2, 5))      # 窄高
    image.paste(Image.new("RGBA", (10, 4), GREEN), (25, 8))   # 宽矮
    frames = [{"x": 0, "y": 0, "w": 20, "h": 20}, {"x": 20, "y": 0, "w": 20, "h": 20}]
    png, data = sheet.repack(image, frames, columns=2, spacing=2, margin=1)
    out = decode(png)
    assert data["meta"]["cell"] == {"w": 10, "h": 10}
    assert out.size == (1 + 10 + 2 + 10 + 1, 1 + 10 + 1) == (data["meta"]["size"]["w"], data["meta"]["size"]["h"])
    # 第一帧 4 宽，水平居中在 10 宽的格里：x 从 1+3 开始，占满整个格高。
    assert out.getpixel((1 + 3, 1)) == RED and out.getpixel((1 + 2, 1))[3] == 0
    # 第二帧 4 高，贴底：格的上 6 行透明，下 4 行有内容。
    assert out.getpixel((13, 1 + 5))[3] == 0 and out.getpixel((13, 1 + 6)) == GREEN
    assert data["frames"][1] == {"x": 13, "y": 1, "w": 10, "h": 10, "anchor_x": 5, "anchor_y": 10}


def test_repack_wraps_into_rows_and_keeps_order():
    png, data = sheet.repack(strip(5), sheet.detect_frames(strip(5))["frames"], columns=2)
    assert (data["meta"]["columns"], data["meta"]["rows"]) == (2, 3)
    assert decode(png).size == (16, 36)
    assert [frame["x"] for frame in data["frames"]] == [0, 8, 0, 8, 0]


def test_repack_alignments_differ():
    image = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    image.paste(Image.new("RGBA", (2, 2), RED), (0, 0))
    image.paste(Image.new("RGBA", (6, 6), GREEN), (12, 2))
    frames = [{"x": 0, "y": 0, "w": 10, "h": 10}, {"x": 10, "y": 0, "w": 10, "h": 10}]
    top_left = decode(sheet.repack(image, frames, columns=2, align="top-left")[0])
    center = decode(sheet.repack(image, frames, columns=2, align="center")[0])
    bottom = decode(sheet.repack(image, frames, columns=2, align="bottom-center")[0])
    assert top_left.getpixel((0, 0)) == RED
    assert center.getpixel((2, 2)) == RED and center.getpixel((0, 0))[3] == 0
    assert bottom.getpixel((2, 4)) == RED and bottom.getpixel((2, 2))[3] == 0


def test_repack_without_trim_keeps_cells():
    image = strip(2)
    png, data = sheet.repack(image, sheet.grid_frames(32, 16, 2, 1), columns=2, trim=False)
    assert data["meta"]["cell"] == {"w": 16, "h": 16}
    assert decode(png).tobytes() == image.tobytes()


@pytest.mark.parametrize("frames, kwargs", [
    ([], {"columns": 1}),
    ([{"x": 0, "y": 0, "w": 99, "h": 4}], {"columns": 1}),
    ([{"x": -1, "y": 0, "w": 4, "h": 4}], {"columns": 1}),
    ([{"x": 0, "y": 0, "w": 0, "h": 4}], {"columns": 1}),
    ([{"x": 0, "y": 0, "w": 4, "h": 4}], {"columns": 0}),
    ([{"x": 0, "y": 0, "w": 4, "h": 4}], {"columns": 1, "align": "sideways"}),
    ([{"x": 0, "y": 0, "w": 4, "h": 4}], {"columns": 1, "spacing": -3}),
    ([{"x": 0}], {"columns": 1}),
])
def test_repack_rejects_bad_input(frames, kwargs):
    with pytest.raises((ValueError, KeyError)):
        sheet.repack(strip(2), frames, **kwargs)


def test_repack_refuses_oversized_output():
    with pytest.raises(ValueError, match="长边超过"):
        sheet.repack(strip(2), sheet.grid_frames(32, 16, 2, 1), columns=1, margin=5000, trim=False)


def test_open_sheet_rejects_huge_images(tmp_path):
    path = tmp_path / "huge.png"
    Image.new("L", (8200, 4)).save(path)
    with pytest.raises(ValueError, match="长边不能超过"):
        sheet.open_sheet(path)


CASES = json.loads((Path(__file__).parent / "layout_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_placements_match_the_shared_cases(case):
    """界面预览（ui/src/layout.ts）用同一组用例，两边的排布算法不能分叉。"""
    sizes = [tuple(size) for size in case["sizes"]]
    offsets = [tuple(offset) for offset in case["offsets"]]
    cell_w, cell_h, positions = sheet.placements(sizes, offsets, case["align"])
    assert [cell_w, cell_h] == case["expect"]["cell"]
    assert [list(position) for position in positions] == case["expect"]["positions"]
    assert list(sheet.anchor_point(cell_w, cell_h, tuple(case["anchor"]))) == case["expect"]["anchor"]


def test_repack_applies_offsets_and_clips_to_the_cell():
    image = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    image.paste(Image.new("RGBA", (4, 4), RED), (3, 3))
    image.paste(Image.new("RGBA", (4, 4), GREEN), (13, 3))
    frames = [{"x": 0, "y": 0, "w": 10, "h": 10, "ox": 0, "oy": -2},
              {"x": 10, "y": 0, "w": 10, "h": 10, "ox": 3, "oy": 0}]
    out = decode(sheet.repack(image, frames, columns=2, align="top-left")[0])
    assert out.size == (8, 4)
    # 第一帧上移 2：只剩下半截 2 行，上面没有越出格子。
    assert out.getpixel((0, 0)) == RED and out.getpixel((0, 2))[3] == 0
    # 第二帧右移 3：超出格子的 3 列被裁掉，没有画进格子之外。
    assert out.getpixel((4 + 3, 0)) == GREEN and out.getpixel((4 + 2, 0))[3] == 0


def test_repack_anchor_is_reported_in_frames_and_meta():
    _png, data = sheet.repack(strip(2), sheet.detect_frames(strip(2))["frames"], columns=2, anchor=(0.25, 0.5))
    assert data["meta"]["anchor"] == {"x": 2, "y": 6}
    assert {(frame["anchor_x"], frame["anchor_y"]) for frame in data["frames"]} == {(2, 6)}


@pytest.mark.parametrize("frame_patch", [{"ox": 5000}, {"oy": "1"}, {"ox": True}])
def test_repack_rejects_bad_offsets(frame_patch):
    with pytest.raises(ValueError, match="偏移"):
        sheet.repack(strip(2), [{"x": 0, "y": 0, "w": 16, "h": 16, **frame_patch}], columns=1)


@pytest.mark.parametrize("anchor", [(-0.1, 1), (0.5, 1.5)])
def test_repack_rejects_bad_anchor(anchor):
    with pytest.raises(ValueError, match="锚点"):
        sheet.repack(strip(2), sheet.grid_frames(32, 16, 2, 1), columns=2, anchor=anchor)


def test_repack_per_frame_anchor_overrides_the_sheet_anchor():
    frames = sheet.detect_frames(strip(3))["frames"]
    frames[1] = {**frames[1], "ax": 0, "ay": 0.5}
    _png, data = sheet.repack(strip(3), frames, columns=3, anchor=(0.5, 1.0))
    assert data["meta"]["anchor"] == {"x": 4, "y": 12}
    assert [(frame["anchor_x"], frame["anchor_y"]) for frame in data["frames"]] == [(4, 12), (0, 6), (4, 12)]


@pytest.mark.parametrize("patch", [{"ax": 0.5}, {"ax": 0.5, "ay": "1"}, {"ax": 1.5, "ay": 1}])
def test_repack_rejects_bad_per_frame_anchor(patch):
    frames = [{"x": 0, "y": 0, "w": 16, "h": 16, **patch}]
    with pytest.raises(ValueError, match="锚点"):
        sheet.repack(strip(1), frames, columns=1)
