"""canvas_* tool business layer: typed change sets over the same canvas library the Web uses.

ADR-0017 决定 4：画布是 server 持有、带修订号的活文档，Agent 只能经这里改，不能改文件。
授权与工坊分开（grant.canvas_project_ids + canvas_* 能力）；生成按能力分级（canvas_generate）。
"""
from __future__ import annotations

import base64
import hashlib
import io
import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib.canvas_projects import (
    AUDIO_UPLOAD_EXTS, IMAGE_UPLOAD_EXTS, VIDEO_UPLOAD_EXTS, CanvasDocumentError,
    list_canvas_project_options, read_canvas_document, read_canvas_project, resolve_canvas_media,
    save_canvas_document, save_canvas_upload, upload_max_bytes,
)
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasListModelsInput, CanvasListProjectsInput, CanvasProjectInput,
    CanvasReadMediaInput, GetRunInput, ImportMediaInput, RunInput,
)
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.schemas import (
    CanvasAudioNode, CanvasConnection, CanvasContentNodeData, CanvasDocument,
    CanvasGenerationDraft, CanvasImageNode, CanvasInputConnection, CanvasMediaNodeData, CanvasNode,
    CanvasPoint, CanvasTextNode, CanvasTextNodeData, CanvasTextVersion, CanvasUserEditOrigin, Job,
    JobParams, canvas_allowed_draft_params,
)
from character_workflow.lib.workshop import WorkshopError, actor_id

CANVAS_CAPABILITIES = frozenset({"canvas_read", "canvas_edit", "canvas_generate"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def authorize(principal: Any, project_id: str, capability: str) -> None:
    actor_id(principal)
    if principal.kind != "local" and (
        project_id not in getattr(principal, "canvas_project_ids", frozenset())
        or capability not in principal.capabilities
    ):
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "当前授权不允许操作这个画布", 403)
    try:
        read_canvas_project(project_id)
    except (KeyError, ValueError, OSError):
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "画布不存在或不在当前授权中", 404) from None


def list_projects(principal: Any, payload: CanvasListProjectsInput) -> dict:
    actor_id(principal)
    allowed = None if principal.kind == "local" else getattr(principal, "canvas_project_ids", frozenset())
    rows = [
        {"project_id": p.project_id, "name": p.name, "updated_at": p.updated_at}
        for p in list_canvas_project_options() if allowed is None or p.project_id in allowed
    ]
    return {"projects": rows}


def _text_of(document: CanvasDocument, node: CanvasNode, limit: int = 4000) -> dict:
    version = document.content_versions.get(node.data.current_version_id or "")
    if version is None or version.kind != "text":
        return {"text": None, "text_truncated": False}
    return {"text": version.text[:limit], "text_truncated": len(version.text) > limit}


def _draft_view(draft: CanvasGenerationDraft | None) -> dict | None:
    if draft is None:
        return None
    return {"mode": draft.mode, "prompt": draft.prompt, "model": draft.model, "alias": draft.alias,
            "input_policy": draft.input_policy,
            "params": canvas_allowed_draft_params(draft.mode, draft.params)}


def document_view(document: CanvasDocument) -> dict:
    nodes = []
    for node in document.nodes:
        row: dict[str, Any] = {
            "id": node.id, "type": node.type, "title": node.title,
            "position": node.position.model_dump(),
            "size": node.size.model_dump() if node.size else None,
        }
        if node.type in {"text", "image", "video", "audio"}:
            row["version_id"] = node.data.current_version_id
            row["draft"] = _draft_view(node.data.generation_draft)
            row["active_run_id"] = node.data.active_run_id
            if node.type == "text":
                row.update(_text_of(document, node))
        elif node.type == "config":
            row["draft"] = _draft_view(node.data.draft)
        elif node.type == "group":
            row["member_node_ids"] = node.data.member_node_ids
        nodes.append(row)
    media = [
        {"version_id": vid, "kind": v.kind, "mime_type": v.mime_type,
         "width": v.width, "height": v.height, "duration_ms": v.duration_ms, "origin": v.origin.kind}
        for vid, v in document.content_versions.items() if v.kind != "text"
    ]
    connections = [
        {"id": edge.id, "role": edge.role, "source_node_id": edge.source_node_id,
         "target_node_id": edge.target_node_id,
         "slot": edge.slot if edge.role == "input" else None}
        for edge in document.connections
    ]
    return {"project_id": document.project_id, "revision": document.revision, "nodes": nodes,
            "connections": connections, "media_versions": media}


def get_document(principal: Any, payload: CanvasProjectInput) -> dict:
    authorize(principal, payload.project_id, "canvas_read")
    return document_view(read_canvas_document(payload.project_id))


def list_models(principal: Any, payload: CanvasListModelsInput) -> dict:
    from character_workflow.lib.workshop_generation import model_rows
    authorize(principal, payload.project_id, "canvas_read")
    return {"models": model_rows(payload.mode)}


def _find_node(document: CanvasDocument, node_id: str) -> CanvasNode:
    node = next((n for n in document.nodes if n.id == node_id), None)
    if node is None:
        raise WorkshopError("INVALID_TARGET", f"画布里没有节点 {node_id}", 422)
    return node


def _text_version(text: str, timestamp: str) -> CanvasTextVersion:
    return CanvasTextVersion(
        version_id=f"txt-{uuid.uuid4().hex[:16]}", created_at=timestamp,
        sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        origin=CanvasUserEditOrigin(kind="user_edit"), kind="text", text=text,
    )


def _media_node(kind: str, node_id: str, title: str, position: CanvasPoint,
                version_id: str | None):
    if kind == "image":
        return CanvasImageNode(id=node_id, title=title, position=position, type="image",
                               data=CanvasMediaNodeData(current_version_id=version_id))
    if kind == "video":
        from character_workflow.lib.schemas import CanvasVideoNode
        return CanvasVideoNode(id=node_id, title=title, position=position, type="video",
                               data=CanvasMediaNodeData(current_version_id=version_id))
    return CanvasAudioNode(id=node_id, title=title, position=position, type="audio",
                           data=CanvasContentNodeData(current_version_id=version_id))


def _apply(document: CanvasDocument, changes: list, timestamp: str) -> tuple[CanvasDocument, dict]:
    nodes: list[CanvasNode] = list(document.nodes)
    connections: list[CanvasConnection] = list(document.connections)
    versions = dict(document.content_versions)
    created: dict[str, list[str]] = {"node_ids": [], "connection_ids": [], "version_ids": []}
    existing_ids = {n.id for n in nodes}

    def new_node_id(requested: str | None) -> str:
        node_id = requested or f"mcp-{uuid.uuid4().hex[:12]}"
        if node_id in existing_ids:
            raise WorkshopError("INVALID_TARGET", f"节点 {node_id} 已存在", 422)
        existing_ids.add(node_id)
        created["node_ids"].append(node_id)
        return node_id

    def replace(node_id: str, updated: CanvasNode) -> None:
        nonlocal nodes
        nodes = [updated if n.id == node_id else n for n in nodes]

    for change in changes:
        if change.op == "add_text":
            version = _text_version(change.text, timestamp)
            versions[version.version_id] = version
            created["version_ids"].append(version.version_id)
            nodes.append(CanvasTextNode(
                id=new_node_id(change.node_id), title=change.title,
                position=CanvasPoint(**change.position.model_dump()), type="text",
                data=CanvasTextNodeData(current_version_id=version.version_id),
            ))
        elif change.op == "add_media_node":
            version = versions.get(change.version_id)
            if version is None or version.kind == "text":
                raise WorkshopError("REFERENCE_NOT_ALLOWED", "媒体版本不属于这个画布", 403)
            nodes.append(_media_node(version.kind, new_node_id(change.node_id), change.title,
                                     CanvasPoint(**change.position.model_dump()), version.version_id))
        elif change.op == "add_surface":
            nodes.append(_media_node(change.kind, new_node_id(change.node_id), change.title,
                                     CanvasPoint(**change.position.model_dump()), None))
        elif change.op == "set_text":
            node = _find_node(document.model_copy(update={"nodes": nodes}), change.node_id)
            if node.type != "text":
                raise WorkshopError("INVALID_TARGET", "只能改写文本节点的内容", 422)
            version = _text_version(change.text, timestamp)
            versions[version.version_id] = version
            created["version_ids"].append(version.version_id)
            replace(node.id, node.model_copy(update={
                "data": node.data.model_copy(update={"current_version_id": version.version_id}),
            }))
        elif change.op == "set_draft":
            node = _find_node(document.model_copy(update={"nodes": nodes}), change.node_id)
            if node.type not in {"text", "image", "video", "audio", "config"}:
                raise WorkshopError("INVALID_TARGET", "这个节点不能承载生成配置", 422)
            field = "draft" if node.type == "config" else "generation_draft"
            current = getattr(node.data, field)
            policy = change.input_policy or (current.input_policy if current else "all_connected")
            params = JobParams(**canvas_allowed_draft_params(
                change.mode, JobParams(**change.params)))
            draft = CanvasGenerationDraft(mode=change.mode, prompt=change.prompt, model=change.model,
                                          alias=change.alias, input_policy=policy, params=params,
                                          updated_at=timestamp)
            replace(node.id, node.model_copy(update={"data": node.data.model_copy(update={field: draft})}))
        elif change.op == "connect":
            scratch = document.model_copy(update={"nodes": nodes})
            _find_node(scratch, change.source_node_id)
            _find_node(scratch, change.target_node_id)
            edge = CanvasInputConnection(id=f"edge-{uuid.uuid4().hex[:12]}", role="input",
                                         source_node_id=change.source_node_id,
                                         target_node_id=change.target_node_id, slot=change.slot)
            connections.append(edge)
            created["connection_ids"].append(edge.id)
        elif change.op == "disconnect":
            edge = next((e for e in connections if e.id == change.connection_id), None)
            if edge is None or edge.role != "input":
                raise WorkshopError("INVALID_TARGET", "只能断开输入连线", 422)
            connections = [e for e in connections if e.id != edge.id]
        elif change.op == "move":
            node = _find_node(document.model_copy(update={"nodes": nodes}), change.node_id)
            replace(node.id, node.model_copy(update={
                "position": CanvasPoint(**change.position.model_dump())}))
        elif change.op == "remove_node":
            _find_node(document.model_copy(update={"nodes": nodes}), change.node_id)
            nodes = [n for n in nodes if n.id != change.node_id]
            connections = [e for e in connections
                           if change.node_id not in (e.source_node_id, e.target_node_id)]
            existing_ids.discard(change.node_id)
    return document.model_copy(update={
        "nodes": nodes, "connections": connections, "content_versions": versions,
    }), created


def _save(project_id: str, updated: CanvasDocument, expected_revision: int) -> CanvasDocument:
    try:
        return save_canvas_document(project_id, updated, expected_revision)
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise WorkshopError("DOCUMENT_CONFLICT", "画布已变化，请重新读取后再改") from None
        raise
    except CanvasDocumentError as error:
        raise WorkshopError("INVALID_PARAMETERS", error.message, 422) from None
    except ValueError as error:
        raise WorkshopError("INVALID_PARAMETERS", str(error), 422) from None


def apply_changes(principal: Any, payload: ApplyChangesInput) -> dict:
    authorize(principal, payload.project_id, "canvas_edit")
    document = read_canvas_document(payload.project_id)
    if document.revision != payload.expected_revision:
        raise WorkshopError("DOCUMENT_CONFLICT", "画布已变化，请重新读取后再改")
    updated, created = _apply(document, payload.changes, _now())
    saved = _save(payload.project_id, updated, payload.expected_revision)
    return {"project_id": saved.project_id, "revision": saved.revision, **created}


def import_media(principal: Any, payload: ImportMediaInput) -> dict:
    authorize(principal, payload.project_id, "canvas_edit")
    source = Path(payload.path).expanduser()
    if not source.is_absolute():
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "请提供本机绝对路径", 422)
    if not source.is_file():
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "文件不存在或不是普通文件", 404)
    ext = source.suffix.lower()
    if ext in IMAGE_UPLOAD_EXTS:
        kind = "image"
    elif ext in VIDEO_UPLOAD_EXTS:
        kind = "video"
    elif ext in AUDIO_UPLOAD_EXTS:
        kind = "audio"
    else:
        raise WorkshopError("REFERENCE_NOT_ALLOWED", f"不支持的文件类型 {ext or '(无后缀)'}", 422)
    if source.stat().st_size > upload_max_bytes(ext):
        raise WorkshopError("CONTENT_TOO_LARGE", "文件超过画布导入大小上限", 413)
    body = source.read_bytes()
    try:
        version, document, filename = save_canvas_upload(
            payload.project_id, source.name, ext, body, kind, payload.expected_revision,
        )
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise WorkshopError("DOCUMENT_CONFLICT", "画布已变化，请重新读取后再改") from None
        raise
    except ValueError as error:
        raise WorkshopError("INVALID_PARAMETERS", str(error), 422) from None
    node_id = f"mcp-{uuid.uuid4().hex[:12]}"
    position = CanvasPoint(**(payload.position.model_dump() if payload.position else {"x": 0, "y": 0}))
    node = _media_node(kind, node_id, payload.title or Path(filename).stem[:120] or kind, position,
                       version.version_id)
    saved = _save(payload.project_id, document.model_copy(update={"nodes": [*document.nodes, node]}),
                  document.revision)
    return {"project_id": saved.project_id, "revision": saved.revision, "node_id": node_id,
            "version_id": version.version_id, "kind": kind, "filename": filename}


def _job_view(job: Job, *, agent: bool) -> dict:
    run = job.canvas_run
    error = job.error
    if agent and error:
        error = "生成失败，请在画布查看详情；不要自动重试"
    return {
        "job_id": job.job_id, "run_id": run.run_id if run else None, "status": job.status.value,
        "error": error, "result_node_id": run.result_node_id if run else None,
        "candidates": [
            {"index": c.index, "status": c.status, "version_id": c.version_id,
             "error": ("生成失败" if agent and c.error else c.error)}
            for c in (run.candidates if run else [])
        ],
    }


def run(principal: Any, payload: RunInput) -> tuple[dict, Job]:
    """Submit one run; the caller schedules execution (server BackgroundTasks)."""
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_canvas_run
    authorize(principal, payload.project_id, "canvas_generate")
    try:
        job, document = submit_canvas_run(payload.project_id, payload.surface_node_id,
                                          payload.expected_revision, payload.requested_count)
    except KeyError:
        raise WorkshopError("INVALID_TARGET", "找不到这个生成节点", 404) from None
    except CanvasRunCommandError as error:
        raise WorkshopError("INVALID_PARAMETERS", error.message, 422) from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise WorkshopError("DOCUMENT_CONFLICT", "画布已变化，请重新读取后再改") from None
        raise WorkshopError("INVALID_PARAMETERS", str(error), 422) from None
    except ValueError as error:
        raise WorkshopError("INVALID_PARAMETERS", str(error), 422) from None
    return {"revision": document.revision, **_job_view(job, agent=principal.kind == "agent")}, job


def get_run(principal: Any, payload: GetRunInput) -> dict:
    authorize(principal, payload.project_id, "canvas_read")
    job = next((j for j in list_jobs() if j.namespace == "canvas"
                and j.canvas_project_id == payload.project_id
                and j.canvas_run and j.canvas_run.run_id == payload.run_id), None)
    if job is None:
        raise WorkshopError("INVALID_TARGET", "找不到这次生成", 404)
    return _job_view(job, agent=principal.kind == "agent")


def read_media(principal: Any, payload: CanvasReadMediaInput) -> dict:
    authorize(principal, payload.project_id, "canvas_read")
    try:
        path, version = resolve_canvas_media(payload.project_id, payload.version_id)
    except (FileNotFoundError, PermissionError, KeyError):
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "媒体版本不属于这个画布", 403) from None
    result: dict[str, Any] = {
        "version_id": version.version_id, "kind": version.kind, "mime_type": version.mime_type,
        "width": version.width, "height": version.height, "duration_ms": version.duration_ms,
        "bytes": version.bytes,
    }
    if version.kind == "image":
        from PIL import Image, ImageOps
        if version.bytes > 25 * 1024 * 1024:
            raise WorkshopError("CONTENT_TOO_LARGE", "图片超过安全预览大小", 413)
        with Image.open(io.BytesIO(path.read_bytes())) as opened:
            if opened.width * opened.height > 40_000_000:
                raise WorkshopError("CONTENT_TOO_LARGE", "图片超过安全预览像素限制", 413)
            preview = ImageOps.exif_transpose(opened).convert("RGB")
            preview.thumbnail((1024, 1024))
            buffer = io.BytesIO()
            preview.save(buffer, format="JPEG", quality=75)
        result["preview"] = {"mime_type": "image/jpeg",
                             "data_base64": base64.b64encode(buffer.getvalue()).decode()}
    result.setdefault("mime_type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
    return result
