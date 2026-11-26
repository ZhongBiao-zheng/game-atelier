"""Shared canvas generation on guest-owned providers; LAN accepts bytes and version IDs only."""
from __future__ import annotations

import asyncio
import logging
import secrets
import threading
import time
from contextlib import ExitStack, asynccontextmanager, suppress
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from character_workflow.lib import canvas_run_queue, collab_config, collab_guest_runs as runs, data_root_move
from character_workflow.lib.canvas_projects import (
    IMAGE_UPLOAD_MAX_BYTES, MEDIA_UPLOAD_MAX_BYTES, canvas_project_dir, read_canvas_document,
    resolve_canvas_media,
)
from character_workflow.lib.canvas_runs import CanvasRunCommandError
from character_workflow.lib.collab_borrow import require_surface_model
from character_workflow.lib.collab_provenance import build_frozen_from_job
from character_workflow.lib.collab_sanitize import public_text
from character_workflow.lib.jobs import read_job, update_job_params, update_job_status
from character_workflow.lib.keys import find_by_alias
from character_workflow.lib.schemas import CanvasDocument, JobErrorCode, JobStatus
from viewer_server.collab_access import require_guest
from viewer_server.collab_proxy import remote_bytes, remote_json
from viewer_server.collab_submissions import RequestId, submission

_LAN = "/collab/v1/projects/{project_id}/runs"
_LOCAL = "/api/collab/remote/{peer_key}/projects/{project_id}/runs"
_MAX_BYTES = 256 * 1024 * 1024
_slots = threading.BoundedSemaphore(6)
_log = logging.getLogger(__name__)


@asynccontextmanager
async def _leases(_app):
    def expire_shared_runs():
        if not data_root_move.enter_write():
            return
        try:
            for entry in collab_config.read_config().shares.values():
                if entry.enabled:
                    with suppress(KeyError, OSError, ValueError):
                        runs.expire_runs(entry.project_id)
        finally:
            data_root_move.leave_write()

    async def sweep():
        while True:
            try:
                await asyncio.to_thread(expire_shared_runs)
            except (OSError, ValueError):
                _log.exception("共享生成状态读取失败")
            await asyncio.sleep(10)
    task = asyncio.create_task(sweep())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


collab_guest_lan_router = APIRouter(lifespan=_leases)
collab_guest_local_router = APIRouter()


class Failure(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: JobErrorCode = "unknown"


def _host_call(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except runs.RunError as error:
        raise HTTPException(error.status, str(error)) from None
    except (ValueError, KeyError):
        raise HTTPException(422, "共享任务或素材无效") from None


@collab_guest_lan_router.post(_LAN + "/reserve", status_code=201)
def reserve(project_id: str, body: runs.Reservation, request: Request):
    return _host_call(runs.reserve, project_id, body, lambda: require_guest(request, project_id, edit=True))


@collab_guest_lan_router.post(_LAN + "/{run_id}/heartbeat")
def heartbeat(project_id: str, run_id: str, request: Request):
    return _host_call(runs.heartbeat, project_id, run_id, lambda: require_guest(request, project_id, edit=True))


@collab_guest_lan_router.post(_LAN + "/{run_id}/fail")
def fail(project_id: str, run_id: str, body: Failure, request: Request):
    return _host_call(runs.fail, project_id, run_id, body.code, lambda: require_guest(request, project_id, edit=True))


@collab_guest_lan_router.post(_LAN + "/{run_id}/commit")
async def commit(project_id: str, run_id: str, request: Request):
    def authorize():
        return require_guest(request, project_id, edit=True)
    authorize()

    async def bounded():
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > _MAX_BYTES:
                raise MultiPartException("生成结果总量超过上限")
            yield chunk

    try:
        form = await MultiPartParser(request.headers, bounded(), max_files=164, max_fields=1).parse()
    except MultiPartException:
        raise HTTPException(413, "回传结果超过限制或格式无效") from None
    try:
        payload = runs.Outputs.model_validate_json(form["manifest"])
        names = [f"output-{i}" for i in range(payload.media_count)]
        refs = [f"ref-{i}" for i in range(len(payload.input_ids))]
        if set(form) != {"manifest", *names, *refs} or len(form.multi_items()) != len(form):
            raise ValueError
        files = []
        for name in [*names, *refs]:
            file = form[name]
            if not isinstance(file, UploadFile):
                raise ValueError
            data = await file.read(MEDIA_UPLOAD_MAX_BYTES + 1)
            limit = IMAGE_UPLOAD_MAX_BYTES if (runs._sniff_media_mime(data) or "").startswith("image/") else MEDIA_UPLOAD_MAX_BYTES
            if len(data) > limit:
                raise HTTPException(413, "单个生成文件超过上限")
            files.append(data)
        return await run_in_threadpool(_host_call, runs.commit, project_id, run_id, payload,
                                       files[:len(names)], authorize, input_files=files[len(names):])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, "生成结果格式无效") from None
    finally:
        await form.close()


def _publish(request, peer_key, pid, run_id, job, source):
    local_id = job.canvas_project_id
    document = read_canvas_document(local_id)
    snapshot = build_frozen_from_job(job, local_id, document=document)
    labels = {
        field: public_text(value) if "://" not in value else None
        for field in ("provider_label", "model_name")
        if (value := getattr(snapshot, field)) is not None
    }
    snapshot = snapshot.model_copy(update={
        **labels, "model_id": public_text(snapshot.model_id) if "://" not in snapshot.model_id else "custom",
        "prompt": public_text(snapshot.prompt),
        "inputs": [item.model_copy(update={"text": public_text(item.text)}) if item.text else item
                   for item in snapshot.inputs],
    })
    missing = list(dict.fromkeys(i.version_id for i in snapshot.inputs
                                 if i.version_id and i.version_id not in source.content_versions))
    root = canvas_project_dir(local_id) / "outputs" / job.job_id
    outputs = [Path(raw).resolve() for raw in job.output_paths]
    if any(p.parent != root.resolve() or not p.is_file() for p in outputs):
        raise ValueError("生成结果路径无效")
    text = snapshot.mode == "text"
    payload = runs.Outputs(snapshot=snapshot, media_count=0 if text else len(outputs),
                           texts=[p.read_text("utf-8") for p in outputs] if text else [],
                           input_ids=missing, layers=job.params.layer_decomposition_result)
    paths = {f"output-{i}": path for i, path in enumerate([] if text else outputs)}
    paths.update({f"ref-{i}": resolve_canvas_media(local_id, vid)[0] for i, vid in enumerate(missing)})
    for attempt in range(3):
        try:
            with ExitStack() as opened:
                # A multipart form is required even when all results are inline text.
                files = {"manifest": (None, payload.model_dump_json())}
                files.update({key: ("media", opened.enter_context(p.open("rb")), "application/octet-stream")
                              for key, p in paths.items()})
                remote_json(request, peer_key, pid, f"runs/{run_id}/commit", method="POST", files=files)
            return
        except HTTPException as error:
            if error.status_code not in (502, 503) or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def _worker(request, peer_key, pid, run_id, source, project_name, body, kind):
    done = threading.Event()
    lost = threading.Event()
    job = None
    local_id = None
    published = False

    def heartbeat_worker():
        last_contact = time.monotonic()
        while not done.wait(10):
            try:
                remote_json(request, peer_key, pid, f"runs/{run_id}/heartbeat", method="POST")
                last_contact = time.monotonic()
            except HTTPException as error:
                if error.status_code in {403, 404, 409} or time.monotonic() - last_contact >= runs.LEASE_SECONDS:
                    lost.set()
                    return

    timer = threading.Thread(target=heartbeat_worker, name="collab-guest-heartbeat", daemon=True)
    try:
        timer.start()

        def download(version, budget):
            return remote_bytes(request, peer_key, pid, version.version_id, max_bytes=budget)
        local_id, _ = runs.stage_generation(run_id, source, project_name, body, download)
        if lost.is_set():
            return
        # Recheck the lease immediately before executing a potentially billable request.
        remote_json(request, peer_key, pid, f"runs/{run_id}/heartbeat", method="POST")
        job = runs.submit_staged(local_id, kind, body)
        job = update_job_params(job.job_id, {**job.params.model_dump(exclude_none=True),
                                             "collab_source_canvas": project_name})

        def check_lease():
            if lost.is_set():
                raise ValueError("共享画布连接已中断")
            remote_json(request, peer_key, pid, f"runs/{run_id}/heartbeat", method="POST")

        job = canvas_run_queue.submit(job.job_id, before_run=check_lease).result()
        if job.status not in ("done", "partial"):
            raise ValueError("生成未成功")
        _publish(request, peer_key, pid, run_id, job, source)
        published = True
    except Exception:
        code = "unknown"
        if job:
            job = read_job(job.job_id)
            if job.status == "pending" and not job.runner_started_at:
                job = update_job_status(job.job_id, status=JobStatus.FAILED, error="共享画布连接已中断")
            code = job.error_code or "unknown"
        with suppress(Exception):
            remote_json(request, peer_key, pid, f"runs/{run_id}/fail", method="POST", json={"code": code})
    finally:
        done.set()
        try:
            if local_id:
                if not published and job and job.status in ("done", "partial"):
                    runs.preserve_stage(job)
                runs.remove_stage(run_id, job.job_id if job else None)
        except Exception:
            # Startup retries an incomplete local recovery from the original staged bytes.
            _log.exception("could not finish local shared canvas result recovery")
        finally:
            data_root_move.leave_write()
            _slots.release()


class LocalSubmission(runs.GuestRequest):
    request_id: RequestId


@collab_guest_local_router.post(_LOCAL + "/local", status_code=202)
def run_local(project_id: str, peer_key: str, body: LocalSubmission, request: Request):
    with submission(("local", peer_key, project_id), body) as entry:
        if "receipt" in entry.state:
            # Recheck share access without reserving again, even if the result was since removed.
            current = remote_json(request, peer_key, project_id, "document")
            if current["mode"] != "edit":
                raise HTTPException(403, "这张画布仅可查看")
            return entry.state["receipt"]
        if entry.state:
            payload = entry.state["source"]
            body = body.model_copy(update={"expected_revision": payload["document"]["revision"]})
            run_id = entry.state["run_id"]
        else:
            payload = remote_json(request, peer_key, project_id, "document")
            run_id = f"run-{secrets.token_hex(12)}"
        return _start_local(project_id, peer_key, body, request, entry, payload, run_id)


def _start_local(project_id, peer_key, body, request, entry, payload, run_id):
    try:
        source = CanvasDocument.model_validate(payload["document"])
        name = str(payload["name"])
    except (ValueError, TypeError, KeyError):
        raise HTTPException(502, "房主返回了无效画布") from None
    if source.project_id != project_id or source.revision != body.expected_revision:
        raise HTTPException(409, "画布已更新，请刷新")
    surface = next((n for n in source.nodes if n.id == body.surface_node_id), None)
    if not surface or surface.type not in {"text", "image", "audio", "video", "image_edit", "layer_stack"}:
        raise HTTPException(422, "节点不能发起生成")
    if surface.type in {"image_edit", "layer_stack"}:
        try:
            require_surface_model(surface, find_by_alias(body.alias), body.model)
        except CanvasRunCommandError as error:
            raise HTTPException(422, detail={"code": error.code, "message": error.message}) from error
    draft = getattr(surface.data, "generation_draft", None)
    mode = "image" if surface.type in {"image_edit", "layer_stack"} else (draft.mode if draft else surface.type)
    reservation = runs.Reservation(
        run_id=run_id, expected_revision=source.revision, source_node_id=surface.id,
        model=public_text(body.model) if "://" not in body.model else "custom", mode=mode,
        prompt=public_text(body.prompt if body.prompt is not None else (draft.prompt if draft else "")),
    )
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "本机已有 6 项共享生成中")
    if not data_root_move.enter_write():
        _slots.release()
        raise HTTPException(503, "正在迁移数据目录，请稍后重试")
    try:
        # The host can reserve and lose its response. Freeze the original inputs before sending.
        if not entry.state:
            entry.save(run_id=run_id, source=payload)
        prepared = entry.state
        reservation_body = reservation.model_dump(mode="json")
        try:
            result = remote_json(request, peer_key, project_id, "runs/reserve", method="POST",
                                 json=reservation_body)
        except HTTPException as error:
            if 400 <= error.status_code < 500 and error.status_code != 408:
                entry.path.unlink(missing_ok=True)
            raise
        if result.get("collab_run_id") != run_id or result.get("status") not in {"pending", "done", "failed", "interrupted"}:
            raise HTTPException(502, "房主返回的任务与请求不一致")
        entry.save(receipt=result)
        if result["status"] != "pending":
            data_root_move.leave_write()
            _slots.release()
            return result
        try:
            threading.Thread(target=_worker, daemon=True, name=f"collab-guest-{run_id}",
                             args=(request, peer_key, project_id, run_id, source, name, body, surface.type)).start()
        except RuntimeError:
            entry.save(**prepared)
            raise
        return result
    except BaseException:
        data_root_move.leave_write()
        _slots.release()
        raise
