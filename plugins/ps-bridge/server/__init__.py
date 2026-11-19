"""PS 联动插件的服务端模块（宿主插件，ADR-0039 / ADR-0041）。

三个能力，界面入口只有这三个：
- `/status`：是否安装、是否运行、授权记在哪个应用名下；`probe` 为真时才真的和 PS 说话（第一次会触发系统授权弹窗）。
- `/import`：PS 活动文档的选区（无选区为整张）→ 画布上的普通图片节点，记下来源。
- `/place`：画布图片节点 → PS 里的智能对象图层；有来源时放回原文档原位置。
请求参数只有 id 与枚举，不接受任何文件路径。
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib.plugin_registry import PluginError

from . import bridge, origins


class _Status(BaseModel):
    model_config = ConfigDict(extra="forbid")
    probe: bool = False


class _Import(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["merged", "layer"] = "merged"


class _Place(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=120)


def _plugin_error(error: bridge.PsError) -> PluginError:
    return PluginError(error.code, error.message, status=error.status)


def _status(probe: bool) -> dict:
    executor = bridge.EXECUTOR
    running = executor.running()
    result = {
        "supported": not isinstance(executor, bridge.UnsupportedExecutor),
        "installed": running or executor.installed(),
        "running": running,
        "responsible_app": bridge.responsible_app(),
        "version": None,
        "active_document": None,
    }
    if probe and running:
        receipt, request = bridge.run("version", {})
        bridge.finish(request)
        result["version"] = receipt.get("version")
        result["active_document"] = receipt.get("active_document")
    return result


def _stem(name: str) -> str:
    return Path(name).stem or name


def _import_title(receipt: dict) -> str:
    document = _stem(str((receipt.get("document") or {}).get("name") or "Photoshop"))
    if receipt.get("scope") == "layer" and receipt.get("layer"):
        return f"{document} · {receipt['layer']}"[:120]
    return f"{document} · 选区"[:120] if receipt.get("selection") else document[:120]


def _import(ctx, scope: str) -> dict:
    receipt, request = bridge.run("import", {"scope": scope},
                                  prepare=lambda request: {"out_png": str(request.path("export.png"))})
    try:
        png = bridge.read_png(request, "export.png")
    finally:
        bridge.finish(request)
    title = _import_title(receipt)
    node_id = ctx.create_image(png, title)["node_id"]
    from character_workflow.lib.canvas_projects import read_canvas_document
    node = next(item for item in read_canvas_document(ctx.project_id).nodes if item.id == node_id)
    document = receipt.get("document") or {}
    width, height = bridge.png_size(png)
    origin = {
        "document": {key: document.get(key) for key in ("id", "name", "path", "width", "height")},
        # 无选区时取的是整张：放回时对齐整张画布。
        "bounds": receipt.get("selection") or [0, 0, document.get("width") or width, document.get("height") or height],
        "scope": scope,
        "layer": receipt.get("layer"),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    ctx.update_state(lambda data: origins.record(data, node.data.current_version_id, origin))
    return {"node_id": node_id, "title": title}


def _prepare_png(source: Path, request: bridge.Request) -> dict:
    """任意格式的图片转成 PNG 放进请求目录，并算出不透明内容的范围（智能对象换算位置要用，探针第 5 项）。"""
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(source) as image:
            rgba = image.convert("RGBA")
    except (OSError, UnidentifiedImageError, ValueError):
        raise bridge.PsError("PS_BAD_IMAGE", "这张图片读不出", 422) from None
    content = rgba.getchannel("A").getbbox()
    if content is None:
        raise bridge.PsError("PS_BAD_IMAGE", "这张图片是全透明的", 422)
    buffer = io.BytesIO()
    rgba.save(buffer, "PNG", compress_level=6)
    target = request.path("place.png")
    target.write_bytes(buffer.getvalue())
    return {"png": str(target), "png_width": rgba.width, "png_height": rgba.height,
            "png_content_bounds": list(content)}


def _place(ctx, node_id: str) -> dict:
    from character_workflow.lib.canvas_projects import read_canvas_document
    image = ctx.image_of_node(node_id)
    origin = origins.find_origin(ctx.read_state(), read_canvas_document(ctx.project_id), node_id, image.version_id)
    document = (origin or {}).get("document") or {}
    params = {
        "layer_name": image.title[:100] or "Atelier",
        "bounds": origin.get("bounds") if origin else None,
        "target": {"doc_id": document.get("id"), "name": document.get("name"), "path": document.get("path"),
                   "strict": True} if origin else None,
    }
    receipt, request = bridge.run("place", params, prepare=lambda request: _prepare_png(image.path, request))
    bridge.finish(request)
    return {"document": (receipt.get("target") or {}).get("name"), "layer": params["layer_name"],
            "returned_to_origin": origin is not None}


def register(api) -> None:
    @api.route("POST", "/status")
    def status(ctx, params: dict) -> dict:
        body = _Status.model_validate(params)
        try:
            return _status(body.probe)
        except bridge.PsError as error:
            raise _plugin_error(error) from None

    @api.route("POST", "/import")
    def import_image(ctx, params: dict) -> dict:
        body = _Import.model_validate(params)
        try:
            return _import(ctx, body.scope)
        except bridge.PsError as error:
            raise _plugin_error(error) from None

    @api.route("POST", "/place")
    def place(ctx, params: dict) -> dict:
        body = _Place.model_validate(params)
        try:
            return _place(ctx, body.node_id)
        except bridge.PsError as error:
            raise _plugin_error(error) from None
