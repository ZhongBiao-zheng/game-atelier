"""项目锁内合并节点操作。会话身份由调用者从房主签发的令牌取得。"""
from __future__ import annotations

import hashlib
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from character_workflow.lib.canvas_projects import (
    _check_new_plugin_connections, _normalized_web_document, _now, _read_canvas_document_unlocked,
    _recover_canvas_transactions_unlocked, canvas_project_lock_path,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.plugin_registry import HOST_PLUGIN_IDS
from character_workflow.lib.schemas import (
    CanvasConnection, CanvasDocument, CanvasNode, CanvasPoint, CanvasTextVersion,
)


class CollabOpError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class _Operation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op_id: str = Field(min_length=1, max_length=120)
    base_revision: int = Field(ge=0)
    undo_of: str | None = Field(default=None, max_length=120)
    client_id: str | None = Field(default=None, max_length=120)
    actor_name: str | None = Field(default=None, max_length=120)


class NodeAdd(_Operation):
    kind: Literal["node_add"]
    node: CanvasNode
    text_versions: list[CanvasTextVersion] = Field(default_factory=list, max_length=1)


class NodeUpdate(_Operation):
    kind: Literal["node_update", "annotation_update", "image_edit_update", "layer_order_update", "plugin_payload_update"]
    node_id: str
    patch: dict[str, Any]
    base_payload: dict | None = None
    text_versions: list[CanvasTextVersion] = Field(default_factory=list, max_length=1)
    # 正文写入基于的版本：当前版本已不是它（期间被别人改过）就拒绝，不静默覆盖。
    base_version_id: str | None = Field(default=None, max_length=200)


class NodeMoves(_Operation):
    kind: Literal["node_move_batch"]
    positions: dict[str, CanvasPoint] = Field(min_length=1, max_length=10000)


class NodeDelete(_Operation):
    kind: Literal["node_delete"]
    node_ids: list[str] = Field(min_length=1, max_length=10000)


class Restore(_Operation):
    kind: Literal["restore"]
    undo_of: str = Field(min_length=1, max_length=120)


class ConnectionAdd(_Operation):
    kind: Literal["connection_add"]
    connection: CanvasConnection


class ConnectionDelete(_Operation):
    kind: Literal["connection_delete"]
    connection_id: str


CollabOp = Annotated[
    NodeAdd | NodeUpdate | NodeMoves | NodeDelete | ConnectionAdd | ConnectionDelete | Restore,
    Field(discriminator="kind"),
]
_OP = TypeAdapter(CollabOp)
_NODE = TypeAdapter(CanvasNode)
_HISTORY_SIZE = 200


@dataclass(frozen=True)
class AppliedOp:
    revision: int
    touched_node_ids: frozenset[str]
    conflict_clients: frozenset[str]
    duplicate: bool = False


@dataclass
class _Entry:
    op_id: str | None
    client: str
    revision: int
    touched: frozenset[str]
    old_nodes: dict[str, CanvasNode | None] = field(default_factory=dict)
    old_edges: dict[str, CanvasConnection | None] = field(default_factory=dict)


@dataclass
class _History:
    revision: int
    nodes: dict[str, bytes]
    edges: dict[str, tuple[str, str, bytes]]
    entries: deque[_Entry] = field(default_factory=lambda: deque(maxlen=_HISTORY_SIZE))


# Access under the project's file lock, keyed by its resolved path for isolated instances.
_histories: dict[str, _History] = {}


def _fingerprints(doc: CanvasDocument):
    nodes = {node.id: hashlib.sha256(node.model_dump_json().encode()).digest() for node in doc.nodes}
    edges = {edge.id: (edge.source_node_id, edge.target_node_id,
                        hashlib.sha256(edge.model_dump_json().encode()).digest())
             for edge in doc.connections}
    return nodes, edges


def _changed_nodes(before: _History, nodes: dict, edges: dict) -> frozenset[str]:
    changed = {key for key in nodes.keys() | before.nodes.keys()
               if nodes.get(key) != before.nodes.get(key)}
    for key in edges.keys() | before.edges.keys():
        if before.edges.get(key) != edges.get(key):
            for edge in [before.edges.get(key), edges.get(key)]:
                if edge:
                    changed.update(edge[:2])
    return frozenset(changed)


def _history(path: str, current: CanvasDocument) -> _History:
    history = _histories.get(path)
    if history and history.revision == current.revision:
        return history
    nodes, edges = _fingerprints(current)
    if history is None or history.revision > current.revision:
        history = _histories[path] = _History(current.revision, nodes, edges)
    else:
        # A local editor, Agent or generation changed the file between two guest operations.
        history.entries.append(_Entry(None, "host", current.revision, _changed_nodes(history, nodes, edges)))
        history.nodes, history.edges, history.revision = nodes, edges, current.revision
    return history


def forget_room(project_id: str) -> None:
    path = canvas_project_lock_path(project_id)
    with file_lock(path):
        _histories.pop(str(path), None)


def _checked_node(nodes: dict, node_id: str):
    try:
        return nodes[node_id]
    except KeyError:
        raise CollabOpError(409, "节点已删除，请刷新画布") from None


def _text_versions(doc, op, node):
    for version in op.text_versions:
        if (node.type != "text" or node.data.current_version_id != version.version_id
                or version.origin.kind != "user_edit" or version.frozen_generation is not None):
            raise CollabOpError(422, "只能随文本节点提交它的新文本版本")
        if version.version_id in doc.content_versions:
            raise CollabOpError(409, "文本版本已存在")
        doc.content_versions[version.version_id] = version


def _text_already_applied(document: CanvasDocument, op) -> bool:
    if not isinstance(op, NodeUpdate) or not op.text_versions:
        return False
    version = op.text_versions[0]
    node = next((item for item in document.nodes if item.id == op.node_id), None)
    stored = document.content_versions.get(version.version_id)
    return (node is not None and node.type == "text" and node.data.current_version_id == version.version_id
            and stored is not None and stored.kind == "text" and stored.text == version.text)


def _update_node(node, patch, base_payload=None):
    if not patch or patch.keys() - {"title", "position", "size", "hidden", "z_index", "data"}:
        raise CollabOpError(422, "节点变更字段无效")
    raw = node.model_dump(mode="json")
    if "data" in patch:
        data = patch["data"]
        if not isinstance(data, dict):
            raise CollabOpError(422, "节点数据无效")
        if (node.type == "plugin" and (node.data.plugin_id not in HOST_PLUGIN_IDS
                or data.keys() - {"payload", "generation_draft"})):
            raise CollabOpError(403, "这个插件节点仅可查看")
        if node.type == "plugin" and "payload" in data:
            if (node.data.plugin_id, node.data.node_type) != ("storyboard", "board"):
                raise CollabOpError(403, "这个插件节点仅可查看")
            from character_workflow.lib.collab_sanitize import merge_storyboard_edit
            try:
                payload = merge_storyboard_edit(node.data.payload, base_payload, data["payload"])
            except ValueError as error:
                raise CollabOpError(409, str(error)) from error
            data = {**data, "payload": payload}
        for key in ("active_run_id", "error"):
            if key in data and data[key] != raw["data"].get(key):
                raise CollabOpError(403, "运行状态只能由房主服务更新")
        patch = {**patch, "data": {**raw["data"], **data}}
    return _NODE.validate_python({**raw, **patch})


def _delete_nodes(document, nodes, op, client_id, owner):
    deleted = set(op.node_ids)
    for node_id in deleted:
        node = _checked_node(nodes, node_id)
        if not owner and node.created_by_client != client_id:
            raise CollabOpError(403, "仅房主可删除他人创建的节点")
    remaining = [node for node in document.nodes if node.id not in deleted]
    for node in remaining:
        if node.type == "group":
            node.data.member_node_ids = [key for key in node.data.member_node_ids if key not in deleted]
        elif node.type == "image_edit":
            for key in ("reference_node_id", "source_node_id"):
                if getattr(node.data, key) in deleted:
                    setattr(node.data, key, None)
        elif node.type == "layer_stack":
            if node.data.base_material_node_id in deleted:
                node.data.base_material_node_id = None
            for layer in node.data.layers:
                if layer.material_node_id in deleted:
                    layer.material_node_id = None
        elif node.type == "image" and node.data.result_stack:
            stack = node.data.result_stack
            stack.member_node_ids = [key for key in stack.member_node_ids if key not in deleted]
            if not stack.member_node_ids:
                node.data.result_stack = None
    document.nodes = remaining
    document.connections = [edge for edge in document.connections
                            if edge.source_node_id not in deleted and edge.target_node_id not in deleted]


def _apply(document: CanvasDocument, op, client_id: str, actor_name: str, owner: bool):
    nodes = {node.id: node for node in document.nodes}
    if isinstance(op, NodeAdd):
        if op.node.id in nodes:
            raise CollabOpError(409, "节点已存在")
        node = op.node.model_copy(update={"created_by_client": client_id, "created_by": actor_name})
        if node.collab_run is not None:
            raise CollabOpError(403, "共享生成任务只能由房主服务创建")
        if node.type == "plugin" and node.data.plugin_id not in HOST_PLUGIN_IDS:
            raise CollabOpError(403, "这个插件节点仅可查看")
        if getattr(node.data, "active_run_id", None) or getattr(node.data, "error", None):
            raise CollabOpError(403, "运行状态只能由房主服务更新")
        _text_versions(document, op, node)
        nodes[node.id] = node
    elif isinstance(op, NodeUpdate):
        existing = _checked_node(nodes, op.node_id)
        if ("base_version_id" in op.model_fields_set and existing.type == "text"
                and existing.data.current_version_id != op.base_version_id):
            raise CollabOpError(409, "正文已被他人更新")
        node = _update_node(existing, op.patch, op.base_payload)
        _text_versions(document, op, node)
        nodes[node.id] = node
    elif isinstance(op, NodeMoves):
        for target, position in op.positions.items():
            nodes[target] = _checked_node(nodes, target).model_copy(update={"position": position})
    elif isinstance(op, NodeDelete):
        _delete_nodes(document, nodes, op, client_id, owner)
        return
    elif isinstance(op, ConnectionAdd):
        document.connections.append(op.connection)
    elif isinstance(op, ConnectionDelete):
        edges = [edge for edge in document.connections if edge.id != op.connection_id]
        if len(edges) == len(document.connections):
            raise CollabOpError(409, "连线已删除")
        document.connections = edges
    document.nodes = list(nodes.values())


def _changes(before, after):
    previous = {row.id: row for row in before}
    current = {row.id: row for row in after}
    return {key: previous.get(key) for key in previous.keys() | current.keys()
            if previous.get(key) != current.get(key)}


def _restore(rows, previous):
    values = {row.id: row for row in rows}
    for key, row in previous.items():
        if row is None:
            values.pop(key, None)
        else:
            values[key] = row.model_copy(deep=True)
    return list(values.values())


def apply_op(
    project_id: str, op: CollabOp | dict, *, client_id: str, actor_name: str,
    authorize: Callable[[], None], owner: bool = False,
) -> AppliedOp:
    op = _OP.validate_python(op)
    path = canvas_project_lock_path(project_id)
    with file_lock(path):
        authorize()
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        history = _history(str(path), current)
        original = next((e for e in history.entries if e.op_id == op.op_id), None)
        if original:
            if original.client != client_id:
                raise CollabOpError(409, "操作标识已使用")
            return AppliedOp(original.revision, original.touched, frozenset(), duplicate=True)
        if _text_already_applied(current, op):
            # 房主重启丢了操作记录，但这份正文已经落盘：按同一操作的幂等重放处理。
            return AppliedOp(current.revision, frozenset({op.node_id}), frozenset(), duplicate=True)
        if op.base_revision > current.revision:
            raise CollabOpError(409, "画布版本无效，请刷新画布")
        if len(history.entries) == _HISTORY_SIZE and op.base_revision < history.entries[0].revision - 1:
            raise CollabOpError(409, "画布已更新，请重新载入")
        if op.undo_of:
            previous = next((e for e in history.entries if e.op_id == op.undo_of), None)
            if not previous or previous.client != client_id or any(
                e.client != client_id and e.revision > previous.revision and e.touched & previous.touched
                for e in history.entries
            ):
                raise CollabOpError(409, "该节点已被他人修改，无法撤回")
        document = current.model_copy(deep=True)
        if isinstance(op, Restore):
            document.nodes = _restore(document.nodes, previous.old_nodes)
            document.connections = _restore(document.connections, previous.old_edges)
        else:
            _apply(document, op, client_id, actor_name, owner)
        stamp = _now()
        checked = CanvasDocument.model_validate(document.model_dump(mode="json"))
        checked = _normalized_web_document(current, checked, stamp)
        checked.sync_layer_materials()
        _check_new_plugin_connections(current, checked)
        nodes, edges = _fingerprints(checked)
        touched = _changed_nodes(history, nodes, edges)
        conflicts = frozenset(
            e.client for e in history.entries if e.revision > op.base_revision
            and e.client != client_id and e.touched.intersection(touched)
        )
        authorize()
        if checked.revision != current.revision:
            _commit(project_id, checked, [], stamp)
        history.entries.append(_Entry(op.op_id, client_id, checked.revision, touched,
                                      _changes(current.nodes, checked.nodes),
                                      _changes(current.connections, checked.connections)))
        history.nodes, history.edges, history.revision = nodes, edges, checked.revision
        return AppliedOp(checked.revision, touched, conflicts)


def record_committed_change(
    project_id: str, before: CanvasDocument, after: CanvasDocument, *, op_id: str, client_id: str,
) -> AppliedOp:
    """Register a host-side upload or mask transaction while its caller still holds the project lock."""
    if before.project_id != project_id or after.project_id != project_id or after.revision <= before.revision:
        raise ValueError("共享操作版本不匹配")
    path = str(canvas_project_lock_path(project_id))
    history = _history(path, before)
    nodes, edges = _fingerprints(after)
    touched = _changed_nodes(history, nodes, edges)
    history.entries.append(_Entry(op_id, client_id, after.revision, touched,
                                  _changes(before.nodes, after.nodes), _changes(before.connections, after.connections)))
    history.nodes, history.edges, history.revision = nodes, edges, after.revision
    return AppliedOp(after.revision, touched, frozenset())
