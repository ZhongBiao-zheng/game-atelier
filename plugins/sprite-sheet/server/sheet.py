"""精灵表的像素处理：识别网格、切帧、重排。只依赖 Pillow，不碰画布与文件路径以外的东西。"""
from __future__ import annotations

import io
from typing import Any

from PIL import Image

MAX_EDGE = 8192
MAX_FRAMES = 1024
ALPHA_THRESHOLD = 8
ALIGNMENTS = ("bottom-center", "center", "top-left")


def open_sheet(path) -> Image.Image:
    image = Image.open(path)
    if max(image.size) > MAX_EDGE:
        raise ValueError(f"图片长边不能超过 {MAX_EDGE} 像素")
    return image.convert("RGBA")


def _bands(flags: list[int]) -> list[tuple[int, int]]:
    """连续的非空区间，半开 [start, end)。"""
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            bands.append((start, index))
            start = None
    if start is not None:
        bands.append((start, len(flags)))
    return bands


def _mask(image: Image.Image) -> Image.Image:
    return image.getchannel("A").point(lambda alpha: 255 if alpha > ALPHA_THRESHOLD else 0)


def detect_frames(image: Image.Image) -> dict[str, Any]:
    """按透明的整行、整列把图切成网格，返回每格里内容的包围盒。

    只认规则网格：帧与帧之间要有完全透明的行或列。没有透明通道、或帧贴在一起的图，
    识别结果是整张图一帧，由用户改用手动网格。
    """
    mask = _mask(image)
    columns_filled, rows_filled = mask.getprojection()
    column_bands, row_bands = _bands(columns_filled), _bands(rows_filled)
    frames = []
    for top, bottom in row_bands:
        for left, right in column_bands:
            box = mask.crop((left, top, right, bottom)).getbbox()
            if box is None:
                continue
            frames.append({"x": left + box[0], "y": top + box[1], "w": box[2] - box[0], "h": box[3] - box[1]})
    if len(frames) > MAX_FRAMES:
        raise ValueError(f"识别出的帧超过 {MAX_FRAMES} 个，请改用手动网格")
    return {"width": image.width, "height": image.height, "columns": len(column_bands),
            "rows": len(row_bands), "frames": frames}


def grid_frames(width: int, height: int, columns: int, rows: int,
                margin: int = 0, spacing: int = 0) -> list[dict[str, int]]:
    """手动网格：按行列数均分，返回每格的矩形（行优先）。"""
    if columns < 1 or rows < 1 or columns * rows > MAX_FRAMES:
        raise ValueError("行列数不合适")
    if margin < 0 or spacing < 0:
        raise ValueError("边距与间距不能为负")
    cell_w = (width - 2 * margin - (columns - 1) * spacing) // columns
    cell_h = (height - 2 * margin - (rows - 1) * spacing) // rows
    if cell_w < 1 or cell_h < 1:
        raise ValueError("边距与间距超过了图片尺寸")
    return [{"x": margin + column * (cell_w + spacing), "y": margin + row * (cell_h + spacing),
             "w": cell_w, "h": cell_h}
            for row in range(rows) for column in range(columns)]


def _frame_box(frame: dict[str, Any], image: Image.Image) -> tuple[int, int, int, int]:
    x, y, w, h = (int(frame[key]) for key in ("x", "y", "w", "h"))
    if w < 1 or h < 1 or x < 0 or y < 0 or x + w > image.width or y + h > image.height:
        raise ValueError("帧的范围超出了图片")
    return x, y, x + w, y + h


def repack(image: Image.Image, frames: list[dict[str, Any]], *, columns: int, spacing: int = 0,
           margin: int = 0, align: str = "bottom-center", trim: bool = True) -> tuple[bytes, dict[str, Any]]:
    """把帧重排成一张等格的精灵表。返回 (PNG 字节, 帧数据)。"""
    if not frames or len(frames) > MAX_FRAMES:
        raise ValueError("没有可排的帧" if not frames else f"帧数不能超过 {MAX_FRAMES}")
    if columns < 1 or spacing < 0 or margin < 0 or align not in ALIGNMENTS:
        raise ValueError("排布参数不对")
    tiles = []
    for frame in frames:
        tile = image.crop(_frame_box(frame, image))
        if trim:
            box = _mask(tile).getbbox()
            tile = tile.crop(box) if box else tile.crop((0, 0, 1, 1))
        tiles.append(tile)
    cell_w, cell_h = max(tile.width for tile in tiles), max(tile.height for tile in tiles)
    columns = min(columns, len(tiles))
    rows = -(-len(tiles) // columns)
    sheet_w = 2 * margin + columns * cell_w + (columns - 1) * spacing
    sheet_h = 2 * margin + rows * cell_h + (rows - 1) * spacing
    if max(sheet_w, sheet_h) > MAX_EDGE:
        raise ValueError(f"排出来的图长边超过 {MAX_EDGE} 像素，请减少列数或间距")
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    placed = []
    for index, tile in enumerate(tiles):
        cell_x = margin + (index % columns) * (cell_w + spacing)
        cell_y = margin + (index // columns) * (cell_h + spacing)
        if align == "top-left":
            dx, dy = 0, 0
        elif align == "center":
            dx, dy = (cell_w - tile.width) // 2, (cell_h - tile.height) // 2
        else:
            dx, dy = (cell_w - tile.width) // 2, cell_h - tile.height
        sheet.paste(tile, (cell_x + dx, cell_y + dy))
        placed.append({"x": cell_x, "y": cell_y, "w": cell_w, "h": cell_h,
                       "anchor_x": cell_w // 2, "anchor_y": cell_h})
    buffer = io.BytesIO()
    sheet.save(buffer, "PNG")
    data = {"frames": placed, "meta": {"size": {"w": sheet_w, "h": sheet_h}, "columns": columns,
                                       "rows": rows, "cell": {"w": cell_w, "h": cell_h}}}
    return buffer.getvalue(), data
