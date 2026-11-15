"""把一组等大的帧拼成一张精灵表。

格与格之间留全透明的间隔：精灵表调整按全透明的行列自动切格，视频帧完全不透明也能切对。
帧数据与精灵表调整的 /repack 同一格式。
"""
from __future__ import annotations

import io
import math

from PIL import Image

GUTTER = 2
MAX_EDGE = 8192
ANCHOR = (0.5, 1.0)


def compose(images: list[Image.Image], columns: int) -> tuple[bytes, dict]:
    if not images:
        raise ValueError("没有可拼的帧")
    if columns < 1:
        raise ValueError("每行至少 1 帧")
    columns = min(columns, len(images))
    rows = -(-len(images) // columns)
    cell_w = max(image.width for image in images)
    cell_h = max(image.height for image in images)
    width = columns * cell_w + (columns - 1) * GUTTER
    height = rows * cell_h + (rows - 1) * GUTTER
    if max(width, height) > MAX_EDGE:
        raise ValueError(f"拼出来的图长边超过 {MAX_EDGE} 像素，请减少每行帧数或缩小尺寸")
    sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    anchor_x, anchor_y = math.floor(cell_w * ANCHOR[0]), math.floor(cell_h * ANCHOR[1])
    frames = []
    for index, image in enumerate(images):
        x = (index % columns) * (cell_w + GUTTER)
        y = (index // columns) * (cell_h + GUTTER)
        sheet.paste(image.convert("RGBA"), (x, y))
        frames.append({"x": x, "y": y, "w": cell_w, "h": cell_h, "anchor_x": anchor_x, "anchor_y": anchor_y})
    buffer = io.BytesIO()
    sheet.save(buffer, "PNG")
    data = {"frames": frames, "meta": {"size": {"w": width, "h": height}, "columns": columns, "rows": rows,
                                       "cell": {"w": cell_w, "h": cell_h},
                                       "anchor": {"x": anchor_x, "y": anchor_y}}}
    return buffer.getvalue(), data
