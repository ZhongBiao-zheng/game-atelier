"""Upload to an editable room without exposing a filesystem path or replacing its graph."""
from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from character_workflow.lib.canvas_library import _content_node
from character_workflow.lib.canvas_projects import (
    AUDIO_UPLOAD_EXTS, IMAGE_UPLOAD_EXTS, MEDIA_UPLOAD_MAX_BYTES, VIDEO_UPLOAD_EXTS,
    _new_upload_version, _now, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked,
    canvas_project_lock_path, upload_max_bytes,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import CanvasDocument, CanvasPoint
from viewer_server.collab_access import require_guest
from viewer_server.collab_proxy import remote_json

lan_uploads = APIRouter()
local_uploads = APIRouter()


async def _parse(request):
    async def stream():
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > MEDIA_UPLOAD_MAX_BYTES + 65536:
                raise MultiPartException("上传文件过大")
            yield chunk
    try:
        form = await MultiPartParser(request.headers, stream(), max_files=1, max_fields=2,
                                     max_part_size=512).parse()
    except MultiPartException:
        raise HTTPException(413, "上传大小或字段超限") from None
    try:
        if set(form) - {"file", "x", "y"} or len(form) != len(form.multi_items()):
            raise HTTPException(422, "上传字段无效")
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(422, "缺少媒体文件")
        name = (file.filename or "media").replace("\\", "/").rsplit("/", 1)[-1]
        ext = Path(name).suffix.lower()
        if ext not in IMAGE_UPLOAD_EXTS | AUDIO_UPLOAD_EXTS | VIDEO_UPLOAD_EXTS:
            raise HTTPException(422, "不支持这种文件格式")
        limit = upload_max_bytes(ext)
        body = await file.read(limit + 1)
        if len(body) > limit:
            raise HTTPException(413, "文件超过大小上限")
        try:
            position = CanvasPoint(x=form.get("x", 0), y=form.get("y", 0))
        except ValidationError:
            raise HTTPException(422, "画布坐标无效") from None
        return name, ext, body, position
    finally:
        await form.close()


def _save(request, project_id, name, ext, body, position):
    kind = "image" if ext in IMAGE_UPLOAD_EXTS else "audio" if ext in AUDIO_UPLOAD_EXTS else "video"
    with file_lock(canvas_project_lock_path(project_id)):
        guest = require_guest(request, project_id, edit=True)
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        stamp = _now()
        version, target = _new_upload_version(project_id, ext, body, kind, stamp)
        node = _content_node(version.version_id, (Path(name).stem or kind)[:120], position, kind)
        node.created_by, node.created_by_client = guest.display_name, guest.client_id
        doc = CanvasDocument.model_validate(current.model_copy(update={
            "nodes": [*current.nodes, node], "content_versions": {**current.content_versions, version.version_id: version},
            "revision": current.revision + 1, "updated_at": stamp,
        }).model_dump(mode="json"))
        require_guest(request, project_id, edit=True)
        _commit(project_id, doc, [(target, body)], stamp)
        return {"node_id": node.id, "version_id": version.version_id,
                **_record(project_id, guest, current, doc)}


def _record(project_id, guest, before, after):
    from character_workflow.lib.collab_ops import record_committed_change
    op_id = "transfer-" + secrets.token_hex(16)
    result = record_committed_change(project_id, before, after, op_id=op_id, client_id=guest.client_id)
    return {"op_id": op_id, "revision": result.revision, "touched_node_ids": sorted(result.touched_node_ids)}


@lan_uploads.post("/collab/v1/projects/{project_id}/uploads")
async def upload(project_id: str, request: Request):
    require_guest(request, project_id, edit=True)
    values = await _parse(request)
    try:
        return await run_in_threadpool(_save, request, project_id, *values)
    except ValueError:
        raise HTTPException(422, "媒体内容与文件格式不符") from None


@local_uploads.post("/api/collab/remote/{peer_key}/projects/{project_id}/uploads")
async def proxy_upload(peer_key: str, project_id: str, request: Request):
    name, _, body, point = await _parse(request)
    return await run_in_threadpool(remote_json, request, peer_key, project_id, "uploads", method="POST",
                                   files={"file": (name, body)}, data={"x": str(point.x), "y": str(point.y)})


async def _mask_form(request):
    from character_workflow.lib.canvas_projects import IMAGE_UPLOAD_MAX_BYTES
    from character_workflow.lib.schemas import CanvasImageEditSave

    async def stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > IMAGE_UPLOAD_MAX_BYTES + 2 * 1024 * 1024:
                raise MultiPartException("上传文件过大")
            yield chunk
    try:
        form = await MultiPartParser(request.headers, stream(), max_files=1, max_fields=1,
                                     max_part_size=2 * 1024 * 1024).parse()
    except MultiPartException:
        raise HTTPException(413, "蒙版或编辑数据过大") from None
    try:
        if set(form) - {"payload", "mask_file"} or len(form) != len(form.multi_items()):
            raise HTTPException(422, "上传字段无效")
        command = CanvasImageEditSave.model_validate_json(form.get("payload", ""))
        mask = form.get("mask_file")
        if mask is not None and not isinstance(mask, UploadFile):
            raise ValueError
        body = await mask.read(IMAGE_UPLOAD_MAX_BYTES + 1) if mask else None
        if body and len(body) > IMAGE_UPLOAD_MAX_BYTES:
            raise HTTPException(413, "蒙版超过大小上限")
        return command, body
    except (ValueError, TypeError):
        raise HTTPException(422, "图片编辑请求无效") from None
    finally:
        await form.close()


@lan_uploads.post("/collab/v1/projects/{project_id}/image-edits")
async def image_edit(project_id: str, request: Request):
    from character_workflow.lib.canvas_image_edits import save_image_edit
    guest = require_guest(request, project_id, edit=True)
    command, body = await _mask_form(request)
    recorded = {}
    def on_committed(before, after):
        recorded.update(_record(project_id, guest, before, after))
    try:
        _, node_id = await run_in_threadpool(
            save_image_edit, project_id, command, body, creator=(guest.display_name, guest.client_id),
            authorize=lambda: require_guest(request, project_id, edit=True), on_committed=on_committed,
        )
        return {"node_id": node_id, **recorded}
    except (KeyError, OSError):
        raise HTTPException(404, "找不到图片版本") from None
    except RuntimeError:
        raise HTTPException(409, "画布已更新，请刷新") from None
    except ValueError:
        raise HTTPException(422, "蒙版或图片编辑数据不合法") from None


@local_uploads.post("/api/collab/remote/{peer_key}/projects/{project_id}/image-edits")
async def proxy_image_edit(peer_key: str, project_id: str, request: Request):
    command, body = await _mask_form(request)
    files = {"payload": (None, command.model_dump_json(exclude_unset=True))}
    if body is not None:
        files["mask_file"] = ("mask.png", body, "image/png")
    return await run_in_threadpool(remote_json, request, peer_key, project_id, "image-edits",
                                   method="POST", files=files)
