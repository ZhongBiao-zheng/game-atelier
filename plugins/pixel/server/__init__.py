"""像素化的服务端模块：预览、调色板、像素化。界面与 Agent 共用同一组处理函数；算法只在这里实现一份。"""
from __future__ import annotations

import base64
import io

from PIL import Image

from . import pixel

MAX_FRAMES = 65  # 结果组上限


def _sources(ctx, params: dict) -> list:
    """要处理的图片。界面带来连到本节点的图片（结果组按组内顺序）；Agent 按图片节点 id 列出。"""
    if ctx.origin == "agent":
        node_ids = params.get("image_node_ids")
        if not isinstance(node_ids, list) or not 1 <= len(node_ids) <= MAX_FRAMES:
            raise ValueError("要给 1 到 65 张图片节点")
        return [ctx.image_of_node(str(node_id)) for node_id in node_ids]
    images = [item for item in ctx.inputs if item.kind == "image"]
    if not images:
        raise ValueError("请先连接一张图片，或一个结果组")
    if len(images) > MAX_FRAMES:
        raise ValueError(f"一次最多 {MAX_FRAMES} 张")
    return images


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _data_url(image: Image.Image) -> str:
    return "data:image/png;base64," + base64.b64encode(_png(image)).decode("ascii")


def _palette_for(images: list[Image.Image], frame: Image.Image, settings: pixel.Settings):
    palette = pixel.auto_palette(images if settings.shared_palette else [frame], settings.colors,
                                 settings.alpha_threshold)
    return palette, pixel.palette_lut(palette)


def _frame_index(params: dict, count: int) -> int:
    frame = params.get("frame", 0)
    if isinstance(frame, bool) or not isinstance(frame, int) or not 0 <= frame < count:
        raise ValueError("没有这一帧")
    return frame


def _place(ctx, images: list[Image.Image], title: str, beside: str | None) -> dict:
    if len(images) == 1:
        return ctx.create_image(_png(images[0]), title, beside_node_id=beside)
    return ctx.create_image_group([_png(image) for image in images], title, beside_node_id=beside)


def register(api) -> None:
    @api.route("POST", "/palette")
    def palette(ctx, params: dict) -> dict:
        settings = pixel.Settings.parse(params)
        images = [Image.open(item.path) for item in _sources(ctx, params)]
        frame = images[_frame_index(params, len(images))]
        colors, _ = _palette_for(images, frame, settings)
        return {"colors": pixel.hex_colors(colors)}

    @api.route("POST", "/preview")
    def preview(ctx, params: dict) -> dict:
        settings = pixel.Settings.parse(params)
        images = [Image.open(item.path) for item in _sources(ctx, params)]
        frame = images[_frame_index(params, len(images))]
        colors, lut = _palette_for(images, frame, settings)
        out = pixel.pixelate_one(frame, colors, lut, settings)
        return {"url": _data_url(out), "size": [out.width, out.height], "colors": pixel.hex_colors(colors)}

    @api.route("POST", "/pixelate")
    def run(ctx, params: dict) -> dict:
        settings = pixel.Settings.parse(params)
        sources = _sources(ctx, params)
        outputs, palettes = pixel.pixelate([Image.open(item.path) for item in sources], settings)
        title = f"{sources[0].title[:90]} 像素"
        beside = ctx.node_id or sources[0].node_id
        primary = [pixel.upscale(image, settings.upscale) for image in outputs]
        result = {**_place(ctx, primary, title, beside), "frame_count": len(outputs),
                  "size": [outputs[0].width, outputs[0].height], "colors": pixel.hex_colors(palettes[0])}
        if settings.upscale > 1 and params.get("keep_original_size"):
            # 放大版给画布上看，实际像素版给游戏里用。
            original = _place(ctx, outputs, f"{title} 原尺寸", result["node_id"])
            result["original_node_id"] = original["node_id"]
        return result
