"""序列帧的服务端模块：视频抽帧。界面与 Agent 共用同一组处理函数。"""
from __future__ import annotations

import json

from . import plan, sheet, video

FRAME_DATA_MAX_CHARS = 40_000  # 画布文本节点的正文上限


def _source(ctx, params: dict):
    # 界面只能用连在自己节点上的视频；Agent 按视频节点 id 指定。
    if ctx.origin == "agent":
        return ctx.media_of_node(str(params.get("video_node_id", "")), ("video",))
    source = next((item for item in ctx.inputs if item.kind == "video"), None)
    if source is None:
        raise ValueError("请先连接一个视频")
    return source


def _long_edge(params: dict) -> int | None:
    value = params.get("long_edge")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("尺寸参数不对")
    return value


def _planned(path, params: dict):
    """按视频的帧数与帧率算出要抽的帧号，以及输出尺寸。"""
    meta = video.probe(path)
    frames = plan.plan_frames(meta["frame_count"], meta["fps"], params)
    size = plan.output_size(meta["width"], meta["height"], _long_edge(params))
    return meta, frames, size


def register(api) -> None:
    @api.route("POST", "/probe")
    def probe(ctx, params: dict) -> dict:
        source = _source(ctx, params)
        return {**video.probe(source.path), "title": source.title}

    @api.route("POST", "/preview")
    def preview(ctx, params: dict) -> dict:
        source = _source(ctx, params)
        meta, frames, size = _planned(source.path, params)
        images = video.read_frames(source.path, frames, size)
        return {"frames": frames, "size": list(size), "fps": meta["fps"],
                "thumbnails": [video.thumbnail_url(image) for image in images]}

    @api.route("POST", "/extract")
    def extract(ctx, params: dict) -> dict:
        source = _source(ctx, params)
        _, frames, size = _planned(source.path, params)
        images = video.read_frames(source.path, frames, size)
        title = source.title[:100]
        beside = ctx.node_id or source.node_id
        result: dict = {"frames": frames, "size": list(size)}
        if params.get("sheet"):
            columns = params.get("columns", 8)
            if isinstance(columns, bool) or not isinstance(columns, int):
                raise ValueError("每行帧数不对")
            png, data = sheet.compose(images, columns)
            # 精灵表先落：紧挨插件节点；结果组随后让开它往右放。结果组默认收起，放在组后面会隔开一大段。
            sheet_node = ctx.create_image(png, f"{title} 精灵表", beside_node_id=beside)
            result["sheet_node_id"] = sheet_node["node_id"]
            if params.get("frame_data"):
                encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
                if len(encoded) > FRAME_DATA_MAX_CHARS:
                    result["frame_data_error"] = "帧太多，帧数据放不进文本节点"
                else:
                    text = ctx.create_text(encoded, f"{title} 帧数据", beside_node_id=sheet_node["node_id"])
                    result["frame_data_node_id"] = text["node_id"]
        group = ctx.create_image_group([video.png_bytes(image) for image in images], f"{title} 帧",
                                       beside_node_id=beside)
        return {**group, **result}
