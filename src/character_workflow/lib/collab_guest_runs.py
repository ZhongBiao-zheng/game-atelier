"""访客自有渠道运行的房主端占位、租期和原子回传。"""
from __future__ import annotations

import hashlib
import re
import secrets
import shutil
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import data_root
from character_workflow.lib.canvas_library import _content_node
from character_workflow.lib.canvas_projects import (
    _new_upload_version, _now, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked,
    _sniff_media_mime, canvas_project_lock_path,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.collab_run_state import CanvasCollabRun
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES, CanvasDocument, CanvasFrozenGeneration, CanvasGroupSize, CanvasLayerStackData,
    CanvasLayerStackLayer, CanvasLayerStackNode, CanvasPoint, CanvasResultStack, CanvasTextVersion,
    CanvasUserEditOrigin, JobErrorCode, LayerDecompositionResult,
)

LEASE_SECONDS = 90
MEDIA_TYPES = {**MEDIA_SUFFIXES, "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/flac": ".flac"}
_lock = threading.Lock()
_heartbeats: dict[tuple[Path, str], float] = {}


class RunError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class GuestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)
    alias: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=240)
    prompt: str | None = Field(default=None, max_length=40_000)
    params: dict | None = None


class Reservation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(pattern=r"^run-[a-f0-9]{24}$")
    source_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    mode: Literal["text", "image", "video", "audio"]
    model: str = Field(min_length=1, max_length=240)
    prompt: str = Field(default="", max_length=40_000)


class Outputs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot: CanvasFrozenGeneration
    # Media names are multipart slots only, never filesystem paths. Text is inline.
    texts: list[str] = Field(default_factory=list, max_length=4)
    input_ids: list[str] = Field(default_factory=list, max_length=64)
    media_count: int = Field(default=0, ge=0, le=100)
    layers: LayerDecompositionResult | None = None


def _load(pid: str):
    _recover_canvas_transactions_unlocked(pid)
    return _read_canvas_document_unlocked(pid)


def _save(pid, doc, writes=()):
    doc.revision += 1
    doc.updated_at = _now()
    checked = CanvasDocument.model_validate(doc.model_dump(mode="json"))
    _commit(pid, checked, writes, doc.updated_at)


def _result(node):
    return {"collab_run_id": node.collab_run.run_id, "node_id": node.id, "status": node.collab_run.status}


def _find(doc, run_id, client_id):
    node = next((n for n in doc.nodes if n.collab_run and n.collab_run.run_id == run_id), None)
    if node is None:
        raise RunError(404, "生成占位已被删除")
    if node.created_by_client != client_id or node.collab_run.execution_mode != "guest":
        raise RunError(403, "此生成任务属于其他成员")
    return node


def _lease_key(project_id, run_id):
    return data_root.resolve_data_root() / project_id, run_id


def reserve(pid: str, body: Reservation, authorize: Callable):
    with file_lock(canvas_project_lock_path(pid)):
        guest = authorize()
        doc = _load(pid)
        for node in doc.nodes:
            if node.collab_run and node.collab_run.run_id == body.run_id:
                return _result(_find(doc, body.run_id, guest.client_id))
        if doc.revision != body.expected_revision:
            raise RunError(409, "画布已更新，请重新提交")
        source = next((n for n in doc.nodes if n.id == body.source_node_id), None)
        if not source:
            raise RunError(404, "生成节点不存在")
        if sum(1 for n in doc.nodes if n.collab_run and n.collab_run.status == "pending") >= 6:
            raise RunError(429, "画布已有 6 项生成中")
        stamp = _now()
        state = CanvasCollabRun(run_id=body.run_id, source_node_id=source.id, mode=body.mode,
                                model=body.model, initiated_by=guest.display_name, started_at=stamp)
        # Keep the result separate so editing the source during generation cannot change a frozen run.
        node = _content_node("", "生成中 · " + guest.display_name[:100], CanvasPoint(
            x=source.position.x + (source.size.width if source.size else 320) + 80,
            y=source.position.y,
        ), body.mode)
        node.data.current_version_id = None
        node.collab_run = state
        node.created_by, node.created_by_client = guest.display_name, guest.client_id
        doc.nodes.append(node)
        authorize()
        _save(pid, doc)
        with _lock:
            _heartbeats[_lease_key(pid, body.run_id)] = time.time()
        return _result(node)


def _expired(pid, node, now):
    started = datetime.fromisoformat(node.collab_run.started_at).timestamp()
    with _lock:
        seen = _heartbeats.get(_lease_key(pid, node.collab_run.run_id), started)
    return now - seen >= LEASE_SECONDS


def _finish(pid, node, status, title, error=None):
    node.collab_run.status, node.collab_run.error = status, error
    node.title = title[:120]
    with _lock:
        _heartbeats.pop(_lease_key(pid, node.collab_run.run_id), None)


def expire_runs(pid, *, now=None):
    with file_lock(canvas_project_lock_path(pid)):
        doc = _load(pid)
        stale = [n for n in doc.nodes if n.collab_run and n.collab_run.execution_mode == "guest"
                 and n.collab_run.status == "pending" and _expired(pid, n, time.time() if now is None else now)]
        for node in stale:
            _finish(pid, node, "interrupted", "生成中断", "发起方已离线，生成中断")
        if stale:
            _save(pid, doc)
        return len(stale)


def _require_pending(pid, doc, node):
    if node.collab_run.status == "pending" and _expired(pid, node, time.time()):
        _finish(pid, node, "interrupted", "生成中断", "发起方已离线，生成中断")
        _save(pid, doc)
    if node.collab_run.status != "pending":
        raise RunError(409, "这次生成已结束")


def heartbeat(pid, run_id, authorize):
    with file_lock(canvas_project_lock_path(pid)):
        guest = authorize()
        doc = _load(pid)
        node = _find(doc, run_id, guest.client_id)
        _require_pending(pid, doc, node)
        with _lock:
            _heartbeats[_lease_key(pid, run_id)] = time.time()
        return _result(node)


_ERROR_TEXT = {
    "insufficient_balance": "发起方的供应商余额不足", "invalid_key": "发起方的供应商鉴权失败",
    "content_rejected": "供应商拒绝了生成内容", "model_unavailable": "发起方的模型不可用",
    "timeout": "等待供应商响应超时", "network": "发起方连接供应商失败",
    "submission_unconfirmed": "供应商提交结果未确认", "bad_endpoint": "发起方的供应商接口无效",
    "service_unavailable": "供应商暂时不可用", "unknown": "访客生成失败，请在发起方查看任务记录",
}


def fail(pid, run_id, code: JobErrorCode, authorize):
    with file_lock(canvas_project_lock_path(pid)):
        guest = authorize()
        doc = _load(pid)
        node = _find(doc, run_id, guest.client_id)
        if node.collab_run.status == "failed":
            return _result(node)
        _require_pending(pid, doc, node)
        message = _ERROR_TEXT.get(code, _ERROR_TEXT["unknown"])
        _finish(pid, node, "failed", "生成失败", message)
        _save(pid, doc)
        return _result(node)


def _make_outputs(pid, payload, media, stamp, snapshot):
    versions, writes = [], []
    if snapshot.mode == "text":
        if media or not 1 <= len(payload.texts) <= 4 or any(len(t) > 40000 for t in payload.texts):
            raise RunError(422, "文本结果无效")
        for text in payload.texts:
            versions.append(CanvasTextVersion(
                version_id=f"version-{secrets.token_hex(12)}", kind="text", text=text, created_at=stamp,
                sha256=hashlib.sha256(text.encode()).hexdigest(), origin=CanvasUserEditOrigin(kind="user_edit"),
                frozen_generation=snapshot,
            ))
    else:
        if payload.texts or len(media) != payload.media_count or not media:
            raise RunError(422, "结果文件不完整")
        if not payload.layers and len(media) > 4:
            raise RunError(422, "候选结果超过上限")
        for body in media:
            mime = _sniff_media_mime(body)
            if mime not in MEDIA_TYPES or mime.partition("/")[0] != snapshot.mode:
                raise RunError(422, "生成结果媒体格式无效")
            version, target = _new_upload_version(pid, MEDIA_TYPES[mime], body, snapshot.mode, stamp)
            version.frozen_generation = snapshot
            versions.append(version)
            writes.append((target, body))
    return versions, writes


def _layers(node, source, versions, result):
    if source is None or source.type != "layer_stack" or len(versions) != len(result.outputs):
        raise RunError(422, "图层来源或结果数量无效")
    base = versions[0]
    layers = []
    for row, version in zip(result.outputs[1:], versions[1:], strict=True):
        if not row.bounding_box or row.bounding_box.absolute[2] > base.width or row.bounding_box.absolute[3] > base.height:
            raise RunError(422, "图层范围超出底图")
        layers.append(CanvasLayerStackLayer(
            id=f"layer-{secrets.token_hex(10)}", version_id=version.version_id, name=row.name,
            description=row.description, z_index=row.z_index, bounding_box=row.bounding_box,
        ))
    raw = node.model_dump(mode="json", exclude={"data", "type"})
    return CanvasLayerStackNode(**raw, type="layer_stack", data=CanvasLayerStackData(
        source_version_id=source.data.source_version_id, base_version_id=base.version_id, layers=layers,
        layout_size=CanvasGroupSize(width=base.width, height=base.height),
    ))


def commit(pid, run_id, payload: Outputs, media: list[bytes], authorize, *, input_files=()):
    with file_lock(canvas_project_lock_path(pid)):
        guest = authorize()
        doc = _load(pid)
        node = _find(doc, run_id, guest.client_id)
        if node.collab_run.status == "done":
            return _result(node)
        _require_pending(pid, doc, node)
        if payload.snapshot.mode != node.collab_run.mode:
            raise RunError(422, "回传结果与发起的生成类型不一致")
        snapshot = payload.snapshot.model_copy(update={"source_kind": "shared_canvas", "created_by": guest.display_name})
        writes = []
        remap = {}
        missing = {row.version_id: row.kind for row in snapshot.inputs
                   if row.version_id and row.version_id not in doc.content_versions}
        if len(payload.input_ids) != len(missing) or set(payload.input_ids) != set(missing):
            raise RunError(422, "生成快照缺少参考文件")
        if len(input_files) != len(payload.input_ids):
            raise RunError(422, "生成参考文件数量不一致")
        for ref_id, data in zip(payload.input_ids, input_files, strict=True):
            mime = _sniff_media_mime(data)
            if mime not in MEDIA_TYPES or mime.partition("/")[0] != missing[ref_id]:
                raise RunError(422, "参考文件类型无效")
            version, target = _new_upload_version(pid, MEDIA_TYPES[mime], data, missing[ref_id], _now())
            doc.content_versions[version.version_id] = version
            remap[ref_id] = version.version_id
            writes.append((target, data))
        snapshot = snapshot.model_copy(update={"inputs": [
            row.model_copy(update={"version_id": remap[row.version_id]})
            if row.version_id in remap else row for row in snapshot.inputs
        ]})
        for row in snapshot.inputs:
            if row.version_id and (row.version_id not in doc.content_versions
                                   or doc.content_versions[row.version_id].kind != row.kind):
                raise RunError(422, "生成快照中的参考版本无效")
        versions, output_writes = _make_outputs(pid, payload, media, _now(), snapshot)
        writes.extend(output_writes)
        if payload.layers:
            source = next((n for n in doc.nodes if n.id == node.collab_run.source_node_id), None)
            stack = _layers(node, source, versions, payload.layers)
            doc.nodes[doc.nodes.index(node)] = stack
            node = stack
        else:
            node.data.current_version_id = versions[0].version_id
            members = []
            for index, version in enumerate(versions[1:], 1):
                part = _content_node(version.version_id, f"候选 {index + 1}",
                                     CanvasPoint(x=node.position.x + index * 368, y=node.position.y), version.kind)
                part.created_by, part.created_by_client = guest.display_name, guest.client_id
                members.append(part.id)
                doc.nodes.append(part)
            if members and node.type == "image":
                node.data.result_stack = CanvasResultStack(run_id=run_id, member_node_ids=members)
        doc.content_versions.update({v.version_id: v for v in versions})
        authorize()
        _finish(pid, node, "done", snapshot.prompt.strip()[:120] or "生成结果")
        _save(pid, doc, writes)
        return _result(node)


def stage_id(run_id: str) -> str:
    if not re.fullmatch(r"run-[a-f0-9]{24}", run_id):
        raise ValueError("共享任务标识无效")
    return "canvas-collab-" + run_id[4:]


def stage_generation(run_id, remote, project_name, request, read_media):
    """在独占的运行目录重建这次生成需要的节点；运行器随后走正常的画布入口。"""
    from character_workflow.lib.canvas_projects import _project_dir_unchecked
    local_id = stage_id(run_id)
    folder = _project_dir_unchecked(local_id)
    if folder.parent != (data_root.runtime_dir() / "collab-staging").resolve():
        raise RuntimeError("共享任务临时目录未配置")
    folder.mkdir(parents=True, exist_ok=False)
    try:
        return _populate_stage(local_id, folder, remote, project_name, request, read_media)
    except BaseException:
        shutil.rmtree(folder)
        raise


def _populate_stage(local_id, folder, remote, project_name, request, read_media):
    from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
    from character_workflow.lib.canvas_paste import _strings
    from character_workflow.lib.collab_sanitize import public_params
    from character_workflow.lib.schemas import (
        CanvasGenerationDraft, CanvasMediaVersion, CanvasProject, JobParams,
    )
    stamp = _now()
    project = CanvasProject(project_id=local_id, name=project_name[:80], created_at=stamp, updated_at=stamp)
    atomic_write_json(folder / "project.json", project.model_dump(mode="json"))
    surface = next((n for n in remote.nodes if n.id == request.surface_node_id), None)
    if not surface or surface.type not in {"image", "video", "audio", "text", "image_edit", "layer_stack"}:
        raise RunError(422, "此节点不能发起生成")
    selected = {surface.id, *(e.source_node_id for e in remote.connections
                              if e.role == "input" and e.target_node_id == surface.id)}
    if surface.type == "image_edit":
        selected.update(v for v in (surface.data.source_node_id, surface.data.reference_node_id) if v)
    for n in remote.nodes:
        if n.id in selected and n.type == "group":
            selected.update(n.data.member_node_ids)
    nodes = [n.model_copy(deep=True) for n in remote.nodes if n.id in selected]
    for node in nodes:
        if hasattr(node.data, "active_run_id"):
            node.data.active_run_id = None
        if node.id == surface.id:
            if node.type == "layer_stack":
                node.data.alias, node.data.model = request.alias, request.model
                if request.prompt is not None:
                    node.data.prompt = request.prompt
            else:
                draft = node.data.generation_draft
                mode = "image" if node.type == "image_edit" else (draft.mode if draft else node.type)
                node.data.generation_draft = CanvasGenerationDraft(
                    mode=mode, model=request.model, alias=request.alias, updated_at=stamp,
                    prompt=request.prompt if request.prompt is not None else (draft.prompt if draft else ""),
                    params=JobParams(**public_params(request.params if request.params is not None
                                                     else (draft.params.model_dump() if draft else {}))),
                )
    version_ids = {v for node in nodes for v in _strings(node.data.model_dump(mode="json"))
                   if v in remote.content_versions}
    for key in list(version_ids):
        origin = remote.content_versions[key].origin
        if origin.kind == "user_mask":
            version_ids.add(origin.source_version_id)
    versions = {}
    budget = 256 * 1024 * 1024
    for key in version_ids:
        current = remote.content_versions[key]
        if isinstance(current, CanvasMediaVersion):
            if current.bytes > budget:
                raise RunError(413, "参考文件总量超过限制")
            raw = read_media(current, budget)
            budget -= len(raw)
            mime = _sniff_media_mime(raw)
            if (mime not in MEDIA_TYPES or mime.partition("/")[0] != current.kind
                    or hashlib.sha256(raw).hexdigest() != current.sha256 or len(raw) != current.bytes):
                raise RunError(422, "参考文件内容与房主的版本不一致")
            version, target = _new_upload_version(local_id, MEDIA_TYPES[mime], raw, current.kind, stamp)
            update = {"version_id": key}
            if current.origin.kind == "user_mask":
                update["origin"] = current.origin
            versions[key] = version.model_copy(update=update)
            atomic_write_bytes(target, raw)
        else:
            versions[key] = current.model_copy(update={"frozen_generation": None})
    document = CanvasDocument(project_id=local_id, updated_at=stamp, nodes=nodes,
        content_versions=versions, connections=[e for e in remote.connections
            if e.source_node_id in selected and e.target_node_id == surface.id])
    atomic_write_json(folder / "canvas.json", document.model_dump(mode="json"))
    return local_id, surface.type


def submit_staged(local_id, kind, request):
    from character_workflow.lib.canvas_runs import (
        submit_canvas_run, submit_image_edit_run, submit_layer_decomposition_run,
    )
    if kind == "layer_stack":
        return submit_layer_decomposition_run(local_id, request.surface_node_id, 0, request.alias, request.model)[0]
    if kind == "image_edit":
        return submit_image_edit_run(local_id, request.surface_node_id, 0, request.requested_count)[0]
    return submit_canvas_run(local_id, request.surface_node_id, 0, request.requested_count)[0]


def remove_stage(run_id, job_id=None):
    from character_workflow.lib.jobs import _path, archive_for_usage, job_lock, read_job
    local_id = stage_id(run_id)
    if job_id:
        with job_lock(job_id):
            job = read_job(job_id)
            if job.canvas_project_id != local_id:
                raise ValueError("暂存任务归属不匹配")
            archive_for_usage(job)
            _path(job_id).unlink()
    folder = data_root.runtime_dir() / "collab-staging" / local_id
    if folder.is_dir() and not folder.is_symlink():
        shutil.rmtree(folder)


def preserve_stage(job) -> str:
    """Save an unacknowledged result as an ordinary local canvas, without rerunning the job."""
    from character_workflow.lib.atomic_io import atomic_write_text
    from character_workflow.lib.canvas_paste import paste_from_document
    from character_workflow.lib.canvas_projects import (
        canvas_project_dir, create_canvas_project, read_canvas_document, read_canvas_project, resolve_canvas_media,
    )
    from character_workflow.lib.collab_provenance import hydrate_document_provenance

    stage = job.canvas_project_id
    if not re.fullmatch(r"canvas-collab-[a-f0-9]{24}", stage or ""):
        raise ValueError("共享任务归属不匹配")
    folder = canvas_project_dir(stage)
    target_file = folder / "recovery-target"
    with file_lock(data_root.runtime_dir() / "locks" / f"collab-recovery-{stage}.lock"):
        if target_file.exists():
            target = target_file.read_text().strip()
            if not re.fullmatch(r"canvas-[a-f0-9]{12}", target):
                raise ValueError("恢复画布标识无效")
            current = read_canvas_document(target)
            if current.nodes:
                return target
        else:
            name = read_canvas_project(stage).name
            suffix = " · 未回传的生成结果"
            target = create_canvas_project(name[:80 - len(suffix)] + suffix).project_id
            atomic_write_text(target_file, target)
            current = read_canvas_document(target)
        source = hydrate_document_provenance(stage, read_canvas_document(stage))
        paste_from_document(project_id=target, source=source, nodes=source.nodes,
            connections=source.connections, document_revision=current.revision,
            media_reader=lambda version: resolve_canvas_media(stage, version.version_id)[0].read_bytes())
        return target


def recover_staged_results():
    """Called once on local startup after reconciliation, before accepting new guest jobs."""
    import logging

    from character_workflow.lib.jobs import list_jobs

    if not (data_root.runtime_dir() / "collab-staging").is_dir():
        return
    for job in list_jobs():
        stage = job.canvas_project_id or ""
        if not re.fullmatch(r"canvas-collab-[a-f0-9]{24}", stage):
            continue
        try:
            if job.status in ("done", "partial"):
                preserve_stage(job)
            elif job.status not in ("failed", "canceled"):
                continue
            remove_stage("run-" + stage.removeprefix("canvas-collab-"), job.job_id)
        except (KeyError, OSError, ValueError, RuntimeError):
            logging.getLogger(__name__).exception("could not recover a staged shared canvas result")
