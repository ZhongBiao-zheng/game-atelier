"""插件的服务端模块：加载、校验、调用（ADR-0037）。

只有随应用发布的插件可以带服务端模块。这里是服务端的独立校验点：浏览器里的 broker
已经校验过一遍，但服务端不信它——插件是否启用、路由是否在清单里、项目是否批准、
素材是否真的连在这个节点上，都在这里重新核对。
"""
from __future__ import annotations

import importlib.util
import json
import logging
import secrets
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from character_workflow.lib import plugin_grants, plugin_registry
from character_workflow.lib.plugin_registry import PluginError, PluginRecord

logger = logging.getLogger(__name__)

Handler = Callable[["PluginRequest", dict], dict]
MODULE_PREFIX = "atelier_plugin_"
MAX_RESULT_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024


class PluginServerAPI:
    """服务端模块的 `register(api)` 用它登记处理函数。"""

    def __init__(self) -> None:
        self.handlers: dict[tuple[str, str], Handler] = {}

    def route(self, method: str, path: str) -> Callable[[Handler], Handler]:
        def decorate(handler: Handler) -> Handler:
            self.handlers[(method, path)] = handler
            return handler
        return decorate


@dataclass(frozen=True)
class PluginImage:
    """一张可读的图片。`path` 只在服务端模块里出现，不会回传给界面。"""

    node_id: str
    version_id: str
    title: str
    path: Path
    width: int | None
    height: int | None


@dataclass
class PluginRequest:
    plugin_id: str
    project_id: str
    # surface：界面经宿主发起，只能碰连在自己节点上的素材。agent：本机 Agent 的一轮对话里发起。
    origin: str
    capabilities: frozenset[str]
    node_id: str | None = None
    inputs: list[PluginImage] = field(default_factory=list)
    created_node_ids: list[str] = field(default_factory=list)

    def image_of_node(self, node_id: str) -> PluginImage:
        """按节点 id 取图。只给 Agent 用：界面只能用 `inputs`。"""
        if self.origin != "agent":
            raise PluginError("CAPABILITY_DENIED", "界面只能读取连到本节点的素材", status=403)
        from character_workflow.lib.canvas_projects import read_canvas_document
        document = read_canvas_document(self.project_id)
        node = next((item for item in document.nodes if item.id == node_id), None)
        if node is None or node.type != "image" or not node.data.current_version_id:
            raise PluginError("INVALID_TARGET", "找不到这张图片", status=422)
        return _image(self.project_id, node, node.data.current_version_id)

    def create_image(self, png: bytes, title: str, beside_node_id: str | None = None) -> dict:
        """把结果落成画布上的一个普通图片节点，返回 `{node_id}`。"""
        if "resource.create" not in self.capabilities:
            raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
        if len(png) > MAX_IMAGE_BYTES:
            raise PluginError("PAYLOAD_TOO_LARGE", "图片过大", status=413)
        node_id = _create_image_node(self.project_id, png, title, beside_node_id or self.node_id)
        self.created_node_ids.append(node_id)
        return {"node_id": node_id}


def _image(project_id: str, node: Any, version_id: str) -> PluginImage:
    from character_workflow.lib.canvas_projects import resolve_canvas_media
    try:
        path, version = resolve_canvas_media(project_id, version_id)
    except (OSError, PermissionError, ValueError) as error:
        raise PluginError("INVALID_TARGET", "读不到这份素材", status=422) from error
    if version.kind != "image":
        raise PluginError("INVALID_TARGET", "这份素材不是图片", status=422)
    return PluginImage(node.id, version_id, node.title, path, version.width, version.height)


def _create_image_node(project_id: str, png: bytes, title: str, beside_node_id: str | None) -> str:
    from character_workflow.lib.canvas_agent_tools import _media_node
    from character_workflow.lib.canvas_projects import read_canvas_document, save_canvas_upload
    node_id = f"image-{secrets.token_hex(6)}"
    for attempt in range(3):
        document = read_canvas_document(project_id)
        anchor = next((node for node in document.nodes if node.id == beside_node_id), None)
        position = {"x": 0.0, "y": 0.0}
        if anchor is not None:
            width = anchor.size.width if anchor.size else 320
            position = {"x": anchor.position.x + width + 60, "y": anchor.position.y}
        try:
            save_canvas_upload(
                project_id, f"{title}.png", "png", png, "image", document.revision,
                node_factory=lambda version: _media_node("image", node_id, title[:120] or "图片", position, version.version_id),
            )
            return node_id
        except RuntimeError as error:
            # 页面正在自动保存时会撞 revision：重读再试，不覆盖别人的修改。
            if not str(error).startswith("revision_conflict:") or attempt == 2:
                raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409) from error
        except ValueError as error:
            raise PluginError("INVALID_TARGET", str(error)[:200], status=422) from error
    raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409)


_lock = threading.Lock()
_loaded: dict[str, tuple[str, dict[tuple[str, str], Handler]]] = {}


def _module_name(plugin_id: str) -> str:
    return MODULE_PREFIX + plugin_id.replace("-", "_")


def unload(plugin_id: str) -> None:
    with _lock:
        _loaded.pop(plugin_id, None)
        name = _module_name(plugin_id)
        for key in [key for key in sys.modules if key == name or key.startswith(name + ".")]:
            del sys.modules[key]


def _handlers(record: PluginRecord) -> dict[tuple[str, str], Handler]:
    """首次调用时才 import 服务端模块；插件更新（摘要变化）后重新加载。"""
    assert record.lock is not None
    with _lock:
        cached = _loaded.get(record.plugin_id)
        if cached and cached[0] == record.lock.digest:
            return cached[1]
    unload(record.plugin_id)
    entry = record.package_dir.parent / "server" / "__init__.py"
    name = _module_name(record.plugin_id)
    spec = importlib.util.spec_from_file_location(name, entry, submodule_search_locations=[str(entry.parent)])
    if spec is None or spec.loader is None or not entry.is_file():
        raise PluginError("PLUGIN_BROKEN", "插件缺少服务端模块", status=500)
    module = importlib.util.module_from_spec(spec)
    api = PluginServerAPI()
    with _lock:
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
            module.register(api)
        except Exception as error:
            sys.modules.pop(name, None)
            logger.exception("plugin %s server module failed to load", record.plugin_id)
            raise PluginError("PLUGIN_BROKEN", "插件服务端模块加载失败", status=500) from error
        _loaded[record.plugin_id] = (record.lock.digest, api.handlers)
    return api.handlers


def _enabled_record(plugin_id: str) -> PluginRecord:
    record = plugin_registry.find(plugin_id)
    if record is None or record.lock is None or plugin_id not in plugin_registry.enabled_ids():
        raise PluginError("PLUGIN_DISABLED", "插件未启用", status=404)
    return record


def declared_access(plugin_id: str, method: str, path: str) -> str | None:
    """清单里这条路由的读写类别；插件未启用或没声明这条路由时为 None。给鉴权中间件用。"""
    try:
        record = _enabled_record(plugin_id)
    except PluginError:
        return None
    server = record.lock.contributes.server if record.lock else None
    route = next((item for item in (server.routes if server else [])
                  if item.method == method and item.path == path), None)
    return route.access if route else None


def _surface_inputs(project_id: str, plugin_id: str, node_id: str | None,
                    version_ids: list[str]) -> list[PluginImage]:
    """界面带来的素材版本，必须此刻真的连在它自己的节点上。"""
    from character_workflow.lib.canvas_projects import read_canvas_document
    document = read_canvas_document(project_id)
    node = next((item for item in document.nodes if item.id == node_id), None)
    if node is None or node.type != "plugin" or node.data.plugin_id != plugin_id:
        raise PluginError("INVALID_TARGET", "这个节点不属于此插件", status=403)
    nodes = {item.id: item for item in document.nodes}
    connected = {
        source.data.current_version_id: source
        for edge in document.connections
        if edge.role == "input" and edge.target_node_id == node_id
        and (source := nodes.get(edge.source_node_id)) is not None
        and source.type == "image" and source.data.current_version_id
    }
    images = []
    for version_id in version_ids:
        source = connected.get(version_id)
        if source is None:
            raise PluginError("INVALID_HANDLE", "素材没有连到这个节点", status=403)
        images.append(_image(project_id, source, version_id))
    return images


def call(plugin_id: str, method: str, path: str, *, project_id: str, origin: str,
         params: dict | None = None, node_id: str | None = None,
         input_version_ids: list[str] | None = None) -> tuple[dict, list[str]]:
    """调用一条插件路由。返回 (结果, 这次调用新建的节点 id)。"""
    record = _enabled_record(plugin_id)
    assert record.lock is not None
    server = record.lock.contributes.server
    if server is None or not any(item.method == method and item.path == path for item in server.routes):
        raise PluginError("ROUTE_NOT_DECLARED", "插件没有声明这个接口", status=404)
    granted = plugin_grants.active_grants(project_id).get(plugin_id)
    if granted is None:
        raise PluginError("PLUGIN_NOT_GRANTED", "本项目尚未允许此插件", status=403)
    capabilities = frozenset(granted["capabilities"])
    if origin == "surface" and "server.call" not in capabilities:
        raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
    request = PluginRequest(plugin_id, project_id, origin, capabilities, node_id=node_id)
    if origin == "surface":
        request.inputs = _surface_inputs(project_id, plugin_id, node_id, input_version_ids or [])
    handler = _handlers(record).get((method, path))
    if handler is None:
        raise PluginError("PLUGIN_BROKEN", "插件没有实现这个接口", status=500)
    try:
        result = handler(request, params if isinstance(params, dict) else {})
    except PluginError:
        raise
    except (ValueError, TypeError, KeyError) as error:
        raise PluginError("BAD_REQUEST", str(error)[:200] or "参数不对", status=422) from error
    except Exception as error:
        logger.exception("plugin %s %s %s failed", plugin_id, method, path)
        raise PluginError("PLUGIN_FAILED", "插件处理失败", status=500) from error
    if not isinstance(result, dict) or len(json.dumps(result, ensure_ascii=False)) > MAX_RESULT_BYTES:
        raise PluginError("PLUGIN_FAILED", "插件返回的结果不合规", status=500)
    return result, request.created_node_ids
