"""序列帧的服务端模块：视频抽帧与补间。界面与 Agent 共用同一组处理函数。"""
from __future__ import annotations

import json

from PIL import Image

from . import plan, sheet, tween, video

FRAME_DATA_MAX_CHARS = 40_000  # 画布文本节点的正文上限


def _source(ctx, params: dict):
    # 界面只能用连在自己节点上的视频；Agent 按视频节点 id 指定。
    if ctx.origin == "agent":
        return ctx.media_of_node(str(params.get("video_node_id", "")), ("video",))
    source = next((item for item in ctx.inputs if item.kind == "video"), None)
    if source is None:
        raise ValueError("请先连接一个视频")
    return source


def _sequence(ctx, params: dict) -> list:
    """补间的帧序列。界面按自己排好的顺序带句柄；Agent 按图片节点 id 列出顺序。"""
    if ctx.origin == "agent":
        node_ids = params.get("image_node_ids")
        if not isinstance(node_ids, list) or not 2 <= len(node_ids) <= tween.MAX_FRAMES:
            raise ValueError("要给 2 到 65 张图片节点")
        return [ctx.image_of_node(str(node_id)) for node_id in node_ids]
    images = [item for item in ctx.inputs if item.kind == "image"]
    if len(images) < 2:
        raise ValueError("请连接两张图片，或一个结果组")
    return images


def _int_param(params: dict, key: str, default: int) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("补间参数不对")
    return value


def _sheet_outputs(ctx, images, title: str, beside: str | None, params: dict) -> dict:
    """按需拼精灵表与帧数据。精灵表先落（紧挨插件节点），结果组随后让开它往右放。"""
    if not params.get("sheet"):
        return {}
    columns = params.get("columns", 8)
    if isinstance(columns, bool) or not isinstance(columns, int):
        raise ValueError("每行帧数不对")
    png, data = sheet.compose(images, columns)
    sheet_node = ctx.create_image(png, f"{title} 精灵表", beside_node_id=beside)
    result = {"sheet_node_id": sheet_node["node_id"]}
    if params.get("frame_data"):
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if len(encoded) > FRAME_DATA_MAX_CHARS:
            result["frame_data_error"] = "帧太多，帧数据放不进文本节点"
        else:
            text = ctx.create_text(encoded, f"{title} 帧数据", beside_node_id=sheet_node["node_id"])
            result["frame_data_node_id"] = text["node_id"]
    return result


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
        result: dict = {"frames": frames, "size": list(size), **_sheet_outputs(ctx, images, title, beside, params)}
        group = ctx.create_image_group([video.png_bytes(image) for image in images], f"{title} 帧",
                                       beside_node_id=beside)
        return {**group, **result}

    @api.route("POST", "/tween_preview")
    def tween_preview(ctx, params: dict) -> dict:
        sources = _sequence(ctx, params)
        pair = _int_param(params, "pair", 0)
        if not 0 <= pair < len(sources) - 1:
            raise ValueError("没有这一对帧")
        t = params.get("t", 0.5)
        if isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 < t < 1:
            raise ValueError("补间位置要在 0 到 1 之间")
        first, second = (Image.open(sources[index].path) for index in (pair, pair + 1))
        (middle,) = tween.between_pair(first, second, [float(t)], str(params.get("method", "flow")))
        return {"url": video.thumbnail_url(middle, edge=video.PREVIEW_EDGE), "pairs": len(sources) - 1}

    @api.route("POST", "/tween")
    def run_tween(ctx, params: dict) -> dict:
        sources = _sequence(ctx, params)
        between = _int_param(params, "between", 3)
        output = params.get("output", "all")
        if output not in ("all", "new"):
            raise ValueError("输出选项不对")
        images = tween.tween_sequence([Image.open(item.path) for item in sources], between,
                                      str(params.get("method", "flow")), keep_originals=output == "all")
        title = f"{sources[0].title[:90]} 补间"
        beside = ctx.node_id or sources[0].node_id
        result: dict = {"frame_count": len(images), **_sheet_outputs(ctx, images, title, beside, params)}
        group = ctx.create_image_group([video.png_bytes(image) for image in images], title, beside_node_id=beside)
        return {**group, **result}
