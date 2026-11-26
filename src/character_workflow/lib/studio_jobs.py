"""Studio standalone job helpers. namespace='studio', 输出落到 <data_root>/studio/<job_id>/."""
from __future__ import annotations

import uuid
from pathlib import Path

from character_workflow.lib.data_root import resolve_data_root


def studio_root() -> Path:
    return resolve_data_root() / "studio"


def studio_output_dir(job_id: str) -> Path:
    """Studio job 写盘路径. 与 characters/<id>/<slot>/ 物理隔离."""
    d = studio_root() / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# 新节点放在画布现有内容右侧，留一段空隙；没有尺寸的节点按默认卡宽估算。
_CANVAS_GAP = 80
_CANVAS_DEFAULT_NODE_WIDTH = 320
_CANVAS_TITLE_LENGTH = 40


def add_job_output_to_canvas(job_id: str, output_index: int, project_id: str) -> dict:
    """在同一笔画布事务里复制 Studio 输出、不可变参数与所有输入素材。"""
    from character_workflow.lib.canvas_projects import (
        _new_upload_version, _now, _read_canvas_document_unlocked,
        _recover_canvas_transactions_unlocked, canvas_project_lock_path, upload_max_bytes,
    )
    from character_workflow.lib.canvas_reproduce import _commit
    from character_workflow.lib.collab_provenance import studio_output_snapshot
    from character_workflow.lib.file_lock import file_lock
    from character_workflow.lib.jobs import read_job
    from character_workflow.lib.schemas import (
        CanvasDocument, CanvasImageNode, CanvasMediaNodeData, CanvasPoint, CanvasVideoNode,
    )

    job = read_job(job_id)
    source, frozen, inputs = studio_output_snapshot(job, output_index)
    timestamp = _now()
    versions = {}
    writes = []

    def prepare(path: Path, kind: str):
        ext = path.suffix.lower()
        if path.stat().st_size > upload_max_bytes(ext):
            raise ValueError("文件超过画布导入大小上限")
        body = path.read_bytes()
        version, target = _new_upload_version(project_id, ext, body, kind, timestamp)
        writes.append((target, body))
        return version

    rewritten = {}
    input_kinds = {row.version_id: row.kind for row in frozen.inputs}
    for old_id, path in inputs.items():
        version = prepare(path, input_kinds[old_id])
        versions[version.version_id] = version
        rewritten[old_id] = version.version_id
    frozen = frozen.model_copy(update={"inputs": [
        row.model_copy(update={"version_id": rewritten[row.version_id]}) for row in frozen.inputs
    ]})
    output = prepare(source, frozen.mode).model_copy(update={"frozen_generation": frozen})
    versions[output.version_id] = output
    node_type = CanvasImageNode if output.kind == "image" else CanvasVideoNode
    title = " ".join(job.prompt.split())[:_CANVAS_TITLE_LENGTH] or ("图片" if output.kind == "image" else "视频")
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        right = max((node.position.x + (node.size.width if node.size else _CANVAS_DEFAULT_NODE_WIDTH)
                     for node in current.nodes), default=-_CANVAS_GAP)
        top = min((node.position.y for node in current.nodes), default=0)
        node = node_type(
            id=f"studio-{uuid.uuid4().hex[:12]}", type=output.kind, title=title,
            position=CanvasPoint(x=right + _CANVAS_GAP, y=top),
            data=CanvasMediaNodeData(current_version_id=output.version_id),
        )
        updated = CanvasDocument.model_validate(current.model_copy(update={
            "nodes": [*current.nodes, node], "revision": current.revision + 1,
            "updated_at": timestamp, "content_versions": {**current.content_versions, **versions},
        }).model_dump(mode="json"))
        _commit(project_id, updated, writes, timestamp)
    return {"project_id": project_id, "node_id": node.id, "revision": updated.revision}
