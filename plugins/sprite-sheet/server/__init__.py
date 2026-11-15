"""精灵表调整的服务端模块：界面与 Agent 共用同一组处理函数。"""
from __future__ import annotations

import json

from . import sheet

# 画布文本节点的正文上限。
FRAME_DATA_MAX_CHARS = 40_000


MAX_SOURCES = 65  # 结果组上限


def _source(ctx, params: dict):
    # 界面只能用连在自己节点上的那张图；Agent 按图片节点 id 指定。
    if ctx.origin == "agent":
        return ctx.image_of_node(str(params.get("image_node_id", "")))
    if not ctx.inputs:
        raise ValueError("请先连接一张图片")
    return ctx.inputs[0]


def _sources(ctx, params: dict) -> list:
    """重排用的源图。连的是结果组时界面按组内顺序带来全部帧图；Agent 用 image_node_ids 列出。"""
    if ctx.origin == "agent":
        node_ids = params.get("image_node_ids")
        if node_ids is None:
            return [_source(ctx, params)]
        if not isinstance(node_ids, list) or not 1 <= len(node_ids) <= MAX_SOURCES:
            raise ValueError(f"要给 1 到 {MAX_SOURCES} 张图片节点")
        return [ctx.image_of_node(str(node_id)) for node_id in node_ids]
    images = [item for item in ctx.inputs if item.kind == "image"]
    if not images:
        raise ValueError("请先连接一张图片")
    return images[:MAX_SOURCES]


def _frames(images: list, params: dict) -> list[dict]:
    frames = params.get("frames")
    if isinstance(frames, list) and frames:
        return frames
    if len(images) > 1:
        # 结果组：每张图就是一帧（整张图，排之前再按 trim 裁透明边）。
        return [{"src": index, "x": 0, "y": 0, "w": image.width, "h": image.height}
                for index, image in enumerate(images)]
    image = images[0]
    grid = params.get("grid")
    if isinstance(grid, dict):
        return sheet.grid_frames(image.width, image.height, int(grid.get("columns", 1)), int(grid.get("rows", 1)),
                                 int(grid.get("margin", 0)), int(grid.get("spacing", 0)))
    return sheet.detect_frames(image)["frames"]


def _anchor(params: dict) -> tuple[float, float]:
    anchor = params.get("anchor")
    if not isinstance(anchor, dict):
        return (0.5, 1.0)
    return (float(anchor.get("x", 0.5)), float(anchor.get("y", 1.0)))


def register(api) -> None:
    @api.route("POST", "/detect")
    def detect(ctx, params: dict) -> dict:
        return sheet.detect_frames(sheet.open_sheet(_source(ctx, params).path))

    @api.route("POST", "/repack")
    def repack(ctx, params: dict) -> dict:
        sources = _sources(ctx, params)
        source = sources[0]
        images = [sheet.open_sheet(item.path) for item in sources]
        frames = _frames(images, params)
        png, data = sheet.repack(
            images, frames, columns=int(params.get("columns", len(frames))),
            spacing=int(params.get("spacing", 0)), margin=int(params.get("margin", 0)),
            align=str(params.get("align", "bottom-center")), trim=bool(params.get("trim", True)),
            anchor=_anchor(params),
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
