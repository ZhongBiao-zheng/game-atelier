"""Transfer canvas-owned copies across an authenticated collaboration session."""
from __future__ import annotations

import hashlib
import secrets
from contextlib import ExitStack

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from character_workflow.lib.canvas_library import _content_node
from character_workflow.lib.canvas_projects import (
    CanvasDocumentError, IMAGE_UPLOAD_MAX_BYTES, MEDIA_UPLOAD_MAX_BYTES, _new_upload_version,
    _now, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked,
    _sniff_media_mime, canvas_project_lock_path, read_canvas_document,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.project_reference_assets import sniff_media_mime
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES, CanvasDocument, CanvasFrozenGeneration, CanvasMediaVersion, CanvasNode, CanvasPoint,
)

collab_transfer_local_router = APIRouter()
collab_transfer_lan_router = APIRouter()
_REMOTE = "/api/collab/remote/{peer_key}/projects/{project_id}"
_SUFFIXES = {**MEDIA_SUFFIXES, "audio/aac": ".aac"}
_MAX_TRANSFER = 256 * 1024 * 1024


class CopySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_project_id: str
    node_ids: list[str] = Field(min_length=1, max_length=10000)
    document_revision: int | None = Field(default=None, ge=0)


class StudioSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str


class SharedDestination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peer_key: str
    project_id: str
    output_index: int = Field(ge=0)


def _remote_document(request, peer_key, project_id):
    from viewer_server.collab_proxy import remote_json
    payload = remote_json(request, peer_key, project_id, "document")
    try:
        document = CanvasDocument.model_validate(payload["document"])
        if document.project_id != project_id:
            raise ValueError
        return document
    except (ValueError, KeyError, TypeError):
        raise HTTPException(502, "房主返回的画布文档无效") from None


def _download_media(request, peer_key, project_id, version, budget):
    from viewer_server.collab_proxy import remote_bytes
    if version.mime_type not in _SUFFIXES or version.bytes > budget:
        raise HTTPException(413, "媒体格式或大小超过复制范围")
    body = remote_bytes(request, peer_key, project_id, version.version_id, max_bytes=budget)
    if len(body) != version.bytes or hashlib.sha256(body).hexdigest() != version.sha256:
        raise HTTPException(502, "房主返回的媒体与画布版本不一致")
    detected = _sniff_media_mime(body) or sniff_media_mime(body)
    if detected != version.mime_type:
        raise HTTPException(422, "媒体内容与标记的格式不匹配")
    return body


def _selected_nodes(document, ids):
    wanted = set(ids)
    chosen = [node for node in document.nodes if node.id in wanted]
    if len(chosen) != len(wanted):
        raise HTTPException(409, "选中的节点已改变，请刷新画布")
    mapping = {node.id: f"{node.type}-{secrets.token_hex(10)}" for node in chosen}
    nodes = []
    for node in chosen:
        raw = node.model_dump(mode="json")
        raw["id"] = mapping[node.id]
        data = raw["data"]
        if node.type == "group":
            data["member_node_ids"] = [mapping[key] for key in data["member_node_ids"] if key in mapping]
        if node.type == "image_edit":
            for key in ("reference_node_id", "source_node_id"):
                data[key] = mapping.get(data.get(key))
        if node.type == "layer_stack":
            data["base_material_node_id"] = mapping.get(data.get("base_material_node_id"))
            for layer in data["layers"]:
                layer["material_node_id"] = mapping.get(layer.get("material_node_id"))
        if stack := data.get("result_stack"):
            members = [mapping[key] for key in stack["member_node_ids"] if key in mapping]
            data["result_stack"] = {**stack, "member_node_ids": members} if members else None
        nodes.append(TypeAdapter(CanvasNode).validate_python(raw))
    connections = [edge.model_copy(update={
        "id": f"connection-{secrets.token_hex(10)}", "source_node_id": mapping[edge.source_node_id],
        "target_node_id": mapping[edge.target_node_id],
    }) for edge in document.connections if edge.source_node_id in mapping and edge.target_node_id in mapping]
    return nodes, connections


@collab_transfer_local_router.post(_REMOTE + "/copy-to-local")
def copy_to_local(peer_key: str, project_id: str, body: CopySelection, request: Request):
    from character_workflow.lib.canvas_paste import paste_from_document
    from viewer_server import collab_offline
    from character_workflow.lib.collab_discovery import discovery
    offline = False
    try:
        source = _remote_document(request, peer_key, project_id)
        host_id = None
    except HTTPException as error:
        if error.status_code != 503:
            raise
        host_id, source = collab_offline.snapshot(request, peer_key, project_id)
        offline = True
    nodes, edges = _selected_nodes(source, body.node_ids)
    revision = body.document_revision
    if revision is None:
        target = read_canvas_document(body.target_project_id)
        revision = target.revision
        if target.nodes:
            right = max(node.position.x + (node.size.width if node.size else 320) for node in target.nodes)
            offset = right + 80 - min(node.position.x for node in nodes)
            nodes = [node.model_copy(update={"position": CanvasPoint(
                x=node.position.x + offset, y=node.position.y,
            )}) for node in nodes]
    remaining = _MAX_TRANSFER

    def download(version):
        nonlocal remaining, offline, host_id
        if version.bytes > _MAX_TRANSFER or version.mime_type not in _SUFFIXES:
            raise HTTPException(413, "媒体格式或大小超过复制范围")
        if host_id is None:
            try:
                host_id = str(discovery.get(peer_key).manifest.host_id)
            except KeyError:
                pass
        media = collab_offline.cached_bytes(version, host_id, project_id) if host_id else None
        if media is None and not offline:
            try:
                media = _download_media(request, peer_key, project_id, version, remaining)
            except HTTPException as error:
                if error.status_code != 503:
                    raise
                offline = True
        if media is None:
            if host_id is None:
                host_id, _ = collab_offline.snapshot(request, peer_key, project_id)
            return collab_offline.pending_source(host_id, project_id, version.version_id)
        if len(media) > remaining:
            raise HTTPException(413, "所选媒体超过复制范围")
        remaining -= len(media)
        return media

    try:
        return paste_from_document(project_id=body.target_project_id, source=source, nodes=nodes,
                                   connections=edges, document_revision=revision, media_reader=download)
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise HTTPException(409, "目标画布已更新，请重试") from None
        raise
    except (CanvasDocumentError, ValueError):
        raise HTTPException(422, "选中的节点或媒体无法复制") from None


@collab_transfer_local_router.post(_REMOTE + "/send-to-studio")
def send_to_studio(peer_key: str, project_id: str, body: StudioSelection, request: Request):
    from viewer_server.routes import _store_runtime_upload
    document = _remote_document(request, peer_key, project_id)
    version = document.content_versions.get(body.version_id)
    if not isinstance(version, CanvasMediaVersion):
        raise HTTPException(404, "媒体版本不存在")
    media = _download_media(request, peer_key, project_id, version, _MAX_TRANSFER)
    mime = _sniff_media_mime(media) or sniff_media_mime(media)
    if mime is None or mime.split("/")[0] != version.kind:
        raise HTTPException(422, "媒体格式无法识别")
    target = _store_runtime_upload(_SUFFIXES[mime], media)
    return {"path": str(target.resolve()), "frozen_generation": version.frozen_generation}


@collab_transfer_local_router.post("/api/studio/jobs/{job_id}/shared-canvas")
def send_studio_output(job_id: str, body: SharedDestination, request: Request):
    from character_workflow.lib.collab_provenance import studio_output_snapshot
    from viewer_server.collab_proxy import remote_json
    if "/" in job_id or "\\" in job_id or job_id.startswith("."):
        raise HTTPException(404, "生成记录不存在")
    try:
        output, snapshot, references = studio_output_snapshot(read_job(job_id), body.output_index)
        with ExitStack() as opened:
            files = {key: ("media", opened.enter_context(path.open("rb")), "application/octet-stream")
                     for key, path in {"output": output, **references}.items()}
            return remote_json(request, body.peer_key, body.project_id, "ingest-node", method="POST",
                               data={"snapshot": snapshot.model_dump_json()}, files=files)
    except FileNotFoundError:
        raise HTTPException(404, "生成记录或媒体文件不存在") from None
    except (LookupError, ValueError) as error:
        raise HTTPException(422, str(error)) from None


@collab_transfer_lan_router.post("/collab/v1/projects/{project_id}/ingest-node")
async def ingest_node(project_id: str, request: Request):
    from viewer_server.collab_access import require_guest
    require_guest(request, project_id, edit=True)

    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > _MAX_TRANSFER:
                raise MultiPartException("投送文件总量超过限制")
            yield chunk

    try:
        form = await MultiPartParser(request.headers, bounded_stream(), max_files=64, max_fields=1).parse()
    except MultiPartException as error:
        raise HTTPException(413, "投送文件数量、大小或表单格式无效") from error
    try:
        snapshot = CanvasFrozenGeneration.model_validate_json(form.get("snapshot", ""))
        expected = {"output", *(row.version_id for row in snapshot.inputs if row.version_id)}
        if set(form) != expected | {"snapshot"} or len(form.multi_items()) != len(form):
            raise ValueError
        files = {}
        for key in expected:
            upload = form[key]
            if not isinstance(upload, UploadFile):
                raise ValueError
            data = await upload.read(MEDIA_UPLOAD_MAX_BYTES + 1)
            mime = _sniff_media_mime(data)
            if mime not in _SUFFIXES:
                raise ValueError
            limit = IMAGE_UPLOAD_MAX_BYTES if mime.startswith("image/") else MEDIA_UPLOAD_MAX_BYTES
            if len(data) > limit:
                raise HTTPException(413, "媒体文件超过大小限制")
            files[key] = (mime, data)
        return await run_in_threadpool(_insert_studio_node, request, project_id, snapshot, files)
    except (ValidationError, ValueError, KeyError, TypeError, CanvasDocumentError):
        raise HTTPException(422, "生成快照或媒体文件无效") from None
    finally:
        await form.close()


def _insert_studio_node(request, project_id, snapshot, files):
    from viewer_server.collab_access import require_guest
    with file_lock(canvas_project_lock_path(project_id)):
        guest = require_guest(request, project_id, edit=True)
        _recover_canvas_transactions_unlocked(project_id)
        document = _read_canvas_document_unlocked(project_id)
        stamp = _now()
        versions, writes = {}, []
        for key, (mime, data) in files.items():
            version, target = _new_upload_version(project_id, _SUFFIXES[mime], data, mime.split("/")[0], stamp)
            versions[key] = version
            writes.append((target, data))
        inputs = []
        for row in snapshot.inputs:
            if row.version_id:
                reference = versions[row.version_id]
                if row.kind != reference.kind or row.version_id == "output":
                    raise ValueError
                row = row.model_copy(update={"version_id": reference.version_id})
            inputs.append(row)
        output = versions["output"]
        if snapshot.mode != output.kind:
            raise ValueError
        output.frozen_generation = snapshot.model_copy(update={"inputs": inputs, "created_by": guest.display_name})
        right = max((n.position.x + (n.size.width if n.size else 320) for n in document.nodes), default=-80)
        node = _content_node(output.version_id, snapshot.prompt.strip()[:40] or "创作台结果",
                             CanvasPoint(x=right + 80, y=0), output.kind)
        node.created_by, node.created_by_client = guest.display_name, guest.client_id
        document.nodes.append(node)
        document.content_versions.update({v.version_id: v for v in versions.values()})
        document.revision += 1
        document.updated_at = stamp
        checked = CanvasDocument.model_validate(document.model_dump(mode="json"))
        require_guest(request, project_id, edit=True)
        _commit(project_id, checked, writes, stamp)
        return {"project_id": project_id, "node_id": node.id, "revision": checked.revision}


class FrozenReproduction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: CanvasPoint
    document_revision: int = Field(ge=0)
    alias: str | None = None
    model: str | None = None


@collab_transfer_local_router.post("/api/canvas/projects/{project_id}/versions/{version_id}/reproduce")
def reproduce_snapshot(project_id: str, version_id: str, body: FrozenReproduction):
    from character_workflow.lib.canvas_reproduce import reproduce_frozen_version
    try:
        return reproduce_frozen_version(project_id, version_id, body.position, body.alias,
                                        body.model, body.document_revision)
    except KeyError:
        raise HTTPException(404, "找不到这份生成快照") from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise HTTPException(409, "画布已更新，请刷新后重试") from None
        raise
    except ValueError:
        raise HTTPException(422, "生成快照中的参考或参数无效") from None
