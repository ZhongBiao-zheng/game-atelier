"""精灵表调整的服务端模块：界面与 Agent 共用同一组处理函数。"""
from __future__ import annotations

import json

from . import sheet

# 画布文本节点的正文上限。
FRAME_DATA_MAX_CHARS = 40_000


def _source(ctx, params: dict):
    # 界面只能用连在自己节点上的那张图；Agent 按图片节点 id 指定。
    if ctx.origin == "agent":
        return ctx.image_of_node(str(params.get("image_node_id", "")))
    if not ctx.inputs:
        raise ValueError("请先连接一张图片")
    return ctx.inputs[0]


def _frames(image, params: dict) -> list[dict]:
    frames = params.get("frames")
    if isinstance(frames, list) and frames:
        return frames
    grid = params.get("grid")
    if isinstance(grid, dict):
        return sheet.grid_frames(image.width, image.height, int(grid.get("columns", 1)), int(grid.get("rows", 1)),
                                 int(grid.get("margin", 0)), int(grid.get("spacing", 0)))
    return sheet.detect_frames(image)["frames"]


def register(api) -> None:
    @api.route("POST", "/detect")
    def detect(ctx, params: dict) -> dict:
        return sheet.detect_frames(sheet.open_sheet(_source(ctx, params).path))

    @api.route("POST", "/repack")
    def repack(ctx, params: dict) -> dict:
        source = _source(ctx, params)
        image = sheet.open_sheet(source.path)
        frames = _frames(image, params)
        png, data = sheet.repack(
            image, frames, columns=int(params.get("columns", len(frames))),
            spacing=int(params.get("spacing", 0)), margin=int(params.get("margin", 0)),
            align=str(params.get("align", "bottom-center")), trim=bool(params.get("trim", True)),
        )
        created = ctx.create_image(png, f"{source.title} 精灵表"[:120], beside_node_id=ctx.node_id or source.node_id)
        result = {**created, **data}
        if params.get("frame_data"):
            # 帧数据给引擎用：落成一个文本节点，内容是 JSON，可以直接复制。
            encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            if len(encoded) > FRAME_DATA_MAX_CHARS:
                result["frame_data_error"] = "帧太多，帧数据放不进文本节点"
            else:
                text = ctx.create_text(encoded, f"{source.title} 帧数据"[:120], beside_node_id=created["node_id"])
                result["frame_data_node_id"] = text["node_id"]
        return result
