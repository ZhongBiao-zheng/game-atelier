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
# 画布 Agent 的 get_canvas 给这类节点追加的只读摘要：(文档, 节点) → 字段。只有宿主插件能登记。
AgentView = Callable[[Any, Any], dict]
MODULE_PREFIX = "atelier_plugin_"
MAX_RESULT_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024


class PluginServerAPI:
    """服务端模块的 `register(api)` 用它登记处理函数。"""

    def __init__(self) -> None:
        self.handlers: dict[tuple[str, str], Handler] = {}
        self.agent_views: dict[str, AgentView] = {}
        self.tool_filter: Callable[[], set[str]] | None = None

    def route(self, method: str, path: str) -> Callable[[Handler], Handler]:
        def decorate(handler: Handler) -> Handler:
            self.handlers[(method, path)] = handler
            return handler
        return decorate

    def agent_view(self, node_type: str) -> Callable[[AgentView], AgentView]:
        def decorate(view: AgentView) -> AgentView:
            self.agent_views[node_type] = view
            return view
        return decorate

    def hidden_agent_tools(self, filter_: Callable[[], set[str]]) -> Callable[[], set[str]]:
        """登记「此刻要藏起来的 Agent 工具名」（ADR-0043，只给宿主插件）：画布 Agent 与 Canvas MCP 都不列出它们，
        直接调用也拒绝。例：PS 联动的脚本开关关着时藏起 execute。"""
        self.tool_filter = filter_
        return filter_


MEDIA_KINDS = ("image", "video", "audio")
MAX_GROUP_IMAGES = 65  # 结果组 = 封面 + 最多 64 个成员（CanvasResultStack.member_node_ids）
MAX_GROUP_BYTES = 256 * 1024 * 1024
RESULT_STACK_GAP = 16  # 与前端 canvasResultStacks.RESULT_STACK_GAP 一致


@dataclass(frozen=True)
class PluginMedia:
    """一份可读的素材（图片、视频或音频）。`path` 只在服务端模块里出现，不会回传给界面。"""

    kind: str
    node_id: str
    version_id: str
    title: str
    path: Path
    width: int | None
    height: int | None
    duration_ms: int | None


@dataclass
class PluginRequest:
    plugin_id: str
    # 宿主插件可以不带项目调用（设置页的状态区，ADR-0041）：这时读写项目的能力都不可用。
    project_id: str | None
    # surface：界面经宿主发起，只能碰连在自己节点上的素材。agent：本机 Agent 的一轮对话里发起。
    # host：宿主插件（ADR-0039）的宿主代码发起，不经过项目批准。
    origin: str
    capabilities: frozenset[str]
    node_id: str | None = None
    inputs: list[PluginMedia] = field(default_factory=list)
    created_node_ids: list[str] = field(default_factory=list)
    plugin_version: str = ""
    # Agent 调用时是谁（「画布 Agent」或「外部 Agent」），给插件记日志用；其余入口为空。
    caller: str = ""
    # 宿主插件（ADR-0039）：代码与宿主同源可信，不论经界面还是 Agent 调用都不走项目批准（ADR-0043）。
    trusted: bool = False

    def _project(self) -> str:
        if self.project_id is None:
            raise PluginError("PROJECT_REQUIRED", "这个操作需要在画布项目里进行", status=422)
        return self.project_id

    def _allows(self, capability: str) -> bool:
        # 宿主插件的代码与宿主同源可信（ADR-0039 / ADR-0041），不经项目批准。
        return self.trusted or capability in self.capabilities

    def media_of_node(self, node_id: str, kinds: tuple[str, ...] = ("image",)) -> PluginMedia:
        """按节点 id 取素材，只认 `kinds` 里的类型。给 Agent 与宿主插件用：沙箱界面只能用 `inputs`。"""
        if self.origin not in ("agent", "host"):
            raise PluginError("CAPABILITY_DENIED", "界面只能读取连到本节点的素材", status=403)
        from character_workflow.lib.canvas_projects import read_canvas_document
        document = read_canvas_document(self._project())
        node = next((item for item in document.nodes if item.id == node_id), None)
        if node is None or node.type not in kinds or not node.data.current_version_id:
            raise PluginError("INVALID_TARGET", "找不到这张图片" if kinds == ("image",) else "找不到这份素材",
                              status=422)
        return _media(self._project(), node, node.data.current_version_id)

    def image_of_node(self, node_id: str) -> PluginMedia:
        return self.media_of_node(node_id, ("image",))

    def create_image(self, png: bytes, title: str, beside_node_id: str | None = None) -> dict:
        """把结果落成画布上的一个普通图片节点，返回 `{node_id}`。"""
        if not self._allows("resource.create"):
            raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
        if len(png) > MAX_IMAGE_BYTES:
            raise PluginError("PAYLOAD_TOO_LARGE", "图片过大", status=413)
        node_id = _create_image_node(self._project(), png, title, beside_node_id or self.node_id)
        self.created_node_ids.append(node_id)
        return {"node_id": node_id}

    def create_image_group(self, pngs: list[bytes], title: str, beside_node_id: str | None = None) -> dict:
        """把多张 PNG 落成一个结果组（封面 + 成员，一次提交），返回 `{node_id, member_node_ids}`。"""
        if not self._allows("resource.create"):
            raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
        if not pngs:
            raise PluginError("BAD_REQUEST", "没有可输出的图片", status=422)
        if len(pngs) > MAX_GROUP_IMAGES:
            raise PluginError("PAYLOAD_TOO_LARGE", f"一组最多 {MAX_GROUP_IMAGES} 张", status=413)
        if any(len(png) > MAX_IMAGE_BYTES for png in pngs) or sum(map(len, pngs)) > MAX_GROUP_BYTES:
            raise PluginError("PAYLOAD_TOO_LARGE", "图片过大", status=413)
        node_ids = _create_image_group(self.plugin_id, self._project(), pngs, title,
                                       beside_node_id or self.node_id)
        self.created_node_ids.extend(node_ids)
        return {"node_id": node_ids[0], "member_node_ids": node_ids[1:]}

    def create_generation_draft(self, prompt: str, first_node_id: str, last_node_id: str,
                                title: str = "首尾帧补间") -> dict:
        """在画布上新建一个视频生成节点：首帧、尾帧槽分别连好，草稿填好提示词与参数，**不运行**。

        用户在节点上点生成才会提交，计费、成本统计、路由与网关配额都走 Canvas Run。模型取用户的
        默认视频模型（能做首尾帧时），否则取第一个能做首尾帧的视频模型；时长与分辨率取最低档。
        """
        if "generation.draft" not in self.capabilities:
            raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2000:
            raise PluginError("BAD_REQUEST", "提示词不能为空，最多 2000 字", status=422)
        frames = []
        for node_id in (first_node_id, last_node_id):
            if self.origin == "agent":
                frames.append(self.image_of_node(node_id))
                continue
            image = next((item for item in self.inputs if item.kind == "image" and item.node_id == node_id), None)
            if image is None:
                raise PluginError("INVALID_HANDLE", "首尾帧要是连到本节点的图片", status=403)
            frames.append(image)
        node_id = _create_generation_draft(self._project(), prompt.strip(), frames, title,
                                           self.node_id or frames[-1].node_id)
        self.created_node_ids.append(node_id["node_id"])
        return node_id

    def create_text(self, text: str, title: str, beside_node_id: str | None = None) -> dict:
        """把一段文本落成画布上的普通文本节点，返回 `{node_id}`。"""
        if not self._allows("resource.create"):
            raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
        node_id = _create_text_node(self._project(), text, title, beside_node_id or self.node_id)
        self.created_node_ids.append(node_id)
        return {"node_id": node_id}


    def read_state(self) -> Any:
        """本项目里本插件的项目级状态（`canvases/<project>/plugins/<id>/state.json` 的 `data`），没有时为 None。

        只给宿主插件（ADR-0041）；沙箱插件的 `storage.project` 仍未开放。
        """
        self._require_host_state()
        state = _read_plugin_state(self._project(), self.plugin_id)
        return state.data if state is not None else None

    def update_state(self, change: Callable[[Any], Any]) -> Any:
        """读-改-写本插件的项目级状态：`change(旧 data 或 None)` 返回新 data（≤ 1 MiB），持画布项目锁完成。"""
        self._require_host_state()
        return _update_plugin_state(self._project(), self.plugin_id, self.plugin_version, change)

    def _require_host_state(self) -> None:
        if not self.trusted:
            raise PluginError("CAPABILITY_DENIED", "只有宿主插件可以读写项目状态", status=403)


def _plugin_state_path(project_id: str, plugin_id: str) -> Path:
    from character_workflow.lib.canvas_projects import canvas_project_dir
    try:
        return canvas_project_dir(project_id) / "plugins" / plugin_id / "state.json"
    except KeyError:
        raise PluginError("NOT_FOUND", "找不到这个画布项目（可能已被删除）", status=404) from None


def _read_plugin_state(project_id: str, plugin_id: str):
    from pydantic import ValidationError

    from character_workflow.lib.atomic_io import read_text_with_retry
    from character_workflow.lib.schemas import CanvasPluginState
    path = _plugin_state_path(project_id, plugin_id)
    try:
        text = read_text_with_retry(path)
    except FileNotFoundError:
        return None
    try:
        state = CanvasPluginState.model_validate_json(text)
    except ValidationError as error:
        # 读不出的状态不能静默当空：插件会在旧数据上重建，丢掉用户的记录。
        raise PluginError("PLUGIN_STATE_BROKEN", "插件的项目状态文件损坏", status=500) from error
    if state.plugin_id != plugin_id:
        raise PluginError("PLUGIN_STATE_BROKEN", "插件的项目状态文件损坏", status=500)
    return state


def _update_plugin_state(project_id: str, plugin_id: str, plugin_version: str,
                         change: Callable[[Any], Any]) -> Any:
    from pydantic import ValidationError

    from character_workflow.lib.atomic_io import atomic_write_text
    from character_workflow.lib.canvas_projects import canvas_project_lock_path
    from character_workflow.lib.file_lock import file_lock
    from character_workflow.lib.schemas import CanvasPluginState
    path = _plugin_state_path(project_id, plugin_id)
    with file_lock(canvas_project_lock_path(project_id)):
        current = _read_plugin_state(project_id, plugin_id)
        data = change(current.data if current is not None else None)
        try:
            state = CanvasPluginState(
                schema_version=1, revision=(current.revision + 1) if current is not None else 1,
                plugin_id=plugin_id, plugin_version=plugin_version or "0.0.0", data=data)
        except ValidationError as error:
            if "exceeds 1 MiB" in str(error):
                raise PluginError("PAYLOAD_TOO_LARGE", "插件的项目状态超过 1 MiB", status=413) from error
            raise PluginError("PLUGIN_FAILED", "插件的项目状态不是合法的 JSON 数据", status=500) from error
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, state.model_dump_json())
    return data


def _first_last_video_model(width: int, height: int) -> tuple[str, str, dict]:
    """首尾帧补间用哪个视频模型：默认视频模型能做首尾帧就用它，否则按供应商顺序取第一个能做的。"""
    from character_workflow.lib.canvas_ui import read_canvas_ui_preferences
    from character_workflow.lib.keys import model_modality, read_keys_db
    from character_workflow.lib.video_caps import first_last_video_defaults
    database = read_keys_db()
    keys = sorted([key for key in database.keys if key.enabled],
                  key=lambda key: 0 if key.alias == database.default_alias else 1)
    candidates = [(key, model) for key in keys for model in key.models if model_modality(model, key) == "video"]
    try:
        selection = read_canvas_ui_preferences().generation_defaults.video.selection
    except Exception:  # noqa: BLE001 - 偏好文件读不出时按供应商顺序挑，不挡住插件
        selection = None
    if selection is not None and selection.alias is not None:
        preferred = [(key, model) for key, model in candidates
                     if key.alias == selection.alias and model.id == selection.model]
        candidates = preferred + [item for item in candidates if item not in preferred]
    for key, model in candidates:
        params = first_last_video_defaults(model.protocol, model.id, width, height)
        if params is not None:
            return key.alias, model.id, params
    raise PluginError("NO_MODEL", "没有可用的首尾帧视频模型，请先在设置里添加", status=422)


def _create_generation_draft(project_id: str, prompt: str, frames: list, title: str,
                             beside_node_id: str | None) -> dict:
    """新建视频节点、填草稿、连首尾帧槽，一次变更集提交（与 Agent 同一个入口，校验只有一份）。"""
    from types import SimpleNamespace

    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_layout import _locked_size
    from character_workflow.lib.canvas_agent_schema import ApplyChangesInput
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_tool_common import CanvasToolError
    first, last = frames
    alias, model, params = _first_last_video_model(first.width or 1, first.height or 1)
    node_id = f"video-{secrets.token_hex(6)}"
    principal = SimpleNamespace(kind="local", session_id="plugin", grant_id=None)
    for attempt in range(3):
        document = read_canvas_document(project_id)
        rect = _free_spot(document, beside_node_id, *_locked_size(None, first.width, first.height))
        try:
            tools.apply_changes(principal, ApplyChangesInput(
                project_id=project_id, expected_revision=document.revision, changes=[
                    {"op": "add_surface", "kind": "video", "title": title[:120], "node_id": node_id,
                     "position": {"x": rect.x, "y": rect.y}},
                    # frame_mode 必须写明：服务端只在首尾帧模式下接受 first_frame / last_frame 槽的连线。
                    {"op": "set_draft", "node_id": node_id, "mode": "video", "prompt": prompt,
                     "model": model, "alias": alias, "params": {**params, "frame_mode": "firstlast"}},
                    {"op": "connect", "source_node_id": first.node_id, "target_node_id": node_id,
                     "slot": "first_frame"},
                    {"op": "connect", "source_node_id": last.node_id, "target_node_id": node_id,
                     "slot": "last_frame"},
                ]))
            return {"node_id": node_id, "model": model, "alias": alias, **params}
        except CanvasToolError as error:
            if error.code != "DOCUMENT_CONFLICT" or attempt == 2:
                raise PluginError(error.code, error.message, status=error.status) from error
        except ValueError as error:
            raise PluginError("INVALID_TARGET", str(error)[:200], status=422) from error
    raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409)


def _create_text_node(project_id: str, text: str, title: str, beside_node_id: str | None) -> str:
    """文本节点走与 Agent 相同的变更集入口，校验与落盘规则只有一份。"""
    from types import SimpleNamespace

    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_schema import ApplyChangesInput
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_tool_common import CanvasToolError
    node_id = f"text-{secrets.token_hex(6)}"
    principal = SimpleNamespace(kind="local", session_id="plugin", grant_id=None)
    for attempt in range(3):
        document = read_canvas_document(project_id)
        anchor = next((node for node in document.nodes if node.id == beside_node_id), None)
        position = {"x": 0.0, "y": 0.0}
        if anchor is not None:
            height = anchor.size.height if anchor.size else 240
            position = {"x": anchor.position.x, "y": anchor.position.y + height + 60}
        try:
            tools.apply_changes(principal, ApplyChangesInput(
                project_id=project_id, expected_revision=document.revision,
                changes=[{"op": "add_text", "title": title[:120] or "文本", "text": text,
                          "position": position, "node_id": node_id}]))
            return node_id
        except CanvasToolError as error:
            if error.code != "DOCUMENT_CONFLICT" or attempt == 2:
                raise PluginError(error.code, error.message, status=error.status) from error
        except ValueError as error:
            raise PluginError("INVALID_TARGET", str(error)[:200], status=422) from error
    raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409)


def _media(project_id: str, node: Any, version_id: str) -> PluginMedia:
    from character_workflow.lib.canvas_projects import resolve_canvas_media
    try:
        path, version = resolve_canvas_media(project_id, version_id)
    except (OSError, PermissionError, ValueError) as error:
        raise PluginError("INVALID_TARGET", "读不到这份素材", status=422) from error
    if version.kind != node.type:
        raise PluginError("INVALID_TARGET", "素材类型与节点不符", status=422)
    return PluginMedia(version.kind, node.id, version_id, node.title, path, version.width, version.height,
                       version.duration_ms)


def _free_spot(document: Any, beside_node_id: str | None, width: float, height: float):
    """新节点的落点：从 beside 节点右侧开始，跳过所有会压到的节点（与 Agent 新建节点同一套规则）。"""
    from character_workflow.lib.canvas_agent_layout import node_rect, place
    anchor = next((node for node in document.nodes if node.id == beside_node_id), None)
    obstacles = [node_rect(node, document) for node in document.nodes if node.id != beside_node_id]
    return place(obstacles, node_rect(anchor, document) if anchor is not None else None, width, height)


def _create_image_group(plugin_id: str, project_id: str, pngs: list[bytes], title: str,
                        beside_node_id: str | None) -> list[str]:
    """结果组的封面与成员在同一次提交里落盘：要么整组出现，要么一张都不留。"""
    from character_workflow.lib.canvas_agent_layout import _locked_size
    from character_workflow.lib.canvas_agent_tools import _media_node
    from character_workflow.lib.canvas_projects import read_canvas_document, save_canvas_upload_batch
    from character_workflow.lib.schemas import CanvasResultStack
    node_ids = [f"image-{secrets.token_hex(6)}" for _ in pngs]
    run_id = f"plugin:{plugin_id}:{secrets.token_hex(8)}"
    base = title[:100] or "图片"
    titles = [base, *(f"{base} · {index}" for index in range(2, len(pngs) + 1))]

    def build(versions: list, document: Any) -> list:
        # 整组按一个矩形找落点（插件节点右侧、不压别的节点），成员再在里面按前端结果组的间距排开。
        sizes = [_locked_size(None, version.width, version.height) for version in versions]
        total = sum(width for width, _ in sizes) + RESULT_STACK_GAP * (len(sizes) - 1)
        start = _free_spot(document, beside_node_id, total, max(height for _, height in sizes))
        nodes, x = [], start.x
        for node_id, node_title, version, (width, _) in zip(node_ids, titles, versions, sizes, strict=True):
            nodes.append(_media_node("image", node_id, node_title[:120], {"x": x, "y": start.y}, version.version_id))
            x += width + RESULT_STACK_GAP
        stack = CanvasResultStack(run_id=run_id, member_node_ids=node_ids[1:])
        cover = nodes[0]
        nodes[0] = cover.model_copy(update={"data": cover.data.model_copy(update={"result_stack": stack})})
        return nodes

    for attempt in range(3):
        document = read_canvas_document(project_id)
        try:
            save_canvas_upload_batch(
                project_id, [(".png", png, "image") for png in pngs], document.revision,
                nodes_factory=lambda versions, document=document: build(versions, document))
            return node_ids
        except RuntimeError as error:
            if not str(error).startswith("revision_conflict:") or attempt == 2:
                raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409) from error
        except ValueError as error:
            raise PluginError("INVALID_TARGET", str(error)[:200], status=422) from error
    raise PluginError("DOCUMENT_CONFLICT", "画布正在变化，请重试", status=409)


def _create_image_node(project_id: str, png: bytes, title: str, beside_node_id: str | None) -> str:
    from character_workflow.lib.canvas_agent_tools import _media_node
    from character_workflow.lib.canvas_projects import read_canvas_document, save_canvas_upload
    from character_workflow.lib.canvas_agent_layout import _locked_size
    node_id = f"image-{secrets.token_hex(6)}"

    def build(version, document):
        rect = _free_spot(document, beside_node_id, *_locked_size(None, version.width, version.height))
        return _media_node("image", node_id, title[:120] or "图片", {"x": rect.x, "y": rect.y}, version.version_id)

    for attempt in range(3):
        document = read_canvas_document(project_id)
        try:
            save_canvas_upload(
                project_id, f"{title}.png", "png", png, "image", document.revision,
                node_factory=lambda version, document=document: build(version, document),
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
_loaded: dict[str, tuple[str, PluginServerAPI]] = {}


def _module_name(plugin_id: str) -> str:
    return MODULE_PREFIX + plugin_id.replace("-", "_")


def unload(plugin_id: str) -> None:
    with _lock:
        _loaded.pop(plugin_id, None)
        name = _module_name(plugin_id)
        for key in [key for key in sys.modules if key == name or key.startswith(name + ".")]:
            del sys.modules[key]


def _handlers(record: PluginRecord) -> dict[tuple[str, str], Handler]:
    return _api(record).handlers


def _api(record: PluginRecord) -> PluginServerAPI:
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
        if (api.agent_views or api.tool_filter) and not plugin_registry.is_host(record):
            sys.modules.pop(name, None)
            raise PluginError("PLUGIN_BROKEN", "只有宿主插件可以登记 Agent 节点摘要或隐藏工具", status=500)
        _loaded[record.plugin_id] = (record.lock.digest, api)
    return api


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
    # 只给 Agent 的路由（ADR-0043）对浏览器入口等于没声明：中间件按未登记拒绝。
    return route.access if route and not route.agent_only else None


def hidden_agent_tools(plugin_id: str) -> set[str]:
    """此刻要藏起来的 Agent 工具名（清单里的短名）。判断出错时整组藏起（宁可不给，也不误给）。"""
    record = plugin_registry.find(plugin_id)
    if (record is None or record.lock is None or not plugin_registry.is_host(record)
            or plugin_id not in plugin_registry.enabled_ids() or not record.lock.contributes.agent_tools):
        return set()
    try:
        filter_ = _api(record).tool_filter
        return set(filter_()) if filter_ is not None else set()
    except Exception:
        logger.exception("plugin %s hidden_agent_tools failed", plugin_id)
        return {tool.name for tool in record.lock.contributes.agent_tools}


def _surface_inputs(record: PluginRecord, project_id: str, node_id: str | None,
                    version_ids: list[str]) -> list[PluginMedia]:
    """界面带来的素材版本，必须此刻真的连在它自己的节点上，且类型在该节点类型的 `input_modalities` 里。"""
    from character_workflow.lib.canvas_projects import read_canvas_document
    assert record.lock is not None
    document = read_canvas_document(project_id)
    node = next((item for item in document.nodes if item.id == node_id), None)
    if node is None or node.type != "plugin" or node.data.plugin_id != record.plugin_id:
        raise PluginError("INVALID_TARGET", "这个节点不属于此插件", status=403)
    contribution = next((item for item in record.lock.contributes.nodes if item.type == node.data.node_type), None)
    kinds = {kind for kind in (contribution.input_modalities if contribution else []) if kind in MEDIA_KINDS}
    nodes = {item.id: item for item in document.nodes}
    sources = [source for edge in document.connections
               if edge.role == "input" and edge.target_node_id == node_id
               and (source := nodes.get(edge.source_node_id)) is not None]
    if contribution is not None and contribution.expand_result_stack:
        # 连的是结果组封面：此刻还在组里的成员也算连在这个节点上。
        sources += [member for source in list(sources)
                    if source.type == "image" and source.data.result_stack
                    for member_id in source.data.result_stack.member_node_ids
                    if (member := nodes.get(member_id)) is not None and member.type == "image"]
    connected = {source.data.current_version_id: source for source in sources
                 if source.type in kinds and source.data.current_version_id}
    media = []
    for version_id in version_ids:
        source = connected.get(version_id)
        if source is None:
            raise PluginError("INVALID_HANDLE", "素材没有连到这个节点", status=403)
        media.append(_media(project_id, source, version_id))
    return media


def call(plugin_id: str, method: str, path: str, *, project_id: str | None, origin: str,
         params: dict | None = None, node_id: str | None = None,
         input_version_ids: list[str] | None = None, caller: str = "") -> tuple[dict, list[str]]:
    """调用一条插件路由。返回 (结果, 这次调用新建的节点 id)。"""
    record = _enabled_record(plugin_id)
    assert record.lock is not None
    server = record.lock.contributes.server
    route = next((item for item in (server.routes if server else [])
                  if item.method == method and item.path == path), None)
    if route is None:
        raise PluginError("ROUTE_NOT_DECLARED", "插件没有声明这个接口", status=404)
    if route.agent_only and origin != "agent":
        raise PluginError("CAPABILITY_DENIED", "这个接口只给 Agent 用", status=403)
    host = plugin_registry.is_host(record)
    if (origin == "host" and not host) or (origin == "surface" and host):
        # 宿主插件的界面走宿主入口、沙箱插件的界面走 surface 入口；沙箱插件不能借宿主入口绕过项目批准。
        # Agent 入口两种插件都可以（宿主插件的 Agent 工具，ADR-0043）。
        raise PluginError("CAPABILITY_DENIED", "这个入口不能调用此插件", status=403)
    if host:
        capabilities: frozenset[str] = frozenset()
    elif project_id is None:
        raise PluginError("PROJECT_REQUIRED", "这个操作需要在画布项目里进行", status=422)
    else:
        granted = plugin_grants.active_grants(project_id).get(plugin_id)
        if granted is None:
            raise PluginError("PLUGIN_NOT_GRANTED", "本项目尚未允许此插件", status=403)
        capabilities = frozenset(granted["capabilities"])
    if origin == "surface" and "server.call" not in capabilities:
        raise PluginError("CAPABILITY_DENIED", "本项目没有允许这项能力", status=403)
    request = PluginRequest(plugin_id, project_id, origin, capabilities, node_id=node_id,
                            plugin_version=record.lock.version, caller=caller if origin == "agent" else "",
                            trusted=host)
    if origin == "surface":
        request.inputs = _surface_inputs(record, project_id, node_id, input_version_ids or [])
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


def node_agent_view(document: Any, node: Any) -> dict:
    """画布 Agent 看到的插件节点额外摘要。插件未启用、不是宿主插件或没登记时为空，且不 import 插件代码。"""
    if node.type != "plugin":
        return {}
    record = plugin_registry.find(node.data.plugin_id)
    if not plugin_registry.is_host(record) or node.data.plugin_id not in plugin_registry.enabled_ids():
        return {}
    view = _api(record).agent_views.get(node.data.node_type)
    return view(document, node) if view is not None else {}
