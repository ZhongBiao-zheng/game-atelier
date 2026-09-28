"""跨画布粘贴：把另一张画布上复制的节点连同其媒体一起落进目标画布。

媒体版本归项目所有（/media 按项目目录校验，不能跨项目引用），所以粘贴不是改几个 id，
而是把源画布的字节复制进目标画布的 uploads/、生成新版本，再把节点里所有对旧版本 id 的
引用整体换成新 id。节点 id 由前端预先换新（与同画布粘贴同一套 idMap），服务端只查冲突。
"""
from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from character_workflow.lib.canvas_projects import (
    CanvasDocumentError,
    _now,
    _read_canvas_document_unlocked,
    _recover_canvas_transactions_unlocked,
    canvas_project_dir,
    canvas_project_lock_path,
    read_canvas_document,
    resolve_canvas_media,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasConnection,
    CanvasContentVersion,
    CanvasDocument,
    CanvasMediaVersion,
    CanvasNode,
    CanvasTextVersion,
    CanvasUploadOrigin,
    CanvasUserEditOrigin,
)

_NODES = TypeAdapter(list[CanvasNode])


def _copied_version(
    source_project_id: str,
    version: CanvasContentVersion,
    target_project_id: str,
    timestamp: str,
) -> tuple[CanvasContentVersion, tuple[Path, bytes] | None]:
    version_id = f"version-{secrets.token_hex(12)}"
    if isinstance(version, CanvasTextVersion):
        copied = version.model_copy(update={
            "version_id": version_id, "created_at": timestamp,
            "origin": CanvasUserEditOrigin(kind="user_edit"),
        })
        return copied, None
    source_path, _ = resolve_canvas_media(source_project_id, version.version_id)
    upload_id = secrets.token_hex(16)
    target = canvas_project_dir(target_project_id) / "uploads" / f"{upload_id}{source_path.suffix}"
    copied = CanvasMediaVersion.model_validate({
        **version.model_dump(mode="json"),
        "version_id": version_id,
        "created_at": timestamp,
        "origin": CanvasUploadOrigin(kind="upload", upload_id=upload_id).model_dump(),
        "path": target.relative_to(canvas_project_dir(target_project_id)).as_posix(),
    })
    return copied, (target, source_path.read_bytes())


def _rewritten(value: Any, mapping: dict[str, str]) -> Any:
    """节点 JSON 里凡是等于旧版本 id 的字符串都换成新 id——版本引用散在十几个字段里，
    按字段枚举必漏，按值替换不会。版本 id 是随机 token，不会与别的字符串撞。"""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_rewritten(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: _rewritten(item, mapping) for key, item in value.items()}
    return value


def paste_nodes_into_canvas(
    *,
    project_id: str,
    source_project_id: str,
    nodes: list[CanvasNode],
    connections: list[CanvasConnection],
    document_revision: int,
) -> CanvasDocument:
    if source_project_id == project_id:
        raise CanvasDocumentError("canvas_paste_same_project", "同一张画布内的粘贴不走复制。")
    if not nodes:
        raise CanvasDocumentError("canvas_paste_empty", "没有可粘贴的节点。")
    source = read_canvas_document(source_project_id)
    raw_nodes = [node.model_dump(mode="json") for node in nodes]
    referenced = {
        value for node in raw_nodes for value in _strings(node) if value in source.content_versions
    }
    timestamp = _now()
    mapping: dict[str, str] = {}
    versions: list[CanvasContentVersion] = []
    writes: list[tuple[Path, bytes]] = []
    for version_id in sorted(referenced):
        copied, write = _copied_version(
            source_project_id, source.content_versions[version_id], project_id, timestamp,
        )
        mapping[version_id] = copied.version_id
        versions.append(copied)
        if write is not None:
            writes.append(write)
    pasted = _NODES.validate_python([
        _detached(_rewritten(node, mapping)) for node in raw_nodes
    ])
    pasted_ids = {node.id for node in pasted}
    kept_connections = [
        connection for connection in connections
        if connection.source_node_id in pasted_ids and connection.target_node_id in pasted_ids
    ]

    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != document_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        taken = {node.id for node in current.nodes} & pasted_ids
        if taken:
            raise CanvasDocumentError(
                "canvas_paste_node_id_taken", f"节点 id 已存在于目标画布：{', '.join(sorted(taken))}",
            )
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [*current.nodes, *pasted],
            "connections": [*current.connections, *kept_connections],
            "content_versions": {
                **current.content_versions,
                **{version.version_id: version for version in versions},
            },
        })
        # model_copy 不跑校验：落盘前按 CanvasDocument 整体校验一次。
        document = CanvasDocument.model_validate(updated.model_dump(mode="json"))
        _commit(project_id, document, writes, timestamp)
    return document


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)


def _detached(node: dict[str, Any]) -> dict[str, Any]:
    """运行态与批次归属留在源画布：进行中的 run 和批次绑定在目标画布里没有对应的 job。"""
    data = node.get("data")
    if isinstance(data, dict):
        node = {**node, "data": {
            **data,
            **({"active_run_id": None} if "active_run_id" in data else {}),
            **({"batch_result": None} if "batch_result" in data else {}),
        }}
    return node
