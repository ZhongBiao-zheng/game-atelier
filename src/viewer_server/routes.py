"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import asyncio
import errno
import inspect
import json
import logging
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from character_workflow.lib import data_root, keys, model_routes, studio_agent_sessions
from character_workflow.lib.atomic_io import (
    atomic_write_bytes,
    atomic_write_json,
    read_text_with_retry,
)
from character_workflow.lib.callers.openai_image import image_family, is_midjourney_entry
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.job_runner import image_dimensions_from_bytes
from character_workflow.lib.local_paths import data_root_file
from character_workflow.lib.jobs import (
    _load_job, delete_failed_job, is_resumable_studio_job, job_lock, list_jobs, read_job,
    request_job_cancel, trash_studio_job,
    new_job_id, save_job, update_job_status, write_job_under_lock,
)
from pydantic import BaseModel, Field, ValidationError
from pydantic import field_validator

from character_workflow.lib.schemas import (
    JOB_PARAM_PATH_FIELDS,
    AccentThemes, AccentThemesUpdate,
    CanvasAgentSession, CanvasAgentSessionCreate, CanvasAgentSessionId, CanvasAgentSessionList,
    CanvasAngleRunCreate, CanvasCandidateDismiss, CanvasDocument, CanvasUpscaleRunCreate,
    CanvasCreationAssetInsertRequest, CanvasPasteRequest, CanvasReproduceRequest,
    CanvasReproduceResponse,
    CanvasLayerDecompositionCreate,
    CanvasPackageCommitRequest, CanvasPackageImportResponse,
    CanvasImageEditRunCreate, CanvasImageEditSave, CanvasImageEditSaveResponse,
    CanvasMediaOperationRequest, CanvasMediaOperationResponse,
    CanvasProject, CanvasProjectCreate, CanvasProjectDeleteRequest, CanvasProjectExportRequest,
    CanvasCategoriesUpdate, CanvasSpecUpdate, CanvasClassifyRequest, CanvasCategorySuggestion, CanvasProjectList, CanvasProjectRename, CanvasReversePromptConfigCreate,
    CanvasReversePromptCreate, CanvasRunCreate, CanvasRunResponse,
    CanvasUiPreferences, CanvasUiPreferencesUpdate, CanvasUploadResponse,
    ClipboardAttempt,
    CreationAsset, CreationAssetMetadataUpdate, CreationAssetList, CreationAssetUseRequest,
    CreationGenerationFromCanvas, CreationGenerationFromJob,
    CreationMediaPathCreate, CreationPromptAssetCreate, CreationPromptAssetUpdate,
    Job, JobKind, JobParams, JobStatus, WebEditableJobPatch,
)
from viewer_server.errors import asset_state_broken_error


_STUDIO_SHUTDOWN_EVENT = threading.Event()
_STUDIO_RECOVERY_DELAY_SECONDS = 30
_STUDIO_RUNNER_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="studio-job")
_STUDIO_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


logger = logging.getLogger(__name__)




router = APIRouter(prefix="/api")


def _runtime() -> Path:
    return data_root.runtime_dir()


def _project_root() -> Path:
    return data_root.resolve_data_root()


@router.get("/jobs", response_model=list[Job])
def get_jobs() -> list[Job]:
    jobs_dir = _runtime() / "jobs"
    if not jobs_dir.exists():
        return []
    out: list[Job] = []
    for p in sorted(jobs_dir.glob("*.json")):
        # 一条坏文件（半写 / 手改 schema 不符）不能拖垮整个列表 → 跳过并留日志。
        try:
            out.append(_load_job(json.loads(read_text_with_retry(p))))
        except (OSError, json.JSONDecodeError, ValidationError):
            logger.warning("skipping bad job file: %s", p.name)
    return out


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str) -> Job:
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）")
    # 写入方持 job_lock 原子替换；Windows 上替换那一刻打开会 PermissionError，重试越过。
    return _load_job(json.loads(read_text_with_retry(p)))




_THUMBNAIL_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}






















def _read_config() -> dict:
    p = _runtime() / "config.json"
    if not p.exists():
        return {}
    try:
        data = json.loads(read_text_with_retry(p))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


@router.get("/config")
def get_config() -> dict:
    cfg = _read_config()
    return {
        "image_storage_root": cfg.get("image_storage_root") or str(_project_root()),
        "show_canvas_on_home": bool(cfg.get("show_canvas_on_home", True)),
    }












# 浏览器提交的参考路径字段：/api/raw 按 job 登记的这些路径放行读取，mj_image 还会把本地文件
# 上传成公网直链，所以每一项都要过数据根闸门。
# 减 mask_image / markup_image：只由服务端写（画布局部编辑 / 标注层），两个浏览器入口都先把浏览器传的丢掉。
# 加 source_image：不是 JobParams 的声明字段，但 extra="allow" 让浏览器能塞进来，caller 会回退读它。
_SERVER_OWNED_PATH_FIELDS = ("mask_image", "markup_image")
_BROWSER_REF_FIELDS = tuple(
    field for field in JOB_PARAM_PATH_FIELDS if field not in _SERVER_OWNED_PATH_FIELDS
) + ("source_image",)


def _is_web_url(value: str) -> bool:
    # 「再次生成」会把历史 job 的参考原样回传，其中有 http(s) 直链。
    # 直链原样放行，但不认路径的 caller 会拿它当本地文件读；Win32 会把 `..` 按字面折叠，
    # `http://x/../../.config/keys.json` 就成了真实路径。带 `..` 段或反斜杠的一律不算直链。
    if not value.startswith(("http://", "https://")) or not urlsplit(value).netloc:
        return False
    if "\\" in value:
        return False
    return ".." not in unquote(value).split("/")


def _gated_ref(field: str, index: int, item: Any) -> Any:
    if not isinstance(item, str) or _is_web_url(item):
        return item
    try:
        return str(data_root_file(item))
    except ValueError as error:
        raise HTTPException(422, detail=f"params.{field} 第 {index} 项：{error}") from error


def _gate_browser_refs(params: dict[str, Any]) -> dict[str, Any]:
    """每个参考路径过数据根闸门，返回改写成 resolve 后绝对路径的字段（落盘值与闸门判的是同一个）。"""
    gated: dict[str, Any] = {}
    for field in _BROWSER_REF_FIELDS:
        value = params.get(field)
        if isinstance(value, str):
            gated[field] = _gated_ref(field, 1, value)
        elif isinstance(value, list):
            gated[field] = [
                _gated_ref(field, index, item) for index, item in enumerate(value, start=1)
            ]
    return gated


@router.post("/prompt/{job_id}")
def post_prompt(job_id: str, patch: WebEditableJobPatch) -> dict:
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）")
    # dict 级 patch（保留白名单外字段原样），但读改写区间必须持 per-job 锁，
    # 防与 Skill 进程的 update_job_status 互相覆盖。
    with job_lock(job_id):
        data = json.loads(p.read_text(encoding="utf-8"))
        if data.get("namespace") == "canvas":
            raise HTTPException(403, detail="已冻结任务的快照和参数不能通过通用编辑接口修改")
        for field, value in patch.model_dump(exclude_unset=True).items():
            if field == "params" and isinstance(value, dict):
                existing_params = data.get("params")
                existing_params = existing_params if isinstance(existing_params, dict) else {}
                # These fields identify an already billed provider task.  Browser edits must never
                # replace or erase them, otherwise a forged/stale id could retrieve the wrong task
                # or make the runner submit a second order after losing its recovery handle.
                # mask_image / markup_image 同理只由服务端写。
                for owned in (
                    "provider_task_protocol", "provider_task_ids", "video_submission_attempts",
                    "mask_image", "markup_image", "image_edit", "mj_submission_ids", "mj_submit_uncertain",
                    "comfyui_resume", "evolink_state", "edit_inputs", "edit_prompt",
                    "route_id", "route_order", "route_tried",
                    "gateway_idempotency_key", "gateway_request_fingerprint", "gateway_unconfirmed", "gateway_reattach_of", "gateway_cancel_pending",
                    "gateway_settlement", "gateway_charged_on",
                ):
                    if owned in existing_params:
                        value[owned] = existing_params[owned]
                    else:
                        value.pop(owned, None)
                value = {**value, **_gate_browser_refs(value)}
            data[field] = value
        # Validate the complete post-patch document before replacing the durable Job JSON.  This
        # catches explicit nulls and cross-field violations without discarding legacy raw fields.
        validated = dict(data)
        validated.pop("seed", None)
        Job.model_validate(validated)
        atomic_write_json(p, data)
    return {"ok": True}




@router.post("/clipboard-attempt")
def post_clipboard_attempt(attempt: ClipboardAttempt) -> dict:
    log_path = _runtime() / "clipboard.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(attempt.model_dump_json() + "\n")
    return {"ok": True}


@router.get("/raw")
def get_raw_image(path: str, job_id: str | None = None) -> FileResponse:
    """两条鉴权路径：
    - `job_id` 在场：以 job.output_paths / params 参考路径 / source_image 作为白名单
    - 否则只放行 .runtime/uploads/ 下的文件（画师刚上传，还没绑到 job 上时的 preview 用）

    相对路径解析基准：data root（_project_root()），而非 CWD。
    /api/gallery/recent 返回的是相对路径（如 characters/foo/turnaround/v2.png），
    若用 Path(path).resolve() 会解析到 repo 根，与 job.output_paths 里的绝对路径对不上 → 403/404。
    """
    raw = Path(path)
    # 用 stat 保留 Windows 超长文件名错误，exists 会将它吞成不存在。这是请求
    # 参数本身不成形，回 400 而不是 403：没有「路径合法但无权读」这回事，也别让它冒成 500。
    try:
        target = (raw if raw.is_absolute() else _project_root() / raw).resolve()
        target.stat()
        exists = True
    except FileNotFoundError as error:
        if getattr(error, "winerror", None) == 206:
            raise HTTPException(400, detail="读图被拒：路径无效") from error
        exists = False
    except (ValueError, OSError) as error:
        raise HTTPException(400, detail="读图被拒：路径无效") from error
    if not exists:
        raise HTTPException(404)
    if job_id is not None:
        try:
            job = read_job(job_id)
        except FileNotFoundError as e:
            raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from e
        whitelist = set(job.output_paths)
        params = job.params.model_dump() if job.params else {}
        # 全部声明的路径字段都放行（含服务端写的 mask_image / markup_image）；params 里的 extra 字段 source_image
        # 不放行——Job 顶层的 source_image 在下面单独加。
        for field in JOB_PARAM_PATH_FIELDS:
            value = params.get(field)
            if isinstance(value, str):
                whitelist.add(value)
            elif isinstance(value, list):
                whitelist.update(item for item in value if isinstance(item, str))
        if job.source_image:
            whitelist.add(job.source_image)
        whitelist.update(item["path"] for item in params.get("edit_inputs") or [])
        # 网络直链不是本机文件；当路径解析会把 "http://../../etc/x" 拼成数据根外的真实路径。
        normalized_whitelist = {
            str((Path(p) if Path(p).is_absolute() else _project_root() / p).resolve())
            for p in whitelist
            if not p.startswith(("http://", "https://"))
        }
        if str(target) not in normalized_whitelist:
            raise HTTPException(403, detail="读图被拒：这个路径不在该 job 登记的产物列表里")
        return FileResponse(str(target))
    uploads_dir = (_runtime() / "uploads").resolve()
    if not target.is_relative_to(uploads_dir) or target == uploads_dir:
        raise HTTPException(403, detail="读图被拒：不带 job_id 只能读取刚上传的参考文件")
    return FileResponse(str(target))


from character_workflow.lib.canvas_projects import (  # noqa: E402
    AUDIO_UPLOAD_EXTS as _AUDIO_UPLOAD_EXTS, IMAGE_UPLOAD_EXTS as _IMAGE_UPLOAD_EXTS,
    MEDIA_UPLOAD_MAX_BYTES as _MEDIA_UPLOAD_MAX_BYTES,
    VIDEO_UPLOAD_EXTS as _VIDEO_UPLOAD_EXTS,
    upload_max_bytes as _upload_max_bytes,
)

from character_workflow.lib.heic_upload import (  # noqa: E402
    HEIC_UPLOAD_EXTS as _HEIC_UPLOAD_EXTS, HeicConversionError, convert_heic_to_jpeg,
)
from character_workflow.lib.gif_upload import (  # noqa: E402
    GIF_UPLOAD_EXTS as _GIF_UPLOAD_EXTS, GifConversionError, convert_gif_to_png, is_gif_content,
)

_UPLOAD_ALLOWED_EXTS = _IMAGE_UPLOAD_EXTS | _VIDEO_UPLOAD_EXTS | _AUDIO_UPLOAD_EXTS
# 画师能选的图片格式：HEIC / HEIF 在入口转成 JPEG、GIF 转成 PNG，库里只存 _IMAGE_UPLOAD_EXTS。
_CONVERTED_IMAGE_EXTS = _HEIC_UPLOAD_EXTS | _GIF_UPLOAD_EXTS
_IMAGE_PICKABLE_EXTS = _IMAGE_UPLOAD_EXTS | _CONVERTED_IMAGE_EXTS



def _mb(num_bytes: int) -> str:
    mb = num_bytes / 1024 / 1024
    return f"{mb:.0f}MB" if abs(mb - round(mb)) < 0.05 else f"{mb:.1f}MB"


def _ext_reject_detail(raw_name: str, ext: str, allowed: set[str]) -> str:
    """报错要能自证：说清是哪个文件、它的后缀是什么、这里到底收什么。"""
    shown = ext or "（没有扩展名）"
    return (
        f"「{raw_name}」的格式不支持：{shown} 不在允许的类型里。"
        f"这里只收 {'/'.join(sorted(e.lstrip('.') for e in allowed))}。"
        "请另存 / 转换成允许的格式后再上传。"
    )


def _size_reject_detail(raw_name: str, body: bytes, limit: int) -> str:
    """体积超限的报错带上像素尺寸：超限的图十有八九是长边过万的原图，
    只报「10MB 超了」画师不知道该压缩质量还是缩尺寸。"""
    dims = image_dimensions_from_bytes(body)
    pixels = f"，{dims[0]}×{dims[1]} 像素" if dims else ""
    return (
        f"「{raw_name}」太大：{_mb(len(body))}{pixels}，超过上限 {_mb(limit)}。"
        "请把图压缩、或把长边缩小后再上传（参考图不需要原图那么大）。"
    )


async def _read_media_upload(
    file: UploadFile,
    fallback_name: str = "upload",
) -> tuple[str, str, bytes, Literal["image", "video", "audio"]]:
    raw_name = file.filename or fallback_name
    ext = Path(raw_name).suffix.lower()
    allowed = _UPLOAD_ALLOWED_EXTS | _CONVERTED_IMAGE_EXTS
    if ext not in allowed:
        raise HTTPException(422, detail=_ext_reject_detail(raw_name, ext, allowed))
    raw_name, body = await _convert_image_upload(raw_name, await file.read())
    ext = Path(raw_name).suffix.lower()
    limit = _upload_max_bytes(ext)
    if len(body) > limit:
        raise HTTPException(413, detail=_size_reject_detail(raw_name, body, limit))
    media_kind: Literal["image", "video", "audio"] = (
        "image" if ext in _IMAGE_UPLOAD_EXTS else "video" if ext in _VIDEO_UPLOAD_EXTS else "audio"
    )
    return raw_name, ext, body, media_kind


async def _convert_image_upload(raw_name: str, body: bytes) -> tuple[str, bytes]:
    """HEIC / HEIF 转 JPEG、GIF 转 PNG（文件名跟着改后缀）；其他格式原样返回。

    GIF 按内容认：微信下载的表情图常是 GIF 内容配 .jpg 后缀。"""
    ext = Path(raw_name).suffix.lower()
    if ext in _GIF_UPLOAD_EXTS or (ext in _IMAGE_UPLOAD_EXTS and is_gif_content(body)):
        if len(body) > _MEDIA_UPLOAD_MAX_BYTES:
            raise HTTPException(413, detail=_size_reject_detail(raw_name, body, _MEDIA_UPLOAD_MAX_BYTES))
        try:
            return await run_in_threadpool(convert_gif_to_png, raw_name, body)
        except GifConversionError as error:
            raise HTTPException(422, detail=str(error)) from None
    if ext not in _HEIC_UPLOAD_EXTS:
        return raw_name, body
    # 转码要整张解进内存，先挡住异常大的源文件；转出来的 JPEG 再按图片上限检查。
    if len(body) > _MEDIA_UPLOAD_MAX_BYTES:
        raise HTTPException(413, detail=_size_reject_detail(raw_name, body, _MEDIA_UPLOAD_MAX_BYTES))
    try:
        return await run_in_threadpool(convert_heic_to_jpeg, raw_name, body)
    except HeicConversionError as error:
        raise HTTPException(422, detail=str(error)) from None


def _converted_mime(name: str) -> str:
    return "image/png" if name.lower().endswith(".png") else "image/jpeg"


@router.post("/uploads")
async def post_upload(file: UploadFile = File(...)) -> dict:
    """画师在 Web 上传源图 → .runtime/uploads/<uuid><ext>。
    返回的 path 可直接拼到 `/game-atelier:promo <id> --upload <path>` 复制命令里，
    Skill 拿到后将其挪到 characters/<id>/source/。
    """
    raw_name, ext, body, _media_kind = await _read_media_upload(file)
    target = await run_in_threadpool(_store_runtime_upload, ext, body)
    return {"path": str(target.resolve()), "filename": raw_name}


def _store_runtime_upload(ext: str, body: bytes) -> Path:
    uploads = _runtime() / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    target = uploads / f"{uuid.uuid4().hex}{ext}"
    atomic_write_bytes(target, body)
    return target














@router.delete("/studio/jobs/{job_id}")
def delete_studio_job(job_id: str, path: str | None = None) -> dict:
    """「删除这一轮」（带 path 时只删这一张）：移进回收站，返回 trash_id 供撤销
    （POST /api/trash/{id}/restore）。"""
    from character_workflow.lib import trash

    try:
        return {"trash_id": trash_studio_job(job_id, path)}
    except FileNotFoundError as e:
        raise HTTPException(404, detail="找不到这一轮，可能已被删除") from e
    except LookupError as e:
        raise HTTPException(404, detail=str(e)) from e
    except trash.TrashError as e:
        raise HTTPException(422, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(409, detail=str(e)) from e


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    try:
        delete_failed_job(job_id)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from e
    except ValueError as e:
        raise HTTPException(409, detail=f"这条记录不能删：{e}") from e
    return {"ok": True}
































class ProjectReorder(BaseModel):
    ordered_ids: list[str]


















# job 状态 → 中文（报错里给画师看，别把 pending_confirm 这种内部枚举原样丢出去）
_STATUS_CN = {
    "pending_confirm": "等待确认出图",
    "pending": "正在出图",
    "done": "已完成",
    "partial": "部分完成",
    "failed": "已失败",
    "canceled": "已停止",
}


def _status_cn(status: str) -> str:
    return _STATUS_CN.get(status, status)


@router.post("/jobs/{job_id}/confirm")
def post_job_confirm(job_id: str) -> dict:
    """画师在 Web 端点了"出图"按钮 —— 把 pending_confirm 推到 pending。
    Skill 自己在终端轮询 / SSE 监听 job-changed，看见 pending 就动手。
    写逻辑收敛到 jobs.update_job_status（带 per-job 锁），不再裸读裸写 json。"""
    try:
        job = read_job(job_id)
    except FileNotFoundError:
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from None
    if job.status != JobStatus.PENDING_CONFIRM:
        raise HTTPException(
            409,
            detail=(
                "这条记录不在「等待确认出图」状态，确认按钮对它无效"
                f"（当前状态：{_status_cn(job.status.value)}）"
            ),
        )
    key = keys.find_by_alias(job.alias) if job.alias else None
    if key is not None and not key.enabled:
        raise HTTPException(422, detail="供应商已停用")
    update_job_status(job_id, status=JobStatus.PENDING)
    return {"ok": True, "job_id": job_id, "status": JobStatus.PENDING.value}


# pending 超过这个时限仍未翻面 → 出图进程（Skill）大概率已中断，允许画师作废。
STALE_PENDING_MINUTES = 60


def _pending_age_minutes(job: Job) -> float | None:
    """submitted_at 距今多少分钟；解析不了（脏数据）返回 None，视同超时可作废。"""
    try:
        submitted = datetime.fromisoformat(job.submitted_at)
    except ValueError:
        return None
    if submitted.tzinfo is None:
        submitted = submitted.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - submitted).total_seconds() / 60


@router.post("/jobs/{job_id}/cancel")
def post_job_cancel(job_id: str) -> dict:
    """画师作废一条 job。

    - pending_confirm：从未真出图 —— 直接删 json 文件
      （留 FAILED 残骸会让 Web 把"作废的 prompt"误显示成"出图失败"）。
    - pending：登记 cancel_requested_at，runner 在下一个可中断点落 CANCELED（同步阻塞的
      上游请求打不断，所以这里只登记、不改 status；已提交的厂商任务可能已扣费，由 runner 写进 error）。
    - pending 且超过 STALE_PENDING_MINUTES：出图进程疑似已死 —— 直接标 FAILED 留痕。
      不删文件：万一 Skill 进程还活着并完成出图，update_job_status 仍能落 DONE 覆盖。
    """
    try:
        job = read_job(job_id)
    except FileNotFoundError:
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from None
    if job.status == JobStatus.PENDING_CONFIRM:
        (_runtime() / "jobs" / f"{job_id}.json").unlink()
        return {"ok": True, "job_id": job_id, "deleted": True}
    if job.status == JobStatus.PENDING:
        from character_workflow.lib.jobs import is_waiting_gateway_job, job_execution_lock

        if is_waiting_gateway_job(job):
            # 等待网关且此刻没有线程在跑它：直接停。网关那边的原任务可能仍会完成并扣额度。
            with job_execution_lock(job_id) as idle:
                if idle:
                    # 停止请求交给补发线程按幂等键送到主机（不在请求线程里打网络）：没发上游的主机会取消、
                    # 扣 0；已发上游的跑完并计费（飙哥定 Q3-1=B）。送达后按主机答复改文案。
                    from character_workflow.lib import gateway_cancel_outbox
                    from character_workflow.lib.job_runner import GATEWAY_CANCEL_UNDELIVERED
                    from character_workflow.lib.jobs import update_job_params

                    update_job_params(job_id, job.params.model_copy(update={"gateway_cancel_pending": True}))
                    update_job_status(job_id, status=JobStatus.CANCELED, error=GATEWAY_CANCEL_UNDELIVERED)
                    gateway_cancel_outbox.wake()
                    return {"ok": True, "job_id": job_id, "status": JobStatus.CANCELED.value}
        age = _pending_age_minutes(job)
        if not is_resumable_studio_job(job) and (age is None or age >= STALE_PENDING_MINUTES):
            update_job_status(
                job_id, status=JobStatus.FAILED,
                error=f"cancelled: pending 超过 {STALE_PENDING_MINUTES} 分钟，疑似进程中断",
            )
            return {"ok": True, "job_id": job_id, "status": JobStatus.FAILED.value}
        if job.namespace == "studio":
            # 排队中、从没发出的任务（创作台线程池满时排在后面的）：没有线程在跑它就直接停（Windows 实测 W5）。
            # 持着执行锁再判定并落终态：run_job 要先抢到这把锁才会读状态、提交，停止与提交不会同时发生。
            from character_workflow.lib.jobs import cancel_queued_unsent, job_execution_lock

            with job_execution_lock(job_id) as idle:
                if idle and cancel_queued_unsent(job_id) is not None:
                    return {"ok": True, "job_id": job_id, "status": JobStatus.CANCELED.value}
        request_job_cancel(job_id)
        return {"ok": True, "job_id": job_id, "status": JobStatus.PENDING.value, "cancel_requested": True}
    raise HTTPException(
        409,
        detail=(
            f"这条记录不能作废（当前状态：{_status_cn(job.status.value)}，"
            "只有出图中 / 等待确认的能作废）"
        ),
    )


@router.post("/config")
def post_config(payload: dict = Body(...)) -> dict:
    """合并式补丁：只更新请求里出现的已知键，其余键保留。"""
    # 读→改→写持锁：并发保存不互相覆盖。叶子锁，内部不取别的锁。
    with file_lock((_runtime() / "config.json").with_suffix(".lock")):
        cfg = _read_config()
        updated = False
        if "image_storage_root" in payload:
            raw = (payload.get("image_storage_root") or "").strip()
            if not raw:
                raise HTTPException(422, detail="图片存储目录不能为空")
            # Expand ~ and env vars; resolve to absolute path so future reads are stable.
            expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
            try:
                expanded.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                raise HTTPException(422, detail=f"无法创建目录：{e}") from e
            if not os.access(expanded, os.W_OK):
                raise HTTPException(422, detail=f"目录不可写：{expanded}")
            cfg["image_storage_root"] = str(expanded.resolve())
            updated = True
        if "show_canvas_on_home" in payload:
            value = payload["show_canvas_on_home"]
            if not isinstance(value, bool):
                raise HTTPException(422, detail="show_canvas_on_home 必须是布尔值（true / false）")
            cfg["show_canvas_on_home"] = value
            updated = True
        if not updated:
            raise HTTPException(
                422, detail="没有可识别的设置项：只接受 image_storage_root / show_canvas_on_home"
            )
        atomic_write_json(_runtime() / "config.json", cfg)
        return {"ok": True, **cfg}


class _DataRootPayload(BaseModel):
    path: str


class _FolderPickerPayload(BaseModel):
    title: str = "选择数据目录"
    initial_path: str | None = None


def _osascript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ps_single_quote(value: str) -> str:
    """PowerShell 单引号字面量转义：内部 ' 写成 ''。"""
    return "'" + value.replace("'", "''") + "'"


_FOLDER_APPLET = "选择文件夹.app"


def _run_folder_applet(source: str, work: Path) -> None:
    """经 LaunchServices 打开一个现编的小应用来弹框。

    服务是后台进程；macOS 14 起后台进程自己 activate 会被系统忽略，osascript 直接弹出的对话框
    只浮在最上层、拿不到键盘焦点（桌面外壳与浏览器都一样）。用 `open` 启动的应用会被带到前台。
    """
    script = work / "picker.applescript"
    script.write_text(source, encoding="utf-8")
    applet = work / _FOLDER_APPLET
    compiled = subprocess.run(
        ["osacompile", "-o", str(applet), str(script)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if compiled.returncode != 0:
        raise HTTPException(
            500, detail=f"打不开系统文件夹选择器：{compiled.stderr.strip() or '子进程没有给出原因'}"
        )
    subprocess.run(["open", "-W", "-n", str(applet)], capture_output=True, check=False)


def _pick_folder_macos(payload: "_FolderPickerPayload") -> dict:
    choose = f"choose folder with prompt {_osascript_string(payload.title)}"
    if payload.initial_path:
        initial = Path(os.path.expandvars(os.path.expanduser(payload.initial_path)))
        choose += f" default location POSIX file {_osascript_string(str(initial))}"
    with tempfile.TemporaryDirectory(prefix="atelier-folder-") as temporary:
        work = Path(temporary).resolve()
        chosen, failed = work / "chosen.txt", work / "error.txt"

        def write(target: Path, value: str) -> list[str]:
            return [
                f"set handle to open for access POSIX file {_osascript_string(str(target))} "
                "with write permission",
                f"write {value} to handle as «class utf8»",
                "close access handle",
            ]

        source = "\n".join([
            "activate",
            "try",
            f"set picked to {choose}",
            *write(chosen, "(POSIX path of picked)"),
            "on error message number code",
            "if code is not -128 then",  # -128 = 用户取消
            *write(failed, "message"),
            "end if",
            "end try",
        ])
        _run_folder_applet(source, work)
        if failed.exists():
            reason = failed.read_text(encoding="utf-8", errors="replace").strip()
            raise HTTPException(500, detail=f"打不开系统文件夹选择器：{reason or '子进程没有给出原因'}")
        picked = chosen.read_text(encoding="utf-8").strip() if chosen.exists() else ""
    return {"path": str(Path(picked).expanduser().resolve()) if picked else None}


def _pick_folder_windows(payload: "_FolderPickerPayload") -> dict:
    # WinForms FolderBrowserDialog 需 STA 线程；powershell -STA 满足。
    # 取消时不写任何 stdout → 返回 {"path": None}。
    lines = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
        f"$dlg.Description = {_ps_single_quote(payload.title)}",
        "$dlg.ShowNewFolderButton = $true",
    ]
    if payload.initial_path:
        initial = Path(os.path.expandvars(os.path.expanduser(payload.initial_path)))
        lines.append(f"$dlg.SelectedPath = {_ps_single_quote(str(initial))}")
    lines.append(
        "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.Write($dlg.SelectedPath) }"
    )
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command", "; ".join(lines)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise HTTPException(
            500,
            detail=f"打不开系统文件夹选择器：{(proc.stderr or '').strip() or '子进程没有给出原因'}",
        )
    selected = (proc.stdout or "").strip()
    if not selected:
        return {"path": None}
    return {"path": str(Path(selected).expanduser().resolve())}


def _bootstrap_script() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "bootstrap.py"


def _bootstrap_check(*extra: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--check", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise HTTPException(500, detail={
            "message": "无法读取 Cobrush 运行环境", "recovery": "重新打开 Cobrush 后再试",
            "raw": proc.stderr[-2000:],
        })
    return json.loads(proc.stdout)


_update_refresh = threading.Lock()


def _refresh_update_cache() -> None:
    """首屏只读更新缓存；联网检查放到后台，结果写缓存，下次读状态时生效。"""
    if not _update_refresh.acquire(blocking=False):
        return

    def run() -> None:
        try:
            subprocess.run(
                [sys.executable, str(_bootstrap_script()), "--check"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            _update_refresh.release()

    threading.Thread(target=run, name="update-cache-refresh", daemon=True).start()


@router.get("/onboarding/status")
def onboarding_status() -> dict:
    """Proxies `bootstrap.py --check` so Web 不用知道状态机细节。"""
    from character_workflow.lib import onboarding_metrics

    body = _bootstrap_check("--cached-update")
    if body.get("status") == "needs_data_root":
        # 首启先确认存放位置：预填服务正在用的目录，确认走 POST /api/onboarding/data-root。
        onboarding_metrics.note_first_seen()
        body["data_root"] = str(data_root.resolve_data_root())
    if body.get("status") in {"needs_first_key", "needs_keys_repair", "ready"}:
        with _provider_config_io(read_only=True):
            db = keys.read_keys_for_onboarding()
        body["status"] = "ready" if db.keys else "needs_first_key"
        body["next_action"] = "ready" if db.keys else "添加第一把供应商 Key"
    if body.get("runtime_mode") == "source" and not os.environ.get("GAME_ATELIER_NO_UPDATE_CHECK"):
        _refresh_update_cache()
    root = body.get("data_root")
    body["onboarding_skipped"] = bool(root) and onboarding_metrics.is_skipped(Path(root))
    body["keys_recovered"] = keys.keys_recovery_notice()
    return body


@router.post("/folder-picker")
def folder_picker(payload: _FolderPickerPayload) -> dict:
    """Open a native directory picker and return an absolute local path."""
    if sys.platform == "darwin":
        return _pick_folder_macos(payload)
    if sys.platform == "win32":
        return _pick_folder_windows(payload)
    raise HTTPException(
        501, detail="文件夹选择器目前只支持 macOS / Windows；其他系统请手动粘贴路径"
    )


def _init_data_root(path: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--init-data-root", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise HTTPException(500, detail={
            "message": "无法创建数据目录", "recovery": "检查磁盘权限后重试", "raw": proc.stderr[-2000:],
        })
    return json.loads(proc.stdout)


#: 首启选了一个不是空的、也不是数据目录的文件夹（比如整个 D 盘）时，数据放进它下面这个子文件夹。
_FIRST_RUN_FOLDER = "Cobrush"


@router.post("/onboarding/data-root")
def confirm_data_root(payload: _DataRootPayload) -> dict:
    """首启确认存放位置。留在服务正在用的目录就把它固定下来；选了别处按「更换数据目录」迁过去
    （复制在后台进行，用 GET /api/data-root 看进度），迁完才算确认，失败时下次启动还会问。"""
    from character_workflow.lib import data_root_move, onboarding_metrics

    if not payload.path.strip():
        raise HTTPException(422, detail="请选择一个文件夹")
    current = data_root.resolve_data_root()
    target = Path(payload.path).expanduser().resolve()
    if (target != current and target.is_dir() and not data_root_move.is_atelier_root(target)
            and any(target.iterdir())):
        target = target / _FIRST_RUN_FOLDER
    if target == current or not (data_root.read_global_config() or "").strip():
        _init_data_root(str(current))
        if target == current:
            onboarding_metrics.record_data_root_set(current)
            return data_root_state()
    return change_data_root(_DataRootPayload(path=str(target)))


@router.get("/data-root")
def data_root_state() -> dict:
    """当前数据目录与更换进度（复制中 / 校验中 / 完成 / 失败）。"""
    from character_workflow.lib import data_root_move

    return {"data_root": str(data_root.resolve_data_root()), "move": data_root_move.snapshot()}


@router.post("/data-root")
def change_data_root(payload: _DataRootPayload) -> dict:
    """更换数据目录：空目标复制并切换、已有 Atelier 数据直接切换、其他非空目录拒绝（规格 D1）。

    进行中的生成、Agent、网关任务（含排队、可续查的）都会拦住更换；data_root_move 先封住写入门闩、
    排空在途写请求再复查，切换后文件监听接不上就退回原目录。"""
    from character_workflow.lib import data_root_move
    from viewer_server.update_routes import data_root_move_work
    from viewer_server.watcher import restart_watchers

    if not payload.path.strip():
        raise HTTPException(422, detail="请选择一个文件夹")

    def busy() -> int:
        counts = data_root_move_work()
        return counts["jobs"] + counts["agents"] + counts["gateway"]

    previous = data_root.resolve_data_root()

    def switched() -> None:
        if data_root.resolve_data_root() != previous:
            # 从首启还没确认的目录迁走 = 用户选定了新位置（标记本身不随数据复制）。
            (previous / ".runtime" / data_root.UNCONFIRMED_MARKER).unlink(missing_ok=True)
        from viewer_server.collab_app import reload_collab_root
        reload_collab_root()
        restart_watchers()  # 抛错 = 切换失败，data_root_move 退回原目录后再调一次把监听挪回去
        from character_workflow.lib import onboarding_metrics

        try:
            onboarding_metrics.record_data_root_set(data_root.resolve_data_root())
        except OSError:
            logging.getLogger(__name__).warning("data root metrics not recorded", exc_info=True)

    try:
        move = data_root_move.start(payload.path, busy=busy, on_switched=switched)
    except data_root_move.MoveRejected as error:
        raise HTTPException(409, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(409, detail={"message": "无法读取选中的文件夹", "raw": str(error)}) from error
    return {"data_root": str(data_root.resolve_data_root()), "move": move}


class _UiPrefPayload(BaseModel):
    value: Any = None


@router.get("/ui-prefs")
def get_ui_prefs() -> dict:
    """界面偏好与已读记录（公告、更新日志）；存在数据目录里，不随端口变化丢失。"""
    from character_workflow.lib import ui_prefs

    return {"prefs": ui_prefs.read_prefs()}


@router.put("/ui-prefs/{key}")
def put_ui_pref(key: str, payload: _UiPrefPayload) -> dict:
    from character_workflow.lib import ui_prefs

    try:
        return {"prefs": ui_prefs.set_pref(key, payload.value)}
    except ui_prefs.UiPrefsError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.post("/onboarding/events", status_code=204)
def onboarding_event(payload: dict = Body(...)) -> Response:
    """引导的本机度量：只收枚举事件（见 onboarding_metrics），不上报。"""
    from character_workflow.lib import onboarding_metrics

    try:
        event = onboarding_metrics.OnboardingEvent.model_validate(payload)
    except ValidationError as e:
        raise HTTPException(422, "不支持的引导事件") from e
    onboarding_metrics.append_event(event)
    return Response(status_code=204)


@router.get("/onboarding/metrics")
def onboarding_metrics_summary() -> dict:
    from character_workflow.lib import onboarding_metrics

    return onboarding_metrics.metrics()


class _KeyProbePayload(BaseModel):
    preset: str = Field(max_length=40)
    access_key: str = Field(max_length=4096)
    # 表单当前的请求地址：与该预置的默认地址不一致时不发探针（密钥属于那个自定义地址）。
    base_url: str = Field(max_length=2048)


@router.post("/onboarding/key-probe")
def onboarding_key_probe(payload: _KeyProbePayload) -> dict:
    """粘贴密钥后的有效性提示；结果不拦保存。密钥只用于这一次请求，不落盘、不进日志。"""
    from character_workflow.lib import onboarding_metrics

    return {"result": onboarding_metrics.probe_key(payload.preset, payload.access_key,
                                                   payload.base_url)}


class _KeyCreatePayload(BaseModel):
    enabled: bool = True
    alias: str
    provider: str
    base_url: str | None = None
    billing_group: str | None = None
    access_key: str = ""
    auth_source: Literal["codex-cli"] | None = None
    secret_key: str | None = None
    capabilities: list[str] = []
    models: list[keys.ModelSpec] = []
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = []
    notes: str = ""
    created_at: str | None = None
    text_protocol: str | None = None
    icon: str | None = None

    @field_validator("models", mode="before")
    @classmethod
    def _normalize_models(cls, value: object) -> object:
        if isinstance(value, list):
            return [
                {"name": item, "id": item} if isinstance(item, str) else item
                for item in value
            ]
        return value


class _KeyPatchPayload(BaseModel):
    enabled: bool | None = None
    base_url: str | None = None
    billing_group: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
    capabilities: list[str] | None = None
    models: list[keys.ModelSpec] | None = None
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] | None = None
    notes: str | None = None
    # 显式传 null = 改回自动；不传 = 不改。
    text_protocol: str | None = None
    # 显式传 null = 恢复默认图标；不传 = 不改。
    icon: str | None = None

    @field_validator("models", mode="before")
    @classmethod
    def _normalize_models(cls, value: object) -> object:
        if isinstance(value, list):
            return [
                {"name": item, "id": item} if isinstance(item, str) else item
                for item in value
            ]
        return value


@router.get("/announcements")
def announcements() -> dict:
    """模型公告：远程源缓存优先、打包兜底，只返回本机版本已支持的（见 announcement_feed）。"""
    from character_workflow.lib.announcement_feed import visible
    from viewer_server.connection_status import app_version

    return {"announcements": visible(app_version())}


@router.get("/keys")
def list_keys() -> dict:
    with _provider_config_io(read_only=True):
        db = keys.read_keys_db()
        return {"keys": keys.keys_for_api(db), "default_alias": db.default_alias}


def _route_payload(route: model_routes.ModelRoute) -> dict:
    from character_workflow.lib.callers.openai_text import text_callable

    members, candidate_alias, estimates = model_routes.route_preview(route)
    return {
        "mode": route.mode, "candidate_alias": candidate_alias,
        "id": route.id, "name": route.name, "modality": route.modality,
        "members": [
            {"alias": m.alias, "provider": m.provider, "base_url": m.base_url,
             "billing_group": m.billing_group, "estimate_cny": estimates[m.alias],
             "model_id": m.model_id, "name": m.name, "protocol": m.protocol,
             **({"via": list(m.via)} if m.via else {}),
             # 与 /api/keys 同一判据：只在文本成员不能调用时出现。
             **({"text_unsupported": True} if route.modality == "text"
                and not text_callable(m.provider, m.protocol) else {})}
            for m in members
        ],
    }


@router.get("/models")
def list_model_routes() -> dict:
    return {"models": [_route_payload(route) for route in model_routes.list_routes()]}


class _ModelOrderPayload(BaseModel):
    model_config = {"extra": "forbid"}
    modality: Literal["text", "image", "video", "audio"]
    id: str = Field(min_length=1, max_length=200)
    aliases: list[str] = Field(min_length=1)


@router.put("/models/order")
def set_model_route_order(payload: _ModelOrderPayload) -> dict:
    return change_route_order(payload)


def change_route_order(payload: _ModelOrderPayload, actor=None) -> dict:
    from character_workflow.lib import gateway_audit, gateway_keys
    with gateway_keys._lock():
        current = gateway_keys.require_admin(gateway_keys._read_config_locked(), actor.id if actor else None)
        before = next(([m.alias for m in route.members] for route in model_routes.list_routes()
                       if route.modality == payload.modality and route.id == payload.id), [])
        result = _apply_route_order(payload, upstream_only=actor is not None)
        gateway_audit.append("route.reorder", payload.id, {"modality": payload.modality,
                             "before": before, "after": payload.aliases}, current)
        return result


def _apply_route_order(payload: _ModelOrderPayload, *, upstream_only: bool = False) -> dict:
    try:
        route = model_routes.set_route_order(payload.modality, payload.id, payload.aliases, upstream_only=upstream_only)
    except model_routes.NoSuchRouteError as error:
        raise HTTPException(404, str(error)) from None
    except model_routes.InvalidRouteOrderError as error:
        raise HTTPException(422, str(error)) from None
    return _route_payload(route)


class _ModelModePayload(BaseModel):
    model_config = {"extra": "forbid"}
    modality: keys.ModelModality
    id: str = Field(min_length=1, max_length=200)
    mode: keys.RouteMode


@router.put("/models/mode")
def set_model_route_mode(payload: _ModelModePayload) -> dict:
    try:
        return _route_payload(model_routes.set_route_mode(payload.modality, payload.id, payload.mode))
    except model_routes.NoSuchRouteError as error:
        raise HTTPException(404, str(error)) from None


def _checked_bindings(provider: str, models: list[keys.ModelSpec]) -> list[keys.ModelSpec]:
    """自定义接口绑定只在这个写入边界校验（ADR-0036）；读盘不校验，旧数据不会被拖垮。"""
    from character_workflow.lib.http_protocols import normalize_bindings

    try:
        return normalize_bindings(provider, models)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def _checked_text_protocol(provider: str, value: str | None) -> str | None:
    """供应商级「接口」只在写入边界校验（ADR-0044）：只有自定义供应商可以手动选。"""
    from character_workflow.lib import llm_protocols

    if value is None:
        return None
    if value not in llm_protocols.MANUAL_CHOICES:
        raise HTTPException(422, f"不认识的接口：{value}")
    if provider != "custom":
        raise HTTPException(422, "只有自定义供应商可以选择接口")
    return value


def _checked_icon(value: str | None) -> str | None:
    """自定义图标只在写入边界校验（I1）：`brand:<id>` 或已落盘的 `file:<sha256>`。"""
    from character_workflow.lib import provider_icons

    try:
        return provider_icons.checked_icon(value)
    except provider_icons.IconRejected as error:
        raise HTTPException(422, str(error)) from None


def _stamp_text_protocol(text_protocol: str | None, modalities: list[str],
                         models: list[keys.ModelSpec]) -> list[keys.ModelSpec]:
    """手动选了接口：这把 KEY 的文本模型都按它调用；自动（None）时各模型保持原样。"""
    if text_protocol is None:
        return models
    llm_only = set(modalities) == {"llm"}
    return [
        model.model_copy(update={"protocol": text_protocol})
        if (model.modality == "text" or (model.modality is None and llm_only))
        and model.protocol != "declarative" else model
        for model in models
    ]


def _sync_new_model_prices(provider: str, base_url: str | None = None) -> None:
    """新加的 TokenDance / Tuzi 模型（Tuzi 还有新填的计费分组）不等下一轮全量同步，后台补拉价格，
    模型菜单与估价马上可用。"""
    if provider == "tokendance":
        from character_workflow.lib.tokendance_prices import start_missing_sync

        start_missing_sync()
    host = (urlsplit(base_url or "").hostname or "").lower()
    if host == "tu-zi.com" or host.endswith(".tu-zi.com"):
        from character_workflow.lib.tuzi_prices import start_stale_sync

        start_stale_sync()


@contextmanager
def _provider_config_io(*, read_only: bool = False):
    from viewer_server import diagnostics

    try:
        yield
    except keys.KeysConfigError as error:
        diagnostics.record_key_config_error(error, read_only=read_only)
        raise HTTPException(409, str(error)) from None
    except OSError as error:
        diagnostics.record_key_config_error(error, read_only=read_only)
        winerror = getattr(error, "winerror", None)
        if winerror in {32, 33}:
            reason = "配置文件正被占用，请稍后重试"
        elif error.errno == errno.ENOSPC or winerror == 112:
            reason = "数据目录磁盘空间不足，请腾出空间后重试"
        elif isinstance(error, PermissionError) or winerror == 5 or error.errno == errno.EROFS:
            reason = "请检查当前系统用户对数据目录的读写权限"
        else:
            reason = "请检查数据目录是否可用"
        action = "读取" if read_only else "保存"
        detail = f"无法{action}本机供应商配置，{reason}"
        if winerror is not None:
            detail += f"（WinError {winerror}）"
        elif error.errno is not None:
            detail += f"（errno {error.errno}）"
        raise HTTPException(503, detail) from None


@router.post("/keys", status_code=201)
def create_key(payload: _KeyCreatePayload) -> dict:
    from datetime import datetime, timezone
    if payload.provider not in {"chatgpt", "comfyui"} and not payload.access_key.strip():
        raise HTTPException(422, "供应商密钥不能为空")
    if payload.provider == "comfyui" and payload.models:
        raise HTTPException(422, "请通过工作流导入添加 ComfyUI 模型")
    payload.models = _checked_bindings(payload.provider, payload.models)
    text_protocol = _checked_text_protocol(payload.provider, payload.text_protocol)
    payload.models = _stamp_text_protocol(text_protocol, payload.modalities, payload.models)
    icon = _checked_icon(payload.icon)
    try:
        spec = keys.KeySpec(
            alias=payload.alias, provider=payload.provider, enabled=payload.enabled,
            base_url=payload.base_url,
            billing_group=payload.billing_group,
            access_key=payload.access_key, secret_key=payload.secret_key,
            auth_source=payload.auth_source,
            capabilities=payload.capabilities, models=payload.models,
            homepage_url=payload.homepage_url,
            docs_url=payload.docs_url,
            api_key_url=payload.api_key_url,
            modalities=payload.modalities,
            notes=payload.notes,
            created_at=payload.created_at or datetime.now(timezone.utc).isoformat(),
            text_protocol=text_protocol,
            icon=icon,
        )
    except Exception as e:
        detail = "ChatGPT 订阅配置无效" if payload.provider == "chatgpt" else str(e)
        raise HTTPException(422, detail) from e
    try:
        with _provider_config_io():
            keys.add_key(spec)
    except keys.DuplicateAliasError:
        raise HTTPException(
            409, f"名称「{payload.alias}」已被另一个供应商使用：换个名称，或直接编辑那一个"
        ) from None
    if spec.provider == "atelier":
        # 局域网网关接进来就排在每个路由组的第一位，本机 KEY 作兜底（ADR-0025）。
        model_routes.put_alias_first(spec.alias)
    _sync_new_model_prices(spec.provider, spec.base_url)
    return {"alias": payload.alias}


@router.patch("/keys/{alias}")
def patch_key_endpoint(alias: str, payload: _KeyPatchPayload) -> dict:
    patch_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    with _provider_config_io():
        stored = keys.find_by_alias(alias)
    if stored and stored.provider == "comfyui" and "models" in patch_data:
        raise HTTPException(422, "请通过工作流编辑修改 ComfyUI 模型")
    if stored and payload.models is not None:
        patch_data["models"] = [model.model_dump() for model in
                                _checked_bindings(stored.provider, payload.models)]
    # billing_group 留空表示明确关闭聚合商计价；不能像密钥字段一样把显式 null 当作“未传”。
    if "billing_group" in payload.model_fields_set:
        patch_data["billing_group"] = payload.billing_group
    if stored is not None and "text_protocol" in payload.model_fields_set:
        patch_data["text_protocol"] = _checked_text_protocol(stored.provider, payload.text_protocol)
    if stored is not None and ("text_protocol" in patch_data or "models" in patch_data):
        chosen = patch_data.get("text_protocol", stored.text_protocol)
        current = patch_data.get("models", [m.model_dump() for m in stored.models])
        patch_data["models"] = [model.model_dump() for model in _stamp_text_protocol(
            chosen, patch_data.get("modalities", stored.modalities),
            [keys.ModelSpec.model_validate(m) for m in current])]
    if "icon" in payload.model_fields_set:
        patch_data["icon"] = _checked_icon(payload.icon)
    if "access_key" in patch_data and not str(patch_data["access_key"]).strip():
        raise HTTPException(422, "供应商密钥不能为空")
    try:
        with _provider_config_io():
            keys.patch_key(alias, patch_data)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"找不到别名「{alias}」的密钥（可能已被删除）") from None
    except ValidationError as error:
        raise HTTPException(422, "供应商配置无效") from error
    if stored is not None and ("models" in patch_data or "billing_group" in patch_data
                               or "base_url" in patch_data):
        _sync_new_model_prices(stored.provider, patch_data.get("base_url", stored.base_url))
    return {"alias": alias}


@router.delete("/keys/{alias}", status_code=204)
def delete_key_endpoint(alias: str) -> None:
    from character_workflow.lib import gateway_keys

    keys.delete_key(alias)
    gateway_keys.drop_alias_from_scopes(alias)  # 网关密钥范围里去掉它（第 7 批）
    return None


@router.get("/keys/{alias}/reveal")
def reveal_key_endpoint(alias: str) -> dict:
    """按需返回某个已存密钥的明文，供编辑表单的「显示密钥」用。

    安全边界：viewer-server 绑 127.0.0.1，仅本机回环可达；密钥本就以明文存于
    <data_root>/.config/keys.json，向本机持有者回显不扩大暴露面。列表 / 创建
    接口仍只回掩码——明文只在此处、按显式 alias、按需返回。
    """
    spec = keys.find_by_alias(alias)
    if spec is None:
        raise HTTPException(404, f"找不到别名「{alias}」的密钥（可能已被删除）")
    return {"access_key": spec.access_key}


@router.get("/subscriptions/chatgpt")
def chatgpt_subscription_status(response: Response) -> dict:
    from character_workflow.lib.chatgpt_auth import get_auth_status

    response.headers["Cache-Control"] = "no-store"
    return get_auth_status()


class _ModelsPreviewPayload(BaseModel):
    alias: str | None = None
    provider: str | None = None
    base_url: str | None = None
    access_key: str | None = None
    # 逃生舱：连判定为不可生成的模型也一并返回（词表判过头时用）。
    include_all: bool = False
    # 表单上当前选的「接口」（ADR-0044）；不传时用已存的。Anthropic 按它的鉴权头与路径列模型。
    text_protocol: str | None = None
    # 按自定义接口模板的 catalog 发现模型（ADR-0036）；不带时走默认 GET /models。
    protocol_id: str | None = None


# 模型分类：text / image / video / audio / unknown / excluded。
#
# excluded 是**唯一**授权丢弃的类别：上游明确标注了协议，且全部都不能生成四模态内容。
# 判不出来一律 unknown 留在列表里让画师自己确认 —— 协议词汇是各厂自造的（同一份词元跳动
# 数据里就有 zai:layout-parsing / bocha:web-search / unifuncs:web-reader），词表永远追不完，
# 「认不出就丢」会让某个网关的模型列表整片消失且用户看不出原因。
_VIDEO_ID_HINTS = (
    "video", "seedance", "vidu", "kling", "veo", "sora",
    "happyhorse", "pixverse", "runway", "hailuo",
)
_IMAGE_ID_HINTS = (
    "image", "seedream", "seededit", "dall-e", "dalle", "flux", "banana", "midjourney",
    "cogview", "imagen", "ideogram", "recraft", "irag", "kolors", "hidream",
)
_AUDIO_ID_HINTS = (
    "tts", "speech", "text-to-speech",
)
_AUDIO_NON_GENERATION_ID_HINTS = (
    "asr", "speech-to-text", "speech2text", "transcription", "whisper",
)
_TEXT_ID_HINTS = (
    "gpt", "claude", "gemini", "deepseek", "qwen", "llama", "mistral", "command-r",
    "grok", "kimi", "glm", "gemma",
)
# 词边界判不了的对话家族：OpenAI o 系列（o1 / o3-mini / o4-mini）与 MiniMax M 系列
# （MiniMax-M2.5；同家的 MiniMax-H3 是视频，不能整家归对话）。
_TEXT_ID_PATTERN = re.compile(r"o\d+(?:-|$)|minimax-m\d")
# 协议动词（冒号后半段）判视觉；seedance:generations 这类动词无信息量，靠厂商前缀兜。
_PROTOCOL_IMAGE_HINTS = (
    "image-generations", "image-generation", "images", "image-edits", "images-edits",
    "image2image", "t2i", "text2image",
)
_PROTOCOL_VIDEO_HINTS = (
    "video", "seedance", "vidu", "happyhorse", "t2v", "i2v", "r2v",
    "text2video", "image2video",
)
_PROTOCOL_AUDIO_GENERATION_HINTS = (
    "text-to-speech", "tts",
)
_PROTOCOL_UNSUPPORTED_AUDIO_GENERATION_HINTS = (
    "text2audio", "audio-generation", "audio-generations", "t2a", "music",
)
_PROTOCOL_TEXT_GENERATION_HINTS = (
    "chat-completions", "chat/completions", "openai:responses", "openai/responses",
    "anthropic:messages", "anthropic/messages",
)
_PROTOCOL_UNSUPPORTED_TEXT_GENERATION_HINTS = ("messages", "completions")
# 明确不能生成四模态内容的协议动词：全部命中才判 excluded。
_PROTOCOL_NON_VISUAL_HINTS = (
    "embeddings", "rerank", "moderations", "asr", "speech-to-text", "speech2text",
    "transcriptions", "translations",
    "voice_clone", "web-search", "web-reader", "search", "layout-parsing", "ocr",
)


def _id_hits(mid: str, hints: tuple[str, ...]) -> bool:
    """id 关键词按**词边界**匹配 —— 裸子串会把 `inkling`（纯文本）判成 kling 视频、
    把 `wanx`（通义万相，图像）判成视频。前后不许紧邻字母数字。"""
    return any(re.search(rf"(?<![a-z0-9]){re.escape(h)}(?![a-z0-9])", mid) for h in hints)


def _classify_model(item: dict) -> str:
    """返回四种可生成模态、unknown 或 excluded。"""
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    if any(h in p for p in protocols for h in _PROTOCOL_IMAGE_HINTS):
        return "image"
    if any(h in p for p in protocols for h in _PROTOCOL_VIDEO_HINTS):
        return "video"
    if any(_speech_protocol(protocol) for protocol in protocols):
        return "audio"
    if any(h in p for p in protocols for h in _PROTOCOL_TEXT_GENERATION_HINTS):
        return "text"
    # 每一条协议都明确不能生成四模态内容才排除；混合标注保守留下。
    if protocols and all(
        any(h in p for h in _PROTOCOL_NON_VISUAL_HINTS) for p in protocols
    ):
        return "excluded"
    # Anthropic `messages` / legacy `completions` 虽然能产文本，但当前 caller 未实现。
    # 显式协议不匹配时必须停在 unknown，不能再靠 id / output modality 把它包装成
    # 可执行模型；否则 UI 会允许提交，runner 却只能打错端点。
    if any(
        any(hint in protocol for hint in _PROTOCOL_UNSUPPORTED_TEXT_GENERATION_HINTS)
        for protocol in protocols
    ):
        return "unknown"
    if any(
        any(hint in protocol for hint in _PROTOCOL_UNSUPPORTED_AUDIO_GENERATION_HINTS)
        for protocol in protocols
    ):
        return "unknown"

    # OpenRouter 等不给 supported_protocols，但给 architecture.output_modalities —— 这是
    # 权威字段，必须排在 id 猜测之前（实测它能修好 openrouter/auto、干掉 inkling 假阳性）。
    mid = str(item.get("id") or "").lower()
    arch = item.get("architecture")
    out = {str(m).lower() for m in (arch or {}).get("output_modalities") or []} if isinstance(arch, dict) else set()
    if "video" in out:
        return "video"
    if "image" in out:
        return "image"
    if "speech" in out:
        return "audio"
    if "audio" in out:
        return (
            "audio"
            if _id_hits(mid, _AUDIO_ID_HINTS)
            and not _id_hits(mid, _AUDIO_NON_GENERATION_ID_HINTS)
            else "unknown"
        )
    if "text" in out:
        return "text"
    if out:
        return "excluded"

    # MJ 族与运行时同一判据（image_family）：只有出图入口归图片；任务动作和速度档虽然也挂成
    # 独立 id，但不能单独生成，必须排在视频词之前（mj_fast_video 是对已有图的动作）。
    if image_family(mid) == "midjourney":
        return "image" if is_midjourney_entry(mid) else "excluded"
    if _id_hits(mid, _VIDEO_ID_HINTS):
        return "video"
    if _id_hits(mid, _IMAGE_ID_HINTS):
        return "image"
    if _id_hits(mid, _AUDIO_ID_HINTS) and not _id_hits(mid, _AUDIO_NON_GENERATION_ID_HINTS):
        return "audio"
    if mid.startswith(("doubao-seed-", "doubao-pro-", "doubao-lite-")):
        # 火山 /models 对豆包对话模型通常不返回 output_modalities 或
        # supported_protocols；只收明确的对话家族，未知 doubao 家族仍交给用户确认。
        return "text"
    if _id_hits(mid, _TEXT_ID_HINTS) or _TEXT_ID_PATTERN.match(mid.rsplit("/", 1)[-1]):
        return "text"
    return "unknown"


def _guess_model_modality(item: dict) -> str | None:
    """四种生成类别可直接作为 modality；unknown 交给画师标。"""
    category = _classify_model(item)
    return category if category in ("text", "image", "video", "audio") else None


def _text_protocol(item: dict) -> str | None:
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    if any("openai:responses" in p or "openai/responses" in p for p in protocols):
        return "openai-responses"
    if any("chat-completions" in p or "chat/completions" in p for p in protocols):
        return "openai-chat"
    # 只声明 Anthropic 格式时才走它（同时有 OpenAI 格式的取 OpenAI，转换最少）。
    if any("anthropic:messages" in p or "anthropic/messages" in p for p in protocols):
        return "anthropic-messages"
    return None


# 厂商私有的语音 / 音乐协议：端点与请求体都不是 OpenAI 的 audio/speech，必须按厂商协议走各自的 caller。
_VENDOR_SPEECH_PROTOCOLS = {
    "minimax:t2a_v2": "minimax-t2a", "ark:tts": "ark-tts", "kling:tts": "kling-tts",
    "yinchao:song": "yinchao-song",
}
_VENDOR_SPEECH_PREFIXES = ("minimax:", "ark:", "kling:", "yinchao:")


def _speech_protocol(protocol: str) -> str | None:
    """上游一条协议标注对应的本机音频协议 id（语音或音乐）；不是音频生成返回 None。"""
    if protocol in _VENDOR_SPEECH_PROTOCOLS:
        return _VENDOR_SPEECH_PROTOCOLS[protocol]
    # 同一厂商的流式（_ws）等变体不是 OpenAI 兼容端点，也不能靠 tts 字样被认成 openai-speech。
    if protocol.startswith(_VENDOR_SPEECH_PREFIXES):
        return None
    return "openai-speech" if _protocol_is_openai_speech(protocol) else None


def _audio_protocol(item: dict) -> str | None:
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    for protocol in protocols:
        if speech := _speech_protocol(protocol):
            return speech
    arch = item.get("architecture")
    if isinstance(arch, dict) and "speech" in (arch.get("output_modalities") or []):
        return "openai-speech"
    return None


def _declared_unknown_protocol(item: dict) -> str | None:
    """保留 unknown 模型的显式协议，让手动标模态后 caller 仍能诚实拒绝错端点。"""
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    return protocols[0] if protocols else None


def _protocol_is_openai_speech(protocol: str) -> bool:
    blocked = ("asr", "transcription", "speech-to-text", "speech2text")
    if any(item in protocol for item in blocked):
        return False
    return (
        any(item in protocol for item in _PROTOCOL_AUDIO_GENERATION_HINTS)
        or protocol.endswith(":speech")
        or protocol.endswith("audio/speech")
    )


def _model_list_error(code: str, raw: str) -> HTTPException:
    """拉模型列表失败 → 一句能照着做的原因 + 修复建议；上游原文只进 raw（前端「查看技术详情」）。
    code 沿用任务失败分类（invalid_key / bad_endpoint / network / unknown）。"""
    message, recovery = {
        "invalid_key": ("密钥无效或没有权限", "核对密钥是否复制完整、是否已在供应商后台停用"),
        "bad_endpoint": ("请求地址不对，没找到模型列表接口", "检查地址是否少了 /v1；地址没错就手动添加模型"),
        "network": ("连不上供应商，可能是本机代理或网络问题", "检查网络与代理设置后重试"),
        "timeout": ("供应商响应超时", "稍后重试；一直超时就检查网络与代理设置"),
    }.get(code, ("供应商返回了错误", "稍后重试；一直失败就展开技术详情查看原因"))
    return HTTPException(502, {"message": message, "code": code, "recovery": recovery, "raw": raw[:500]})


def _fetch_model_body(url: str, headers: dict, *, follow_redirects: bool = True) -> object:
    """拉一次上游模型列表，返回解析后的 JSON；任何一步失败都抛 502：先分类成一句原因，上游原文放 raw。
    不跟随重定向时 3xx 也算失败（带着密钥的请求不去别的地址，3xx 的响应体不当列表用）。"""
    import requests

    try:
        # 默认调用保持原样；不跟随重定向时才显式传参。
        extra = {} if follow_redirects else {"allow_redirects": False}
        resp = requests.get(url, headers=headers, timeout=20, **extra)
    except requests.exceptions.SSLError as e:
        raise _model_list_error("bad_endpoint", f"请求上游失败: {e}") from e
    except requests.Timeout as e:
        code = "network" if isinstance(e, requests.exceptions.ConnectTimeout) else "timeout"
        raise _model_list_error(code, f"请求上游失败: {e}") from e
    except requests.RequestException as e:
        raise _model_list_error("network", f"请求上游失败: {e}") from e
    if resp.status_code >= 400 or (not follow_redirects and resp.status_code >= 300):
        status = resp.status_code
        code = ("invalid_key" if status in (401, 403) else "bad_endpoint" if status in (404, 405)
                else "unknown")
        raise _model_list_error(code, f"上游 {status}: {resp.text[:200]}")
    try:
        return resp.json()
    except ValueError as e:
        # 地址指到了网页（常见：少了 /v1，落到官网首页）。
        raise _model_list_error("bad_endpoint", f"上游响应非 JSON: {resp.text[:200]}") from e


def _model_rows(body: object, rows_key: str = "data") -> list:
    rows = body.get(rows_key) if isinstance(body, dict) else body
    if not isinstance(rows, list):
        raise _model_list_error("bad_endpoint", f"上游响应缺少模型列表（{rows_key}）")
    return rows


def _fetch_model_rows(url: str, headers: dict, *, follow_redirects: bool = True,
                      rows_key: str = "data") -> list:
    """拉一次上游模型列表并归一成 list；任何一步失败都抛 502 带上游原文。"""
    return _model_rows(_fetch_model_body(url, headers, follow_redirects=follow_redirects), rows_key)


def _new_api_label(base_url: str) -> str | None:
    """New API 的公开 `/api/status`（不带密钥、不跟随重定向）给出的站点名与版本，只用于显示；拿不到就不显示
    （OpenAI-HK 回 404，2026-11-20 免费探针）。"""
    import requests

    parts = urlsplit(base_url)
    try:
        resp = requests.get(f"{parts.scheme}://{parts.netloc}/api/status", timeout=10, allow_redirects=False)
        data = resp.json().get("data") if resp.status_code == 200 else None
    except (requests.RequestException, ValueError, AttributeError):
        return None
    if not isinstance(data, dict):
        return None
    name = str(data.get("system_name") or "").strip()
    version = str(data.get("version") or "").strip()
    return " ".join(part for part in (name, version) if part)[:80] or None


def _detect_listing(base_url: str, access_key: str, provider: str) -> tuple[list, str | None, str | None]:
    """自动识别（ADR-0044 第 3 批）：先用 OpenAI 的 Bearer 拉列表看形状；失败且地址定不下时，对同一个 origin
    换 Anthropic、Gemini 的鉴权头各试一次（不跟随重定向）。返回 (条目, 家族, 默认协议)，全失败抛第一次的错误。"""
    from character_workflow.lib.llm_protocols import anthropic, detect, gemini

    headers = {"Authorization": f"Bearer {access_key}"} if access_key else {}
    try:
        body = _fetch_model_body(_model_list_url(base_url, provider), headers)
    except HTTPException as first_error:
        if not access_key or detect.from_address(base_url) is not None:
            raise
        fallbacks = (
            (f"{anthropic.models_url(base_url)}?limit=1000", anthropic.headers(base_url, access_key), "data"),
            (f"{gemini.models_url(base_url)}?pageSize=1000", gemini.headers(access_key), "models"),
        )
        for url, auth, rows_key in fallbacks:
            try:
                body = _fetch_model_body(url, auth, follow_redirects=False)
            except HTTPException:
                continue
            family = detect.listing_family(body)
            if family in ("anthropic", "gemini"):
                rows = _model_rows(body, rows_key)
                return (_gemini_model_rows(rows) if family == "gemini" else rows), family, \
                    detect.family_protocol(family)
        raise first_error
    family = detect.listing_family(body)
    if family == "gemini":
        return _gemini_model_rows(_model_rows(body, "models")), family, detect.family_protocol(family)
    return _model_rows(body), family, detect.from_address(base_url) or detect.family_protocol(family)


def _gemini_model_rows(rows: list) -> list[dict]:
    """Gemini 列表 `models[]{name, displayName, supportedGenerationMethods}` → 与 OpenAI 列表同形的条目。

    官方的 `name` 带 `models/` 前缀，New API 模拟的不带；New API 的 `supportedGenerationMethods` 是空数组，
    所以只在它非空时才要求含 `generateContent`（2026-11-20 对 Tuzi、OpenAI-HK 的免费探针）。"""
    out = []
    for item in rows:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        methods = item.get("supportedGenerationMethods") or []
        if methods and "generateContent" not in methods:
            continue
        model_id = str(item["name"]).removeprefix("models/")
        out.append({"id": model_id, "name": str(item.get("displayName") or model_id)})
    return out


def _model_list_url(base_url: str, provider: str) -> str:
    """OpenRouter 默认只返回文本输出；显式取全量，避免静默漏掉其他模态。"""
    parts = urlsplit(base_url)
    path = parts.path.rstrip("/")
    # 只填了根域名（https://api.openai-hk.com）时与出图同规则补 /v1（见 openai_image._api_root）；
    # 否则拉到 /models，OpenAI-HK 回 404、Tuzi 回网站首页 HTML。
    if not path:
        path = "/v1"
    if not path.endswith("/models"):
        path += "/models"
    host = (parts.hostname or "").lower()
    query = parts.query
    if host == "openrouter.ai" or host.endswith(".openrouter.ai") or provider == "openrouter":
        # 官方契约：同时省略 offset / limit 才返回完整列表，而不是默认分页的 500 条。
        params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True)
                  if k not in {"output_modalities", "offset", "limit"}]
        query = urlencode([*params, ("output_modalities", "all")])
    return parts._replace(path=path, query=query, fragment="").geturl()


def _url_host(url: str) -> str:
    """取 URL 的 host（含端口）用于同源比对；解析不出就返回原串以免两个空值相等。"""
    netloc = urlsplit((url or "").strip()).netloc.lower()
    return netloc or (url or "").strip().lower()


def _is_evolink_kling_entry(model_id: str) -> bool:
    """EvoLink 把同一代可灵按任务拆成多个 id；只把文生入口列给画师，图生 / 参考由 caller 按输入换。"""
    from character_workflow.lib.video_caps import kling_spec

    return model_id.endswith("-text-to-video") and kling_spec(model_id) is not None


def _image_protocol(item: dict) -> str | None:
    """图片模型的调用协议 —— 直接取上游协议标注，别猜。

    网关按协议挂端点：词元跳动的 seedream-5.0-pro 只声明 `ark:image-generations`，
    打 OpenAI 兼容入口会被判 503「无可用端点」。声明了 openai 的一律走默认入口
    （兼容层更通用）；只声明 ark 的必须走 Ark 原生端点；没有协议字段的上游返回
    None，由 caller 端启发式兜底。
    """
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    image_protocols = [p for p in protocols if "image-generations" in p]
    if not image_protocols:
        return None
    if any(p.startswith("openai") for p in image_protocols):
        return "openai"
    if any(p.startswith("ark") for p in image_protocols):
        return "ark"
    return None


def _supported(value: object) -> bool:
    return value is True or (isinstance(value, dict) and value.get("supported") is True)


def _model_input_modalities(item: dict) -> list[str]:
    """Normalize explicit upstream input modality declarations; never infer vision from model ids."""
    arch = item.get("architecture")
    raw = item.get("input_modalities")
    if raw is None and isinstance(arch, dict):
        raw = arch.get("input_modalities")
    capabilities = item.get("capabilities")
    if raw is None and isinstance(capabilities, dict) and "image_input" in capabilities:
        # Anthropic Models API 的能力字段（ADR-0044）。
        raw = ["text", "image"] if _supported(capabilities["image_input"]) else ["text"]
    if not isinstance(raw, list):
        return []
    allowed = {"text", "image", "video", "audio"}
    return [kind for kind in (str(value).lower() for value in raw) if kind in allowed]


@router.post("/keys/models-preview")
def keys_models_preview(payload: _ModelsPreviewPayload) -> dict:
    """代理拉取上游 GET {base}/models 供 Key 表单做模型映射。

    走服务端代理的原因：浏览器直连上游有 CORS；编辑已存 Key 时前端只有掩码密钥，
    必须由服务端按 alias 取真实密钥。
    """
    base_url = (payload.base_url or "").strip()
    access_key = (payload.access_key or "").strip()
    preview_provider: str = payload.provider or "custom"
    if payload.alias:
        stored = keys.find_by_alias(payload.alias)
        if stored is None:
            raise HTTPException(404, f"找不到别名「{payload.alias}」的密钥（可能已被删除）")
        if access_key:
            # 调用方自带密钥（新建 / 编辑时改过密钥）→ 地址随它，泄露面止于它自己的密钥。
            base_url = base_url or (stored.base_url or "")
        else:
            # 要用存储的**明文**密钥，就只能打存储的那个 host：否则等于让调用方指定「把密钥
            # 发到哪」。viewer-server 没有 TrustedHost / CSRF 防线，DNS rebinding 下本机页面
            # 就能触发。换 host 属于换供应商，本来就该重新填密钥。同 host 换路径照常放行。
            stored_base = stored.base_url or ""
            if base_url and _url_host(base_url) != _url_host(stored_base):
                raise HTTPException(
                    400, "服务地址换了域名，请先填写该地址对应的密钥再拉取模型列表"
                )
            base_url = base_url or stored_base
            access_key = stored.access_key
        preview_provider = stored.provider or payload.provider or "custom"
    if not base_url:
        raise HTTPException(422, "缺少 API 请求地址（base_url）")
    if payload.protocol_id:
        return _catalog_preview(payload, preview_provider, base_url, access_key)

    from character_workflow.lib import llm_protocols
    from character_workflow.lib.llm_protocols import anthropic, detect, gemini

    text_protocol = payload.text_protocol if "text_protocol" in payload.model_fields_set else (
        stored.text_protocol if payload.alias else None)
    # 自定义供应商选「自动」时先看地址：地址能定成 Anthropic / Gemini 的，直接按那种格式列模型。
    auto = text_protocol is None and preview_provider == "custom"
    by_address = detect.from_address(base_url) if auto else None
    listing_protocol = text_protocol or (
        by_address if by_address in (llm_protocols.ANTHROPIC_MESSAGES, llm_protocols.GEMINI_GENERATE_CONTENT)
        else None)
    anthropic_listing = listing_protocol == llm_protocols.ANTHROPIC_MESSAGES
    gemini_listing = listing_protocol == llm_protocols.GEMINI_GENERATE_CONTENT
    detected: dict | None = None
    if anthropic_listing:
        # Anthropic 默认一页 20 条；带着密钥的请求不跟随重定向，不把密钥带到别的主机。
        rows = _fetch_model_rows(f"{anthropic.models_url(base_url)}?limit=1000",
                                 anthropic.headers(base_url, access_key), follow_redirects=False)
    elif gemini_listing:
        # Gemini 一页最多 1000 条（官方默认 50）；同样不跟随重定向。
        rows = _gemini_model_rows(_fetch_model_rows(
            f"{gemini.models_url(base_url)}?pageSize=1000", gemini.headers(access_key),
            follow_redirects=False, rows_key="models"))
    elif auto:
        rows, family, default = _detect_listing(base_url, access_key, preview_provider)
        anthropic_listing = family == "anthropic"
        gemini_listing = family == "gemini"
        detected = {"protocol": default, "family": family,
                    "label": _new_api_label(base_url) if family == "new-api" else None}
    else:
        url = _model_list_url(base_url, preview_provider)
        headers = {"Authorization": f"Bearer {access_key}"} if access_key else {}
        rows = _fetch_model_rows(url, headers)
    if auto and detected is None:
        detected = {"protocol": listing_protocol, "family": "address", "label": None}

    from character_workflow.lib.callers.video_registry import resolve_protocol

    models = []
    seen_ids: set[str] = set()
    excluded = 0
    total = 0
    evolink = preview_provider == "evolink"
    for item in rows:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        mid = str(item["id"])
        if mid in seen_ids:  # 聚合商常给同一模型挂多个别名条目
            continue
        seen_ids.add(mid)
        total += 1
        # EvoLink shares /models across many endpoint contracts. Only the implemented
        # base model belongs in the generator; derivative IDs are internal edit actions.
        evolink_video = evolink and _is_evolink_kling_entry(mid)
        if evolink and mid != "mj-v8.2" and not evolink_video:
            excluded += 1
            continue
        category = ("video" if evolink_video else "image") if evolink else _classify_model(item)
        # 明确不能生成内容的模型不入列表；include_all 是逃生舱：
        # deny 词表哪天判过头了，画师能自己看到全量，不至于变成死路。
        if category == "excluded" and not payload.include_all:
            excluded += 1
            continue
        modality = category if category in ("text", "image", "video", "audio") else None
        # 视频：协议 guess（resolve 不中 → None，交后端 dispatch 时判定 / 诚实报错）。
        # 图片：直接读上游协议标注（决定走 Ark 原生端点还是 OpenAI 兼容入口）。
        if evolink:
            protocol = "evolink"
        elif modality == "video":
            protocol = resolve_protocol(preview_provider, base_url, mid)
        elif modality == "image":
            protocol = _image_protocol(item)
        elif modality == "text":
            # New API 逐模型按 supported_endpoint_types 定（两种都有取 Chat）；TokenDance 按 supported_protocols。
            protocol = (llm_protocols.ANTHROPIC_MESSAGES if anthropic_listing
                        else llm_protocols.GEMINI_GENERATE_CONTENT if gemini_listing
                        else detect.endpoint_protocol(item.get("supported_endpoint_types"))
                        or _text_protocol(item))
        elif modality == "audio":
            protocol = _audio_protocol(item)
        else:
            protocol = _declared_unknown_protocol(item)
        models.append({
            "id": mid,
            "name": str(item.get("name") or mid),
            "modality": modality,
            # unknown 与 excluded 都要能被前端区分：前者是「需要你确认」，不是「其他垃圾」。
            "category": category,
            "protocol": protocol,
            "input_modalities": _model_input_modalities(item),
        })
    result = {"models": models, "total": total, "excluded": excluded}
    if detected is not None:
        result["detected"] = detected
    return result


def _catalog_preview(payload: _ModelsPreviewPayload, provider: str, base_url: str,
                     access_key: str) -> dict:
    """按模板 catalog 发现模型：只发一次目录 GET；分类以模板 kind.map 为准，未命中走现有规则。

    发现不代表可用，前端据 `discovered` 标明；启用时分类与模板 kind 一致的行由前端绑定该模板。
    目录里的价格字段不读。
    """
    from character_workflow.lib import http_protocol_catalog, http_protocols

    if provider != "custom":
        raise HTTPException(400, "只有自定义供应商可以按自定义接口发现模型")
    try:
        protocol = http_protocols.read_protocol(payload.protocol_id or "")
    except http_protocols.ProtocolUnavailableError as error:
        raise HTTPException(422, str(error)) from None
    if protocol.catalog is None:
        raise HTTPException(422, f"自定义接口「{protocol.name}」没有填写模型目录（catalog）")
    try:
        found = http_protocol_catalog.fetch_catalog(base_url, access_key, protocol)
    except http_protocol_catalog.CatalogError as error:
        raise HTTPException(502, str(error)) from None
    models = []
    excluded = 0
    for entry in found:
        category = entry.kind or _classify_model({**entry.item, "id": entry.id})
        if category == "excluded" and not payload.include_all:
            excluded += 1
            continue
        modality = category if category in ("text", "image", "video", "audio") else None
        models.append({
            "id": entry.id,
            "name": entry.name,
            "modality": modality,
            "category": category,
            # 绑定在前端「启用所选」时按最终分类做（未识别行要等用户指定），这里不猜内置协议。
            "protocol": None,
            "input_modalities": _model_input_modalities(entry.item),
        })
    return {"models": models, "total": len(found), "excluded": excluded, "discovered": True}


_GALLERY_SLOTS = ("portrait", "promo", "turnaround")
_GALLERY_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


@router.get("/gallery/recent")
def gallery_recent(limit: int = Query(default=24, ge=1, le=100)) -> dict:
    """Return random character images from portrait/promo/turnaround.

    Studio 只混入已完成任务登记的图片产物。
    show_canvas_on_home（默认开）时混入画布上正在显示、没打码的生成图。
    """
    items: list[dict] = []
    hidden_paths, hidden_canvas_ids = _read_gallery_hidden_state()
    hidden = set(hidden_paths)
    hidden_canvases = set(hidden_canvas_ids)
    studio_dir = _project_root() / "studio"
    if studio_dir.exists():
        studio_root = studio_dir.resolve()
        seen_studio_paths: set[str] = set()
        # 文件存在不代表生成成功：目录里可能留下测试图或落盘后未完成登记的产物。
        # PARTIAL 已有成功结果，不能因为同批其他图片失败就把它们一起隐藏。
        for job in list_jobs():
            if (
                job.namespace != "studio"
                or job.kind != JobKind.IMAGE
                or job.status not in (JobStatus.DONE, JobStatus.PARTIAL)
            ):
                continue
            for raw_path in job.output_paths:
                try:
                    f = Path(raw_path)
                    f = (f if f.is_absolute() else _project_root() / f).resolve()
                    if not f.is_relative_to(studio_root) or not f.is_file():
                        continue
                    if f.suffix.lower() not in _GALLERY_EXTS:
                        continue
                    rel = f.relative_to(_project_root()).as_posix()
                    if rel in hidden or rel in seen_studio_paths:
                        continue
                    mtime = f.stat().st_mtime
                except (OSError, ValueError, RuntimeError):
                    continue
                seen_studio_paths.add(rel)
                items.append({
                    "character_id": None,
                    "project_id": None,
                    "asset_slot": None,
                    "source": "studio",
                    "filename": f.name,
                    "path": rel,
                    "job_id": job.job_id,
                    "mtime": mtime,
                })
    from character_workflow.lib.canvas_projects import list_canvas_gallery_images
    show_canvas = bool(_read_config().get("show_canvas_on_home", True))
    for canvas_project_id, canvas_job_id, canvas_node_id, f in (
            list_canvas_gallery_images() if show_canvas else []):
        if canvas_project_id in hidden_canvases:
            continue
        try:
            if f.suffix.lower() not in _GALLERY_EXTS:
                continue
            rel = f.relative_to(_project_root().resolve()).as_posix()
            if rel in hidden:
                continue
            mtime = f.stat().st_mtime
        except (OSError, ValueError):
            continue
        items.append({
            "character_id": None,
            "project_id": None,
            "asset_slot": None,
            "source": "canvas",
            "canvas_project_id": canvas_project_id,
            "canvas_node_id": canvas_node_id,
            "filename": f.name,
            "path": rel,
            "job_id": canvas_job_id,
            "mtime": mtime,
        })
    favorites = set(_read_gallery_favorites())
    ratings = _read_gallery_ratings()
    for it in items:
        it["rating"] = ratings.get(it["path"], 0.0)
    # 先随机，作为「同喜欢状态 + 同分」层内的 tiebreak；再按 (喜欢, 评分) 降序稳定排序。
    random.shuffle(items)
    items.sort(key=lambda it: (it["path"] in favorites, it["rating"]), reverse=True)
    return {"items": items[:limit]}




def _gallery_hidden_file() -> Path:
    return _runtime() / "gallery-hidden.json"


def _read_gallery_hidden_state() -> tuple[list[str], list[str]]:
    path = data_root.runtime_dir() / "gallery-hidden.json"
    if not path.is_file():
        return [], []
    try:
        payload = json.loads(read_text_with_retry(path))
    except (OSError, json.JSONDecodeError):
        return [], []
    if not isinstance(payload, dict):
        return [], []
    raw_paths = payload.get("paths")
    raw_canvases = payload.get("canvas_project_ids")
    paths = [v for v in raw_paths if isinstance(v, str)] if isinstance(raw_paths, list) else []
    canvases = [v for v in raw_canvases if isinstance(v, str)] if isinstance(raw_canvases, list) else []
    return paths, canvases


def _normalize_gallery_path(raw: str) -> str:
    """归一为 data_root 相对路径——job.output_paths 是绝对路径、recent 项是相对路径，
    sidecar 统一存相对形态两边才能对上（与 _gallery_job_ids_by_path 同规）。"""
    root = _project_root()
    path = Path(raw)
    absolute = path if path.is_absolute() else root / path
    try:
        return absolute.resolve().relative_to(root).as_posix()
    except ValueError:
        return raw


class _GalleryHiddenPatch(BaseModel):
    model_config = {"extra": "forbid"}
    path: str | None = Field(default=None, min_length=1)
    canvas_project_id: str | None = Field(default=None, min_length=1)
    hidden: bool


@router.get("/gallery/hidden")
def gallery_hidden() -> dict:
    paths, canvas_project_ids = _read_gallery_hidden_state()
    return {"paths": paths, "canvas_project_ids": canvas_project_ids}


@router.post("/gallery/hidden")
def post_gallery_hidden(patch: _GalleryHiddenPatch) -> dict:
    if (patch.path is None) == (patch.canvas_project_id is None):
        raise HTTPException(status_code=422, detail="必须提供 path 或 canvas_project_id 中的一项")
    # 读→改→写持锁：读失败按空处理时，不持锁的并发写会把整份列表覆盖成空。叶子锁，内部不取别的锁。
    with file_lock(_gallery_hidden_file().with_suffix(".lock")):
        paths, canvas_project_ids = _read_gallery_hidden_state()
        if patch.path is not None:
            target = _normalize_gallery_path(patch.path)
            paths = [p for p in paths if p != target]
            if patch.hidden:
                paths.append(target)
        elif patch.canvas_project_id is not None:
            project_id = patch.canvas_project_id.strip()
            canvas_project_ids = [cid for cid in canvas_project_ids if cid != project_id]
            if patch.hidden and project_id:
                canvas_project_ids.append(project_id)
        data: dict[str, list[str]] = {"paths": paths}
        if canvas_project_ids:
            data["canvas_project_ids"] = canvas_project_ids
        atomic_write_json(_gallery_hidden_file(), data)
    return {"paths": paths, "canvas_project_ids": canvas_project_ids}


def _gallery_favorites_file() -> Path:
    return _runtime() / "gallery-favorites.json"


def _read_gallery_favorites() -> list[str]:
    p = _gallery_favorites_file()
    if not p.exists():
        return []
    try:
        data = json.loads(read_text_with_retry(p))
    except (OSError, json.JSONDecodeError):
        return []
    paths = data.get("paths") if isinstance(data, dict) else None
    if not isinstance(paths, list):
        return []
    return [x for x in paths if isinstance(x, str)]


class _GalleryFavoritePatch(BaseModel):
    model_config = {"extra": "forbid"}
    path: str = Field(min_length=1)
    favorite: bool


@router.get("/gallery/favorites")
def gallery_favorites() -> dict:
    return {"paths": _read_gallery_favorites()}


@router.post("/gallery/favorites")
def post_gallery_favorites(patch: _GalleryFavoritePatch) -> dict:
    target = _normalize_gallery_path(patch.path)
    with file_lock(_gallery_favorites_file().with_suffix(".lock")):
        paths = [p for p in _read_gallery_favorites() if p != target]
        if patch.favorite:
            paths.append(target)
        atomic_write_json(_gallery_favorites_file(), {"paths": paths})
    return {"paths": paths}


def _gallery_ratings_file() -> Path:
    return _runtime() / "gallery-ratings.json"


def _read_gallery_ratings() -> dict[str, float]:
    p = _gallery_ratings_file()
    if not p.exists():
        return {}
    try:
        data = json.loads(read_text_with_retry(p))
    except (OSError, json.JSONDecodeError):
        return {}
    ratings = data.get("ratings") if isinstance(data, dict) else None
    if not isinstance(ratings, dict):
        return {}
    out: dict[str, float] = {}
    for k, v in ratings.items():
        if isinstance(k, str) and isinstance(v, (int, float)) and 0 < float(v) <= 5:
            out[k] = float(v)
    return out


class _GalleryRatingPatch(BaseModel):
    model_config = {"extra": "forbid"}
    path: str = Field(min_length=1)
    rating: float = Field(ge=0, le=5)

    @field_validator("rating")
    @classmethod
    def _half_step(cls, v: float) -> float:
        if (v * 2) % 1 != 0:
            raise ValueError("rating 必须是 0.5 的整数倍")
        return v


@router.get("/gallery/ratings")
def gallery_ratings() -> dict:
    return {"ratings": _read_gallery_ratings()}


@router.post("/gallery/ratings")
def post_gallery_ratings(patch: _GalleryRatingPatch) -> dict:
    target = _normalize_gallery_path(patch.path)
    with file_lock(_gallery_ratings_file().with_suffix(".lock")):
        ratings = _read_gallery_ratings()
        if patch.rating == 0:
            ratings.pop(target, None)
        else:
            ratings[target] = patch.rating
        atomic_write_json(_gallery_ratings_file(), {"ratings": ratings})
    return {"ratings": ratings}




@router.get("/gallery/image")
def gallery_image(path: str) -> FileResponse:
    """Serve gallery media from the explicit asset roots. Reject traversal."""
    root = _project_root()
    target = (root / path).resolve()
    studio_dir = (root / "studio").resolve()
    # 画布只放行生成产物目录下的图片：canvases/<project>/outputs/**。上传的素材不从这里读。
    canvases_dir = data_root.canvases_dir().resolve()
    canvas_parts = target.relative_to(canvases_dir).parts if target.is_relative_to(canvases_dir) else ()
    in_canvas_outputs = (
        len(canvas_parts) >= 3
        and canvas_parts[1] == "outputs"
        and target.suffix.lower() in _GALLERY_EXTS
    )
    if not (
        target.is_relative_to(studio_dir)
        or in_canvas_outputs
    ):
        raise HTTPException(status_code=400, detail="path outside allowed roots")
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)


_STUDIO_REQUEST_ID_PATTERN = r"^\d{14}[0-9a-f]{8}$"


def _studio_request_job_id(request_id: str) -> str:
    """客户端请求 ID → 任务 ID。形状与 `new_job_id()` 一致，按 ID 直接核对，不另建索引。"""
    return f"job-{request_id}"


def _studio_job_for_request(request_id: str) -> Job | None:
    """这个请求 ID 已经建过的创作台任务；没有返回 None。"""
    try:
        job = read_job(_studio_request_job_id(request_id))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, ValidationError) as error:
        raise HTTPException(409, detail="这次提交对应的任务记录读不出来") from error
    if job.namespace != "studio":
        raise HTTPException(409, detail="请求 ID 已被别的任务占用")
    return job


class _StudioJobCreate(BaseModel):
    model_config = {"extra": "forbid"}
    prompt: str
    prompt_template: str | None = Field(default=None, max_length=40_000)
    model: str
    params: JobParams
    alias: str | None = None
    kind: JobKind = JobKind.IMAGE
    studio_agent_session_id: CanvasAgentSessionId | None = None
    # 「再次生成」来自哪个失败轮次：网关未确认的失败在 20 小时内、请求不变时接回主机上的原任务。
    reattach_job_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,200}$")
    # 客户端请求 ID（一次提交意图一个，重试沿用）：同 ID 只建一个任务，回包丢了重发拿回原任务。
    client_request_id: str | None = Field(default=None, pattern=_STUDIO_REQUEST_ID_PATTERN)


def _create_user_job(
    body: _StudioJobCreate,
    *,
    namespace: Literal["studio"],
    job_id: str | None = None,
    studio_agent_session_id: str | None = None,
    studio_agent_turn_id: str | None = None,
) -> Job:
    """Build and persist one Web-confirmed Studio job."""
    from character_workflow.lib.prompt_variables import resolve_prompt_variables

    try:
        prompt = (
            resolve_prompt_variables(body.prompt_template)
            if body.prompt_template is not None else body.prompt
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if body.kind not in {JobKind.IMAGE, JobKind.VIDEO}:
        raise HTTPException(422, detail="创作台目前只接受图片或视频任务")
    params = body.params.model_copy(deep=True)
    # Provider task handles are runner-owned.  A Studio create request always represents a new
    # order and may not attach itself to an arbitrary existing Tuzi task.
    params.provider_task_protocol = None
    params.provider_task_ids = None
    params.video_submission_attempts = None
    params.mask_image = None
    params.markup_image = None
    params.image_edit = None
    params.mj_submission_ids = None
    params.mj_submit_uncertain = None
    params.evolink_state = None
    params.comfyui_resume = None
    params.edit_inputs = None
    params.edit_prompt = None
    params.gateway_idempotency_key = None
    params.gateway_request_fingerprint = None
    params.gateway_unconfirmed = None
    params.gateway_reattach_of = None
    params.gateway_cancel_pending = None
    params.gateway_settlement = None
    params.gateway_charged_on = None
    # 改写值与原值同类型（str / list[str]），model_copy 不需要重新校验。
    params = params.model_copy(update=_gate_browser_refs(params.model_dump()))
    route_order: list[str] = []
    if body.alias:
        key_row = keys.find_by_alias(body.alias)
        if not key_row:
            raise HTTPException(status_code=400, detail=f"unknown alias {body.alias}")
        if not key_row.enabled:
            raise HTTPException(status_code=422, detail="供应商已停用")
        model_id = body.model
    else:
        # 不指定厂商 =「自动」：body.model 是路由 id，按组内顺序解析出实际 KEY 与模型。
        try:
            key_row, model_spec = model_routes.resolve_auto(
                body.kind.value, body.model, params=params.model_dump(exclude_none=True),
                route_order=route_order,
            )
        except (model_routes.NoSuchRouteError, model_routes.InsufficientBalanceError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        model_id = model_spec.id
    alias = key_row.alias
    if body.reattach_job_id and key_row.provider == "atelier":
        from character_workflow.lib.jobs import gateway_reattach_params

        try:
            source = read_job(body.reattach_job_id)
        except (OSError, ValueError, ValidationError):
            source = None  # 原轮次已删或读不出：按新单处理
        if source is not None and source.namespace == "studio":
            params = params.model_copy(update=gateway_reattach_params(source, alias))
    model_spec = next((m for m in key_row.models if m.id == model_id), None)
    if model_spec is not None and model_spec.workflow_inputs is not None:
        from character_workflow.lib.comfyui_workflows import validate_values

        try:
            validate_values(model_spec.workflow_inputs, params.workflow_inputs or {})
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    if not prompt.strip() and not (
        model_spec is not None and model_spec.workflow_inputs is not None
        and not any(item.type == "prompt" for item in model_spec.workflow_inputs)
    ):
        raise HTTPException(status_code=422, detail="生成提示词不能为空")
    # 「自动」记下路由 id，运行时遇到确定没执行的失败才能换下一家；指定厂商不换。
    params.route_id = None if body.alias else body.model
    params.route_tried = None
    params.route_order = route_order or None
    if body.kind == JobKind.IMAGE:
        from character_workflow.lib.image_size import normalize_image_size_params

        try:
            params = JobParams(**normalize_image_size_params(
                key_row, model_id, params.model_dump(exclude_none=True),
            ))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        image_count = params.n if params.n is not None else 1
        if image_count < 1 or image_count > 4:
            raise HTTPException(status_code=422, detail="params.n must be between 1 and 4")
        params.n = image_count

    job = Job(
        job_id=job_id or new_job_id(),
        studio_agent_session_id=studio_agent_session_id,
        studio_agent_turn_id=studio_agent_turn_id,
        character_id=alias,
        prompt=prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=model_id,
        params=params,
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        kind=body.kind,
        namespace=namespace,
        alias=alias,
        provider=key_row.provider,
    )
    return save_job(job)


@router.get("/canvas/projects", response_model=CanvasProjectList)
def get_canvas_projects() -> CanvasProjectList:
    from character_workflow.lib.canvas_packages import recover_canvas_package_transactions
    from character_workflow.lib.canvas_projects import list_canvas_projects
    recover_canvas_package_transactions()
    return CanvasProjectList(projects=list_canvas_projects())


@router.get("/canvas/project-options", response_model=list[CanvasProject])
def get_canvas_project_options() -> list[CanvasProject]:
    from character_workflow.lib.canvas_packages import recover_canvas_package_transactions
    from character_workflow.lib.canvas_projects import list_canvas_project_options
    recover_canvas_package_transactions()
    return list_canvas_project_options()


@router.get("/canvas/ui-preferences", response_model=CanvasUiPreferences)
def get_canvas_ui_preferences() -> CanvasUiPreferences:
    from character_workflow.lib.canvas_ui import (
        CanvasUiPreferencesError,
        read_canvas_ui_preferences,
    )
    try:
        return read_canvas_ui_preferences()
    except CanvasUiPreferencesError as error:
        raise HTTPException(409, detail=str(error)) from error


@router.put("/canvas/ui-preferences", response_model=CanvasUiPreferences)
def put_canvas_ui_preferences(payload: CanvasUiPreferencesUpdate) -> CanvasUiPreferences:
    from character_workflow.lib.canvas_ui import (
        CanvasUiPreferencesError,
        CanvasUiRevisionConflict,
        save_canvas_ui_preferences,
    )
    try:
        return save_canvas_ui_preferences(payload)
    except CanvasUiRevisionConflict as error:
        raise HTTPException(409, detail={
            "code": "revision_conflict",
            "current_revision": error.current_revision,
        }) from error
    except CanvasUiPreferencesError as error:
        raise HTTPException(409, detail=str(error)) from error


@router.get("/accent-themes", response_model=AccentThemes)
def get_accent_themes() -> AccentThemes:
    from character_workflow.lib.accent_themes import AccentThemesError, read_accent_themes
    try:
        return read_accent_themes()
    except AccentThemesError as error:
        raise HTTPException(500, detail=str(error)) from error


@router.put("/accent-themes", response_model=AccentThemes)
def put_accent_themes(payload: AccentThemesUpdate) -> AccentThemes:
    from character_workflow.lib.accent_themes import (
        AccentThemesError,
        AccentThemesRevisionConflict,
        save_accent_themes,
    )
    try:
        return save_accent_themes(payload)
    except AccentThemesRevisionConflict as error:
        raise HTTPException(409, detail={
            "code": "revision_conflict",
            "message": "主题已在别处修改",
            "current_revision": error.current_revision,
        }) from error
    except AccentThemesError as error:
        raise HTTPException(500, detail=str(error)) from error


@router.post("/canvas/projects", response_model=CanvasProject, status_code=201)
def post_canvas_project(payload: CanvasProjectCreate) -> CanvasProject:
    from character_workflow.lib.canvas_projects import create_canvas_project
    return create_canvas_project(payload.name)


@router.patch("/canvas/projects/{project_id}", response_model=CanvasProject)
def patch_canvas_project(project_id: str, payload: CanvasProjectRename) -> CanvasProject:
    from character_workflow.lib.canvas_projects import rename_canvas_project
    try:
        return rename_canvas_project(project_id, payload.name)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None


@router.post("/canvas/projects/export")
def post_canvas_projects_export(payload: CanvasProjectExportRequest) -> FileResponse:
    from character_workflow.lib.canvas_packages import (
        CanvasPackageError,
        CanvasProjectBusyError,
        export_canvas_projects,
    )
    try:
        target, filename = export_canvas_projects(payload.project_ids)
    except KeyError:
        raise HTTPException(404, detail="找不到要导出的画布项目") from None
    except CanvasProjectBusyError as error:
        raise HTTPException(409, detail=str(error)) from error
    except CanvasPackageError as error:
        raise HTTPException(422, detail=str(error)) from error
    return FileResponse(
        target,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(target.unlink, missing_ok=True),
    )


@router.post("/canvas/projects/import/inspect")
async def post_canvas_project_import_inspect(file: UploadFile = File(...)) -> dict:
    from character_workflow.lib.canvas_packages import (
        CanvasPackageError,
        CanvasProjectBusyError,
        inspect_canvas_package,
    )
    raw_name = file.filename or "canvas-package.zip"
    if Path(raw_name).suffix.lower() != ".zip":
        raise HTTPException(422, detail="请选择 .zip 格式的 Canvas 项目包")
    upload_root = data_root.runtime_dir() / "canvas-import-uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    target = upload_root / f"upload-{uuid.uuid4().hex}.zip"
    total = 0
    try:
        # 落盘和解包都是同步阻塞的，而这条路由必须是 async（要 await 分块读上传流）。
        # 直接在协程里做，2 GiB 的写入加整包扫描会把事件循环连同 SSE 一起冻住；
        # inspect_canvas_package 还会去抢画布文件锁，Skill 进程持锁时是无限期阻塞。
        with target.open("wb") as output:
            while chunk := await file.read(8 * 1024 * 1024):
                total += len(chunk)
                if total > 2 * 1024 * 1024 * 1024:
                    raise HTTPException(413, detail="Canvas 项目包不能超过 2 GiB")
                await run_in_threadpool(output.write, chunk)
        result = await run_in_threadpool(inspect_canvas_package, target)
        return result.model_dump(mode="json")
    except CanvasProjectBusyError as error:
        raise HTTPException(409, detail=str(error)) from error
    except CanvasPackageError as error:
        raise HTTPException(422, detail=str(error)) from error
    finally:
        target.unlink(missing_ok=True)


@router.post("/canvas/projects/import/commit", response_model=CanvasPackageImportResponse)
def post_canvas_project_import_commit(
    payload: CanvasPackageCommitRequest,
) -> CanvasPackageImportResponse:
    from character_workflow.lib.canvas_packages import CanvasPackageError, commit_canvas_package
    try:
        return CanvasPackageImportResponse(projects=commit_canvas_package(payload.token))
    except KeyError:
        raise HTTPException(404, detail="导入校验记录不存在，请重新选择项目包") from None
    except TimeoutError:
        raise HTTPException(410, detail="导入校验已过期，请重新选择项目包") from None
    except CanvasPackageError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.delete("/canvas/projects/{project_id}")
def delete_canvas_project_route(
    project_id: str,
    payload: CanvasProjectDeleteRequest,
    if_empty: bool = False,
) -> dict[str, str | bool]:
    """删除项目进回收站；`if_empty=true` 时只清掉确实为空的项目（新建后什么都没做就离开），不进回收站。"""
    from character_workflow.lib.canvas_packages import (
        CanvasPackageError,
        CanvasProjectBusyError,
        delete_canvas_project,
        discard_empty_canvas_project,
    )
    if if_empty:
        # 资格（版本、元数据、设置、内容、Agent 会话）由服务端核验；读不准的一律保留。
        try:
            return {"discarded": discard_empty_canvas_project(project_id, payload.expected_revision)}
        except (KeyError, OSError, ValueError):
            return {"discarded": False}
    try:
        trash_id = delete_canvas_project(project_id, payload.expected_revision)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    except CanvasProjectBusyError as error:
        raise HTTPException(409, detail=str(error)) from error
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            current_revision = int(str(error).split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        raise
    except CanvasPackageError as error:
        raise HTTPException(422, detail=str(error)) from error
    # 删画布时挂载记录已随之清掉；已无任何挂载的库停止监听，还有挂载的对齐到剩下那条。
    from viewer_server.watcher import sync_team_library_watches

    sync_team_library_watches()
    return {"trash_id": trash_id}


@router.get("/canvas/projects/{project_id}/document", response_model=CanvasDocument)
def get_canvas_document(project_id: str, response: Response) -> CanvasDocument:
    from character_workflow.lib.canvas_projects import read_canvas_document
    try:
        document = read_canvas_document(project_id)
        response.headers["ETag"] = f'"{document.revision}"'
        return document
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    except ValueError as error:
        raise _canvas_document_http_error(error) from error


@router.put("/canvas/projects/{project_id}/document", response_model=CanvasDocument)
def put_canvas_document(
    project_id: str,
    payload: CanvasDocument,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> CanvasDocument:
    from character_workflow.lib.canvas_projects import save_canvas_document
    if if_match is None:
        raise HTTPException(428, detail="保存画布必须携带 If-Match revision")
    try:
        expected_revision = int(if_match.strip().strip('"'))
    except ValueError:
        raise HTTPException(422, detail="If-Match 必须是画布 revision") from None
    try:
        document = save_canvas_document(project_id, payload, expected_revision)
        response.headers["ETag"] = f'"{document.revision}"'
        return document
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            current_revision = int(str(error).split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        raise
    except ValueError as error:
        raise _canvas_document_http_error(error) from error


def _canvas_document_http_error(error: ValueError) -> HTTPException:
    """把画布库的结构化错误翻成 HTTP 状态。

    关键的一条：`CanvasStorageError`（存档文件不见了 / 记着别的项目 ID）是**服务端**数据
    完整性故障，必须 500，不能是 409。409 在前端的文案是「刷新后重试」，而对着一个不存在的
    canvas.json 重试永远不会成功——原来 GET document 就是 409，画师只会一直刷。
    """
    from character_workflow.lib.canvas_projects import CanvasDocumentError, CanvasStorageError
    if isinstance(error, CanvasStorageError):
        logger.warning("canvas storage integrity failure: %s", error.code)
        return HTTPException(500, detail={"code": error.code, "message": error.message})
    if isinstance(error, CanvasDocumentError):
        return HTTPException(422, detail={"code": error.code, "message": error.message})
    return HTTPException(422, detail=str(error))


def _canvas_if_match(if_match: str | None, subject: str) -> int:
    if if_match is None:
        raise HTTPException(428, detail=f"更新{subject}必须携带 If-Match revision")
    try:
        return int(if_match.strip().strip('"'))
    except ValueError:
        raise HTTPException(422, detail=f"If-Match 必须是{subject} revision") from None


def _raise_canvas_agent_session_error(error: Exception) -> None:
    from character_workflow.lib.canvas_agent_sessions import CanvasAgentSessionStateError
    if isinstance(error, CanvasAgentSessionStateError):
        raise HTTPException(
            409,
            detail="Agent 会话状态损坏，该文件已隔离；请从项目包恢复",
        ) from error
    if isinstance(error, KeyError):
        raise HTTPException(404, detail="找不到这个画布项目或 Agent 会话") from None
    if isinstance(error, RuntimeError) and str(error).startswith("revision_conflict:"):
        current_revision = int(str(error).split(":", 1)[1])
        raise HTTPException(409, detail={
            "code": "revision_conflict",
            "current_revision": current_revision,
        }) from None
    raise error


@router.get(
    "/canvas/projects/{project_id}/agent/sessions",
    response_model=CanvasAgentSessionList,
)
def get_canvas_agent_sessions(project_id: str) -> CanvasAgentSessionList:
    from character_workflow.lib.canvas_agent_sessions import list_canvas_agent_sessions
    try:
        return list_canvas_agent_sessions(project_id)
    except KeyError as error:
        _raise_canvas_agent_session_error(error)


@router.post(
    "/canvas/projects/{project_id}/agent/sessions",
    response_model=CanvasAgentSession,
    status_code=201,
)
def post_canvas_agent_session(
    project_id: str,
    payload: CanvasAgentSessionCreate,
    response: Response,
) -> CanvasAgentSession:
    from character_workflow.lib.canvas_agent_sessions import create_canvas_agent_session
    try:
        session = create_canvas_agent_session(project_id, payload.title)
        response.headers["ETag"] = f'"{session.revision}"'
        return session
    except KeyError as error:
        _raise_canvas_agent_session_error(error)


@router.get(
    "/canvas/projects/{project_id}/agent/sessions/{session_id}",
    response_model=CanvasAgentSession,
)
def get_canvas_agent_session(
    project_id: str,
    session_id: str,
    response: Response,
) -> CanvasAgentSession:
    from character_workflow.lib.canvas_agent_sessions import (
        public_session, read_canvas_agent_session,
    )
    from viewer_server.canvas_chat_routes import recover_if_stale
    try:
        session = recover_if_stale(read_canvas_agent_session(project_id, session_id))
        response.headers["ETag"] = f'"{session.revision}"'
        return public_session(session)
    except (KeyError, ValueError) as error:
        _raise_canvas_agent_session_error(error)


@router.delete("/canvas/projects/{project_id}/agent/sessions/{session_id}")
def delete_canvas_agent_session_route(
    project_id: str,
    session_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> dict:
    """会话进回收站，返回 trash_id：面板的撤销 toast 用它还原。"""
    from character_workflow.lib.canvas_agent_sessions import delete_canvas_agent_session
    from viewer_server.canvas_chat_routes import cancel
    cancel(project_id, session_id)
    try:
        trash_id = delete_canvas_agent_session(
            project_id,
            session_id,
            _canvas_if_match(if_match, "Agent 会话"),
        )
        return {"trash_id": trash_id}
    except (KeyError, RuntimeError, ValueError) as error:
        _raise_canvas_agent_session_error(error)


def _raise_canvas_revision_error(error: RuntimeError) -> None:
    if isinstance(error, RuntimeError) and str(error).startswith("revision_conflict:"):
        current_revision = int(str(error).split(":", 1)[1])
        raise HTTPException(409, detail={
            "code": "revision_conflict",
            "current_revision": current_revision,
        }) from None
    raise error


def _raise_creation_asset_error(error: Exception) -> None:
    from character_workflow.lib.creation_assets import (
        CreationAssetDuplicateError,
        CreationAssetStateError,
    )
    if isinstance(error, CreationAssetDuplicateError):
        raise HTTPException(409, detail={
            "code": "duplicate_asset",
            "asset_id": error.asset_id,
            "message": str(error),
        }) from None
    if isinstance(error, CreationAssetStateError):
        raise asset_state_broken_error(error) from error
    if isinstance(error, (KeyError, FileNotFoundError)):
        raise HTTPException(404, detail="找不到这个创作资产或文件") from None
    if isinstance(error, ValueError):
        raise HTTPException(422, detail=str(error)) from error
    raise error


@router.get("/canvas/projects/{project_id}/specs")
def get_canvas_specs(project_id: str):
    from character_workflow.lib.canvas_specs import read_specs
    try:
        return read_specs(project_id)
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.put("/canvas/projects/{project_id}/specs/project")
def put_canvas_project_spec(project_id: str, payload: CanvasSpecUpdate):
    return _put_canvas_spec(project_id, payload)


@router.put("/canvas/projects/{project_id}/specs/categories/{name:path}")
def put_canvas_category_spec(project_id: str, name: str, payload: CanvasSpecUpdate):
    return _put_canvas_spec(project_id, payload, name)


def _put_canvas_spec(project_id: str, payload: CanvasSpecUpdate, name: str | None = None):
    from character_workflow.lib.canvas_specs import write_spec
    try:
        write_spec(project_id, payload.text, name)
        return {"saved": True}
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.get("/canvas/projects/{project_id}/lessons")
def get_canvas_lessons(project_id: str):
    from character_workflow.lib.canvas_specs import read_lessons
    try:
        return read_lessons(project_id)
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/canvas/projects/{project_id}/lessons/{index}/adopt")
def adopt_canvas_lesson(project_id: str, index: int):
    return _review_canvas_lesson(project_id, index, True)


@router.delete("/canvas/projects/{project_id}/lessons/{index}")
def delete_canvas_lesson(project_id: str, index: int):
    return _review_canvas_lesson(project_id, index, False)


def _review_canvas_lesson(project_id: str, index: int, adopt: bool):
    from character_workflow.lib.canvas_specs import review_lesson
    try:
        return review_lesson(project_id, index, adopt)
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/canvas/projects/{project_id}/classify", response_model=list[CanvasCategorySuggestion])
def post_canvas_classify(project_id: str, payload: CanvasClassifyRequest):
    from character_workflow.lib.canvas_classification import ClassificationError, classify_assets
    try:
        return classify_assets(project_id, payload)
    except ClassificationError as error:
        raise HTTPException(error.status, detail={"code": error.code, "message": str(error)}) from error
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.put("/canvas/projects/{project_id}/categories", response_model=CanvasProject)
def put_canvas_categories(project_id: str, payload: CanvasCategoriesUpdate):
    from character_workflow.lib.creation_assets import CategoryInUseError, update_canvas_categories
    try:
        return update_canvas_categories(project_id, payload.categories)
    except CategoryInUseError as error:
        raise HTTPException(409, detail={
            "code": "category_in_use", "message": str(error), "usage": error.usage,
            "count": sum(error.usage.values()),
        }) from error
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.patch("/creation-assets/{asset_id}", response_model=CreationAsset)
def patch_creation_asset(asset_id: str, payload: CreationAssetMetadataUpdate):
    from character_workflow.lib.creation_assets import update_creation_asset_category
    try:
        return update_creation_asset_category(asset_id, payload.category)
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.get("/creation-assets", response_model=CreationAssetList)
def get_creation_assets(
    kind: Literal["prompt", "media", "generation"] | None = Query(default=None),
    scope: Literal["all", "project"] = Query(default="all"),
    project_id: str | None = Query(default=None),
    has_category: bool | None = Query(default=None),
    archived: bool = Query(default=False),
):
    from character_workflow.lib.creation_assets import list_creation_assets
    try:
        return list_creation_assets(
            kind=kind,
            scope=scope,
            project_id=project_id,
            has_category=has_category,
            archived=archived,
        )
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/prompts", response_model=CreationAsset, status_code=201)
def post_creation_prompt(payload: CreationPromptAssetCreate):
    from character_workflow.lib.creation_assets import create_prompt_asset
    try:
        return create_prompt_asset(
            payload.title,
            payload.segments,
            payload.tags,
            payload.project_id,
        )
    except ValueError as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/media/from-path", response_model=CreationAsset, status_code=201)
def post_creation_media_from_path(payload: CreationMediaPathCreate):
    from character_workflow.lib.creation_assets import create_media_asset_from_path
    try:
        return create_media_asset_from_path(
            title=payload.title,
            source_path=payload.source_path,
            tags=payload.tags,
            project_id=payload.project_id,
            allow_existing=payload.allow_existing,
            category=payload.category,
        )
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/media/upload", response_model=CreationAsset, status_code=201)
async def post_creation_media_upload(
    file: UploadFile = File(...),
    title: str = Form(...),
    tags: str = Form(default="[]"),
    project_id: str | None = Form(default=None),
    allow_existing: bool = Form(default=False),
):
    from character_workflow.lib.creation_assets import create_media_asset_from_bytes
    try:
        parsed_tags = json.loads(tags)
        if not isinstance(parsed_tags, list) or not all(isinstance(tag, str) for tag in parsed_tags):
            raise ValueError("tags 必须是字符串数组")
        filename = file.filename or "media"
        converted_name, body = await _convert_image_upload(filename, await file.read())
        # 抢 catalog 文件锁 + sha256 + 落盘（视频上限 500 MiB）：留在事件循环里会连 SSE 一起卡住。
        return await asyncio.to_thread(
            create_media_asset_from_bytes,
            title=title,
            body=body,
            filename=converted_name,
            mime_type=_converted_mime(converted_name) if converted_name != filename else file.content_type,
            tags=parsed_tags,
            project_id=project_id,
            allow_existing=allow_existing,
        )
    except (json.JSONDecodeError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


def _save_generation(load_source, *, title: str, tags: list[str], project_id: str | None):
    """生成结果「保存为创作资产」：配方来源与分享共用 generation_recipe，错误按「谁能修」分。

    标题 / 标签在读来源之前单独校验：只有这一步的 ValueError 才是「请求不合规」（422 invalid）。
    之后冒出来的其他 ValueError（坏 job 文件的 JSONDecodeError / ValidationError 等）是本机数据
    故障，不翻译，照常 500 带 traceback。RecipeSourceError / CreationAssetStateError /
    CanvasDocumentError 都是 ValueError 的子类，各自按声明的语义接。
    """
    from character_workflow.lib.canvas_projects import CanvasDocumentError
    from character_workflow.lib.creation_assets import (
        CreationAssetStateError,
        _normalize_tags,
        _required_text,
    )
    from character_workflow.lib.generation_recipe import (
        RecipeSourceError,
        RecipeSourceNotFound,
        save_generation_asset,
    )
    try:
        clean_title, clean_tags = _required_text(title, "资产标题"), _normalize_tags(tags)
    except ValueError as error:
        raise HTTPException(422, detail={"code": "invalid", "message": str(error)}) from error
    try:
        return save_generation_asset(
            load_source(), title=clean_title, tags=clean_tags, project_id=project_id,
        )
    except RecipeSourceError as error:
        raise HTTPException(422, detail={"code": error.code, "message": str(error)}) from error
    except (RecipeSourceNotFound, KeyError):
        raise HTTPException(404, detail="找不到这次生成的记录或画布结果") from None
    except CreationAssetStateError as error:
        raise asset_state_broken_error(error) from error
    except CanvasDocumentError as error:
        # 画布存档不见了 / 记着别的项目（CanvasStorageError）→ 500，不是请求的错。
        raise _canvas_document_http_error(error) from error


# 与 `POST /creation-assets/{asset_id}/<动作>` 段数相同，靠末段字面量区分（from-job / from-canvas
# 不是任何 {asset_id} 路由的动作名）；给 {asset_id} 加新动作时不能取这两个名字。
@router.post(
    "/creation-assets/generation/from-job", response_model=CreationAsset, status_code=201
)
def post_creation_generation_from_job(payload: CreationGenerationFromJob):
    from character_workflow.lib.generation_recipe import recipe_from_job_output
    return _save_generation(
        lambda: recipe_from_job_output(payload.job_id, payload.output_index),
        title=payload.title, tags=payload.tags, project_id=payload.project_id,
    )


@router.post(
    "/creation-assets/generation/from-canvas", response_model=CreationAsset, status_code=201
)
def post_creation_generation_from_canvas(payload: CreationGenerationFromCanvas):
    from character_workflow.lib.generation_recipe import recipe_from_canvas_result
    return _save_generation(
        lambda: recipe_from_canvas_result(
            payload.canvas_project_id, payload.node_id, payload.version_id,
        ),
        title=payload.title, tags=payload.tags, project_id=payload.canvas_project_id,
    )


@router.put("/creation-assets/{asset_id}/prompt", response_model=CreationAsset)
def put_creation_prompt_asset(asset_id: str, payload: CreationPromptAssetUpdate):
    from character_workflow.lib.creation_assets import update_prompt_asset
    try:
        return update_prompt_asset(
            asset_id,
            title=payload.title,
            segments=payload.segments,
            tags=payload.tags,
        )
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.put("/creation-assets/{asset_id}/media", response_model=CreationAsset)
async def put_creation_media_asset(
    asset_id: str,
    title: str = Form(...),
    tags: str = Form(default="[]"),
    file: UploadFile | None = File(default=None),
):
    from character_workflow.lib.creation_assets import update_media_asset_from_bytes
    try:
        parsed_tags = json.loads(tags)
        if not isinstance(parsed_tags, list) or not all(isinstance(tag, str) for tag in parsed_tags):
            raise ValueError("tags 必须是字符串数组")
        filename = (file.filename or "media") if file is not None else "media"
        body: bytes | None = None
        mime_type = file.content_type if file is not None else None
        if file is not None:
            converted_name, body = await _convert_image_upload(filename, await file.read())
            if converted_name != filename:
                filename, mime_type = converted_name, _converted_mime(converted_name)
        return await asyncio.to_thread(
            update_media_asset_from_bytes,
            asset_id,
            title=title,
            tags=parsed_tags,
            body=body,
            filename=filename,
            mime_type=mime_type,
        )
    except (json.JSONDecodeError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


class PromptPreviewOrder(BaseModel):
    files: list[str] = Field(max_length=8)


@router.post("/creation-assets/{asset_id}/previews", response_model=CreationAsset)
async def post_prompt_previews(asset_id: str, files: list[UploadFile] = File(...),
                               replace_file: str | None = Form(default=None)):
    from character_workflow.lib.creation_assets import (
        PROMPT_PREVIEW_MAX_BYTES, add_prompt_previews,
    )
    try:
        if not 1 <= len(files) <= 8:
            raise ValueError("请选择 1–8 张效果图")
        uploads = []
        for file in files:
            body = await file.read(PROMPT_PREVIEW_MAX_BYTES + 1)
            if len(body) > PROMPT_PREVIEW_MAX_BYTES:
                raise ValueError("单张效果图不能超过 20MB")
            uploads.append((body, file.content_type or ""))
        return await asyncio.to_thread(add_prompt_previews, asset_id, uploads, replace_file=replace_file)
    except (KeyError, FileNotFoundError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.put("/creation-assets/{asset_id}/previews/order", response_model=CreationAsset)
def put_prompt_preview_order(asset_id: str, payload: PromptPreviewOrder):
    from character_workflow.lib.creation_assets import reorder_prompt_previews
    try:
        return reorder_prompt_previews(asset_id, payload.files)
    except (KeyError, FileNotFoundError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.delete("/creation-assets/{asset_id}/previews/{file}", response_model=CreationAsset)
def delete_prompt_preview_route(asset_id: str, file: str):
    from character_workflow.lib.creation_assets import delete_prompt_preview
    try:
        return delete_prompt_preview(asset_id, file)
    except (KeyError, FileNotFoundError, ValueError) as error:
        _raise_creation_asset_error(error)


def _prompt_preview_response(asset_id: str, file: str, width: int | None = None):
    from character_workflow.lib.creation_assets import prompt_preview_bytes
    try:
        body, mime = prompt_preview_bytes(asset_id, file, width)
        return Response(body, media_type=mime, headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        })
    except (KeyError, FileNotFoundError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.get("/creation-assets/{asset_id}/previews/{file}")
def get_prompt_preview(asset_id: str, file: str):
    return _prompt_preview_response(asset_id, file)


@router.get("/creation-assets/{asset_id}/previews/{file}/thumb")
def get_prompt_preview_thumb(asset_id: str, file: str, w: int = Query(default=256, ge=1, le=1024)):
    return _prompt_preview_response(asset_id, file, w)


@router.post("/creation-assets/{asset_id}/use", response_model=CreationAsset)
def post_creation_asset_use(asset_id: str, payload: CreationAssetUseRequest):
    from character_workflow.lib.creation_assets import mark_creation_asset_used
    try:
        return mark_creation_asset_used(asset_id, payload.project_id)
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/{asset_id}/archive", status_code=204)
def archive_creation_asset_route(asset_id: str) -> Response:
    """D13：个人资产「删除」改为归档，可在「已归档」里还原。"""
    from character_workflow.lib.creation_assets import set_creation_assets_archived
    try:
        set_creation_assets_archived([asset_id], True)
        return Response(status_code=204)
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/{asset_id}/restore", status_code=204)
def restore_creation_asset_route(asset_id: str) -> Response:
    from character_workflow.lib.creation_assets import set_creation_assets_archived
    try:
        set_creation_assets_archived([asset_id], False)
        return Response(status_code=204)
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.get("/creation-assets/{asset_id}/content")
def get_creation_asset_content(asset_id: str):
    from character_workflow.lib.creation_assets import creation_asset_media_path
    try:
        return FileResponse(creation_asset_media_path(asset_id))
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.get("/creation-assets/{asset_id}/inputs/{order}")
def get_creation_asset_input(asset_id: str, order: int):
    """生成资产快照里第 order 份参考的本体；prompt / media 资产与越界都是 404。"""
    from character_workflow.lib.creation_assets import creation_asset_input_path
    try:
        path, mime_type = creation_asset_input_path(asset_id, order)
        return FileResponse(path, media_type=mime_type)
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post(
    "/canvas/projects/{project_id}/creation-assets/{asset_id}/insert",
    response_model=CanvasDocument,
)
def post_canvas_creation_asset_insert(
    project_id: str,
    asset_id: str,
    payload: CanvasCreationAssetInsertRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    from character_workflow.lib.creation_assets import (
        CreationAssetStateError,
        insert_creation_asset_into_canvas,
    )
    try:
        document = insert_creation_asset_into_canvas(
            project_id=project_id,
            asset_id=asset_id,
            position=payload.position,
            expected_revision=_canvas_if_match(if_match, "画布"),
            variable_values=payload.variable_values,
            target_node_id=payload.target_node_id,
        )
        response.headers["ETag"] = f'"{document.revision}"'
        return document
    except RuntimeError as error:
        _raise_canvas_revision_error(error)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布、节点或创作资产") from None
    # ValueError 子类，必须先于 422：媒体 blob 缺失 / catalog 损坏是本机数据故障，不是请求的错。
    except CreationAssetStateError as error:
        raise asset_state_broken_error(error) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.post(
    "/canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce",
    response_model=CanvasReproduceResponse,
)
def post_canvas_creation_asset_reproduce(
    project_id: str,
    asset_id: str,
    payload: CanvasReproduceRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    """画布复刻：生成资产 → 参考输入节点 + 生成配置节点 + 连线，不自动 Run。"""
    from character_workflow.lib.canvas_reproduce import reproduce_generation_asset_into_canvas
    from character_workflow.lib.creation_assets import CreationAssetStateError
    try:
        document = reproduce_generation_asset_into_canvas(
            project_id=project_id,
            asset_id=asset_id,
            position=payload.position,
            alias=payload.alias,
            model=payload.model,
            document_revision=_canvas_if_match(if_match, "画布"),
        )
        response.headers["ETag"] = f'"{document.revision}"'
        return document
    except RuntimeError as error:
        _raise_canvas_revision_error(error)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布或创作资产") from None
    except CreationAssetStateError as error:
        # 参考 blob 缺失 = 本机数据完整性故障，见 asset_state_broken_error。
        raise asset_state_broken_error(error) from error
    except ValueError as error:
        # 非生成资产、配方拼不出合法草稿（ValidationError 也是 ValueError）→ 422；
        # 画布存档本身坏了（CanvasStorageError）→ 500，见 _canvas_document_http_error。
        raise _canvas_document_http_error(error) from error


@router.post("/canvas/projects/{project_id}/paste", response_model=CanvasDocument)
def post_canvas_paste(
    project_id: str,
    payload: CanvasPasteRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    """跨画布粘贴：复制源画布的媒体进目标画布，改写节点里的版本引用后落节点与连线。"""
    from character_workflow.lib.canvas_paste import paste_nodes_into_canvas
    try:
        document = paste_nodes_into_canvas(
            project_id=project_id,
            source_project_id=payload.source_project_id,
            nodes=payload.nodes,
            connections=payload.connections,
            document_revision=_canvas_if_match(if_match, "画布"),
        )
        response.headers["ETag"] = f'"{document.revision}"'
        return document
    except RuntimeError as error:
        _raise_canvas_revision_error(error)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, detail="找不到源画布或它的媒体文件") from None
    except PermissionError as error:
        raise HTTPException(422, detail=str(error)) from error
    except ValueError as error:
        raise _canvas_document_http_error(error) from error


@router.post(
    "/canvas/projects/{project_id}/uploads",
    response_model=CanvasUploadResponse,
    status_code=201,
)
async def post_canvas_upload(
    project_id: str,
    file: UploadFile = File(...),
    expected_revision: int = Form(...),
) -> CanvasUploadResponse:
    from character_workflow.lib.canvas_projects import save_canvas_upload
    raw_name, ext, body, media_kind = await _read_media_upload(file)
    try:
        # 这条路由必须是 async（要 await 读上传流），但落盘的这一段是同步的：解码媒体、抢画布
        # 文件锁、写文档。Skill 进程持锁时锁等待没有上限，直接在协程里做等于整个事件循环停摆
        # （SSE 一起断）。同文件的 media-operations 路由用的就是这个写法。
        version, document, filename = await run_in_threadpool(
            save_canvas_upload,
            project_id, raw_name, ext, body, media_kind, expected_revision,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            current_revision = int(str(error).split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        raise
    except ValueError as error:
        raise _canvas_document_http_error(error) from error
    return CanvasUploadResponse(version=version, filename=filename, document=document)


@router.post(
    "/canvas/projects/{project_id}/nodes/{node_id}/replace",
    response_model=CanvasUploadResponse,
    status_code=201,
)
async def post_canvas_node_media_replace(
    project_id: str,
    node_id: str,
    file: UploadFile = File(...),
    expected_revision: int = Form(...),
) -> CanvasUploadResponse:
    from character_workflow.lib.canvas_projects import (
        CanvasMediaReplaceError,
        replace_canvas_node_media,
    )

    raw_name, ext, body, media_kind = await _read_media_upload(file, "replacement")
    try:
        version, document, filename = await run_in_threadpool(
            replace_canvas_node_media,
            project_id,
            node_id,
            raw_name,
            ext,
            body,
            media_kind,
            expected_revision,
        )
    except CanvasMediaReplaceError as error:
        status = 404 if error.code == "canvas_media_node_missing" else 422
        raise HTTPException(
            status,
            detail={"code": error.code, "message": error.message},
        ) from error
    except KeyError:
        raise HTTPException(404, detail={
            "code": "canvas_media_node_missing",
            "message": "找不到这个画布项目或媒体节点。",
        }) from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            current_revision = int(str(error).split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "canvas_media_revision_conflict",
                "message": "画布已在别处更新，请刷新后重试。",
                "current_revision": current_revision,
            }) from None
        raise
    except ValueError as error:
        raise HTTPException(422, detail={
            "code": "canvas_media_decode_failed",
            "message": "文件内容与扩展名不匹配，或媒体格式无法识别。",
        }) from error
    return CanvasUploadResponse(version=version, filename=filename, document=document)


@router.post(
    "/canvas/projects/{project_id}/media-operations",
    response_model=CanvasMediaOperationResponse,
    status_code=201,
)
async def post_canvas_media_operation(
    project_id: str,
    payload: Any = Body(default=None),
) -> CanvasMediaOperationResponse:
    from character_workflow.lib.canvas_media_operations import (
        CanvasMediaOperationError,
        execute_canvas_media_operation,
    )
    from character_workflow.lib.matting import MattingModelMissing

    try:
        request = CanvasMediaOperationRequest.model_validate(payload)
    except ValidationError:
        operation_kind = (
            payload.get("operation", {}).get("kind")
            if isinstance(payload, dict) and isinstance(payload.get("operation"), dict)
            else None
        )
        error_code = {
            "crop": "canvas_media_invalid_crop",
            "split": "canvas_media_invalid_split",
        }.get(operation_kind, "canvas_media_invalid_request")
        raise HTTPException(422, detail={
            "code": error_code,
            "message": "图片处理参数无效，请检查选区或切线。",
        }) from None

    try:
        return await run_in_threadpool(execute_canvas_media_operation, project_id, request)
    except CanvasMediaOperationError as error:
        status = 404 if error.code == "canvas_media_source_missing" else 422
        raise HTTPException(
            status,
            detail={"code": error.code, "message": error.message},
        ) from error
    except MattingModelMissing:
        raise HTTPException(422, detail={
            "code": "canvas_matting_model_missing",
            "message": "抠图模型尚未下载，请先下载模型。",
        }) from None
    except KeyError:
        raise HTTPException(404, detail={
            "code": "canvas_media_source_missing",
            "message": "找不到这个画布项目或源图片节点。",
        }) from None
    except PermissionError as error:
        raise HTTPException(403, detail={
            "code": "canvas_media_source_missing",
            "message": str(error),
        }) from error
    except (OSError, MemoryError) as error:
        logger.warning("canvas media operation could not write outputs: %s", type(error).__name__)
        raise HTTPException(503, detail={
            "code": "canvas_media_processing_unavailable",
            "message": "本地图片处理暂时不可用，未提交任何画布变化。",
        }) from error
    except RuntimeError as error:
        detail = str(error)
        if detail.startswith("revision_conflict:"):
            current_revision = int(detail.split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "canvas_media_revision_conflict",
                "message": "画布已经变化，刷新后可保留选择并重试。",
                "current_revision": current_revision,
            }) from error
        logger.warning("canvas media operation failed: %s", type(error).__name__)
        raise HTTPException(409, detail={
            "code": "canvas_media_transaction_failed",
            "message": "图片处理事务未能安全提交，请刷新画布后重试。",
        }) from error


class CanvasMattingModelStatus(BaseModel):
    model_id: str
    ready: bool
    bytes: int
    provider: str
    available: bool
    message: str | None


def _matting_model_status() -> CanvasMattingModelStatus:
    from character_workflow.lib.matting import model_status

    status = model_status()
    return CanvasMattingModelStatus(
        model_id=status.model_id, ready=status.ready, bytes=status.bytes, provider=status.provider,
        available=status.available, message=status.message,
    )


@router.get("/canvas/matting-model", response_model=CanvasMattingModelStatus)
async def get_canvas_matting_model() -> CanvasMattingModelStatus:
    return await run_in_threadpool(_matting_model_status)


@router.post("/canvas/matting-model", response_model=CanvasMattingModelStatus)
async def post_canvas_matting_model() -> CanvasMattingModelStatus:
    """下载抠图模型（约 214 MB）。同步等待，前端按需提示进度。"""
    from character_workflow.lib.matting import UNAVAILABLE_MESSAGE, ensure_model, runtime_available

    if not runtime_available():
        raise HTTPException(422, detail={
            "code": "canvas_matting_unavailable", "message": UNAVAILABLE_MESSAGE,
        })
    try:
        await run_in_threadpool(ensure_model)
    except RuntimeError as error:
        raise HTTPException(503, detail={
            "code": "canvas_matting_model_download_failed",
            "message": str(error),
        }) from error
    return await run_in_threadpool(_matting_model_status)


@router.get("/canvas/projects/{project_id}/versions/{version_id}/media")
def get_canvas_media(
    project_id: str,
    version_id: str,
    w: int | None = Query(default=None, gt=0, le=8192),
) -> FileResponse:
    """w 是「这张图会被显示成多宽」，不是「请给我这个尺寸」。

    服务端向上取到固定档位（256 / 512 / 1024）后发缩略图；原图本来就更小、
    是动图、或者要的比最大档位还宽时照发原图。缩略图纯属优化，不改变可见内容。
    """
    return _canvas_media_file_response(project_id, version_id, download=False, display_width=w)


@router.get("/canvas/projects/{project_id}/versions/{version_id}/download")
def download_canvas_media(
    project_id: str,
    version_id: str,
) -> FileResponse:
    return _canvas_media_file_response(project_id, version_id, download=True)


def _canvas_media_file_response(
    project_id: str,
    version_id: str,
    *,
    download: bool,
    display_width: int | None = None,
) -> FileResponse:
    from character_workflow.lib.canvas_projects import (
        canvas_media_response_metadata,
        resolve_canvas_media,
    )
    from character_workflow.lib.canvas_thumbnails import resolve_canvas_thumbnail
    try:
        path, version = resolve_canvas_media(project_id, version_id)
        media_type, filename = canvas_media_response_metadata(version)
        if display_width is not None:
            thumbnail = resolve_canvas_thumbnail(project_id, version, path, display_width)
            if thumbnail is not None:
                path, media_type = thumbnail, "image/webp"
        headers = {"X-Content-Type-Options": "nosniff"}
        if not download:
            headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return FileResponse(
            path,
            media_type=media_type,
            filename=filename if download else None,
            content_disposition_type="attachment" if download else "inline",
            headers=headers,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    except FileNotFoundError:
        from character_workflow.lib.schemas import CanvasMediaVersion
        from character_workflow.lib.collab_pending_media import preview_path
        from character_workflow.lib.canvas_projects import read_canvas_document
        version = read_canvas_document(project_id).content_versions.get(version_id)
        if isinstance(version, CanvasMediaVersion) and version.pending_shared_original:
            preview = preview_path(project_id, version) if display_width and not download else None
            if preview:
                return FileResponse(preview, media_type="image/webp", headers={"Cache-Control": "no-store"})
            raise HTTPException(424, detail="等待房主补齐原件") from None
        raise HTTPException(404, detail="找不到这个画布媒体文件") from None
    except PermissionError as error:
        raise HTTPException(403, detail=str(error)) from error


class _LayerArchiveResponse(FileResponse):
    async def __call__(self, scope, receive, send) -> None:
        # FileResponse can return early for invalid Range, or fail before its background task.
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


@router.get("/canvas/projects/{project_id}/nodes/{node_id}/layers/download")
def get_canvas_layers_download(
    project_id: str,
    node_id: str,
    format: Literal["zip", "psd"] = Query("zip"),
) -> FileResponse:
    from character_workflow.lib import canvas_layer_exports

    export = (
        canvas_layer_exports.export_canvas_layers_psd
        if format == "psd"
        else canvas_layer_exports.export_canvas_layers
    )
    try:
        target, filename = export(project_id, node_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个拆分图层节点") from None
    except FileNotFoundError:
        raise HTTPException(404, detail="图层文件缺失，未导出不完整的压缩包") from None
    except PermissionError:
        raise HTTPException(403, detail="图层文件不属于这个画布项目") from None
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    return _LayerArchiveResponse(
        target,
        media_type="image/vnd.adobe.photoshop" if format == "psd" else "application/zip",
        filename=filename,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/canvas/projects/{project_id}/jobs", response_model=list[Job])
def get_canvas_jobs(project_id: str) -> list[Job]:
    from character_workflow.lib.canvas_runs import reconcile_canvas_jobs
    from character_workflow.lib.canvas_projects import read_canvas_project
    from character_workflow.lib.jobs import list_jobs
    try:
        read_canvas_project(project_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目（可能已被删除）") from None
    def canvas_jobs() -> list[Job]:
        return [
            job
            for job in list_jobs()
            if job.namespace == "canvas" and job.canvas_project_id == project_id
        ]

    # 出图期间前端会一直轮这条接口。list_jobs() 要把 .runtime/jobs 下每一个 job 文件都解析
    # 一遍，所以把刚读到的这一份直接交给 reconcile，只在真修过东西时才走第二遍扫描——
    # 而「有东西要修」在轮询期间几乎不发生。
    jobs = canvas_jobs()
    return canvas_jobs() if reconcile_canvas_jobs(project_id=project_id, jobs=jobs) else jobs


def _run_canvas_job_safely(job_id: str) -> None:
    """排进画布队列后立即返回，不在 Web 线程池里等名额或等执行。"""
    from character_workflow.lib import canvas_run_queue

    def report(future) -> None:
        # run_canvas_job persists both the friendly Job failure and failed candidates.
        if future.exception() is not None:
            logger.warning("canvas run failed: %s", job_id)

    try:
        canvas_run_queue.submit(job_id).add_done_callback(report)
    except Exception:  # noqa: BLE001
        logger.warning("canvas run failed: %s", job_id)


def _canvas_run_revision_conflict(error: RuntimeError) -> HTTPException | None:
    detail = str(error)
    if not detail.startswith("revision_conflict:"):
        return None
    return HTTPException(409, detail={
        "code": "revision_conflict",
        "message": "画布已发生变化，请保留当前内容并重试。",
        "current_revision": int(detail.split(":", 1)[1]),
    })


@router.post(
    "/canvas/projects/{project_id}/runs/layer-decomposition",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_layer_decomposition(
    project_id: str,
    payload: CanvasLayerDecompositionCreate,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import (
        CanvasRunCommandError,
        submit_layer_decomposition_run,
    )

    try:
        job, document = submit_layer_decomposition_run(
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.alias,
            payload.model,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或拆分图层节点") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/reverse-prompt",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_reverse_prompt(
    project_id: str,
    payload: CanvasReversePromptCreate,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import (
        CanvasRunCommandError,
        submit_reverse_prompt_run,
    )

    try:
        job, document = submit_reverse_prompt_run(
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或图片节点") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/angle",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_angle_run(
    project_id: str,
    payload: CanvasAngleRunCreate,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_angle_run

    try:
        job, document = submit_angle_run(
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.requested_count,
            payload.horizontal_angle,
            payload.pitch_angle,
            payload.camera_distance,
            payload.wide_angle,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或图片节点") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/upscale",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_upscale_run(
    project_id: str,
    payload: CanvasUpscaleRunCreate,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_upscale_run

    try:
        job, document = submit_upscale_run(
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.target,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或图片节点") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/image-edits",
    response_model=CanvasImageEditSaveResponse,
    status_code=201,
)
async def post_canvas_image_edit_save(
    project_id: str,
    payload: str = Form(...),
    mask_file: UploadFile | None = File(None),
) -> CanvasImageEditSaveResponse:
    from character_workflow.lib.canvas_image_edits import save_image_edit
    from character_workflow.lib.canvas_masks import CanvasMaskError
    try:
        command = CanvasImageEditSave.model_validate_json(payload)
        body = await mask_file.read(25 * 1024 * 1024 + 1) if mask_file else None
        document, node_id = await run_in_threadpool(save_image_edit, project_id, command, body)
        return CanvasImageEditSaveResponse(document=document, node_id=node_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或图片节点") from None
    except CanvasMaskError as error:
        raise HTTPException(422, detail={"code": error.code, "message": error.message}) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.post(
    "/canvas/projects/{project_id}/runs/image-edit",
    response_model=CanvasRunResponse,
    status_code=201,
)
async def post_canvas_image_edit_run(
    project_id: str,
    background: BackgroundTasks,
    payload: CanvasImageEditRunCreate,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_masks import CanvasMaskError
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_image_edit_run

    try:
        job, document = await run_in_threadpool(
            submit_image_edit_run,
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.requested_count,
        )
    except ValidationError as error:
        raise HTTPException(422, detail=error.errors()) from error
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或图片节点") from None
    except (CanvasRunCommandError, CanvasMaskError) as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/{run_id}/reverse-prompt-config",
    response_model=CanvasDocument,
)
def post_canvas_reverse_prompt_config(
    project_id: str,
    run_id: str,
    payload: CanvasReversePromptConfigCreate,
) -> CanvasDocument:
    from character_workflow.lib.canvas_runs import (
        CanvasRunCommandError,
        create_reverse_prompt_config,
    )

    try:
        return create_reverse_prompt_config(project_id, run_id, payload.expected_revision)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或反推生成记录") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        conflict = _canvas_run_revision_conflict(error)
        if conflict is not None:
            raise conflict from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.post(
    "/canvas/projects/{project_id}/runs",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_run(
    project_id: str,
    payload: CanvasRunCreate,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_canvas_run

    try:
        job, document = submit_canvas_run(
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.requested_count,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布项目或生成节点") from None
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={
            "code": error.code,
            "message": error.message,
        }) from error
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            current_revision = int(str(error).split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        raise HTTPException(409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    from viewer_server import routes as _self
    background.add_task(_self._run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/{run_id}/cancel",
    response_model=Job,
)
def post_canvas_run_cancel(project_id: str, run_id: str) -> Job:
    from character_workflow.lib.canvas_runs import request_canvas_run_cancel

    try:
        return request_canvas_run_cancel(project_id, run_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布生成记录") from None
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@router.post("/canvas/projects/{project_id}/runs/{run_id}/resume-mj-edit", response_model=CanvasRunResponse)
def post_canvas_resume_mj_edit(project_id: str, run_id: str, payload: CanvasCandidateDismiss,
                             background: BackgroundTasks) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import resume_mj_edit_run

    try:
        job, document = resume_mj_edit_run(project_id, run_id, payload.expected_revision)
    except KeyError:
        raise HTTPException(404, detail="找不到这个画布生成记录") from None
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    except RuntimeError as error:
        raise _canvas_run_revision_conflict(error) or HTTPException(409, detail=str(error)) from error
    background.add_task(_run_canvas_job_safely, job.job_id)
    return CanvasRunResponse(job=job, document=document)


@router.post(
    "/canvas/projects/{project_id}/runs/{run_id}/candidates/{candidate_id}/dismiss",
    response_model=CanvasRunResponse,
)
def post_canvas_candidate_dismiss(
    project_id: str,
    run_id: str,
    candidate_id: str,
    payload: CanvasCandidateDismiss,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import dismiss_canvas_candidate

    try:
        job, document = dismiss_canvas_candidate(
            project_id,
            run_id,
            candidate_id,
            payload.expected_revision,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个生成记录或候选结果") from None
    except RuntimeError as error:
        detail = str(error)
        if detail.startswith("revision_conflict:"):
            current_revision = int(detail.split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        raise HTTPException(409, detail=detail) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    return CanvasRunResponse(job=job, document=document)


def _reset_studio_recovery_workers() -> None:
    _STUDIO_SHUTDOWN_EVENT.clear()


def _stop_studio_recovery_workers() -> None:
    _STUDIO_SHUTDOWN_EVENT.set()
    for task in tuple(_STUDIO_BACKGROUND_TASKS):
        task.cancel()


def _run_studio_job_once(
    job_id: str,
) -> bool:
    """Run one provider attempt; return whether the same paid task remains resumable.

    This synchronous function runs only in the dedicated Studio executor. Recovery delays live in
    the async wrapper, so pending Tuzi tasks do not occupy FastAPI's shared AnyIO thread pool.
    """
    from character_workflow.lib.callers.atelier_gateway import gateway_reachable
    from character_workflow.lib.job_runner import JobExecutionBusy, run_job
    from character_workflow.lib.jobs import is_waiting_gateway_job

    try:
        current = read_job(job_id)
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        current = None
    # 排队时已被停止（或已到终态）：轮到它时安静退出，不改状态、不发请求（Windows 实测 W5）。
    if current is not None and current.status not in (JobStatus.PENDING, JobStatus.PENDING_CONFIRM):
        return False
    # 等待网关：先用 3 秒的健康检查探一下，连不上就不跑（不占执行线程），下一轮再看。
    if current is not None and is_waiting_gateway_job(current) and not gateway_reachable(current.alias):
        return True
    try:
        job = run_job(job_id, should_cancel=_STUDIO_SHUTDOWN_EVENT.is_set, park_gateway_wait=True)
    except JobExecutionBusy:
        # Startup recovery and the original BackgroundTask can overlap. The lock owner is already
        # handling this exact Job. Keep a Tuzi recovery waiter alive in case that owner disappears.
        try:
            return is_resumable_studio_job(read_job(job_id))
        except FileNotFoundError:
            return False
    except Exception as e:  # noqa: BLE001
        # run_job already records provider failures. Guard only errors that escaped before its
        # state-transition block (for example, loading a deleted Job).
        try:
            job = read_job(job_id)
        except FileNotFoundError:
            return False
        if job.status not in {
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        }:
            update_job_status(job_id, status=JobStatus.FAILED, error=str(e))
        return False
    return is_resumable_studio_job(job)


async def _run_studio_job_safely(
    job_id: str,
    *,
    max_recovery_attempts: int | None = None,
) -> None:
    """Run Studio work outside AnyIO's shared pool, with async recovery delays."""
    attempts = 0
    loop = asyncio.get_running_loop()
    while not _STUDIO_SHUTDOWN_EVENT.is_set():
        attempts += 1
        try:
            should_retry = await loop.run_in_executor(
                _STUDIO_RUNNER_EXECUTOR,
                _run_studio_job_once,
                job_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 —— 一轮出错不能让等待者退出（任务会永远挂着），下一轮再试
            logging.getLogger(__name__).exception("创作台任务后台重跑出错 job=%s", job_id)
            should_retry = True
        if not should_retry:
            return
        if max_recovery_attempts is not None and attempts >= max_recovery_attempts:
            return
        await asyncio.sleep(_STUDIO_RECOVERY_DELAY_SECONDS)


async def _start_studio_job_task(job_id: str) -> asyncio.Task | None:
    """Detach a Studio runner from the response lifecycle and track it for shutdown."""
    from viewer_server import routes as _self

    result = _self._run_studio_job_safely(job_id)
    if not inspect.isawaitable(result):
        return
    task = asyncio.create_task(result)
    _STUDIO_BACKGROUND_TASKS.add(task)
    task.add_done_callback(_STUDIO_BACKGROUND_TASKS.discard)
    return task


@router.post("/studio/jobs", status_code=201)
def create_studio_job(body: _StudioJobCreate, background: BackgroundTasks) -> dict:
    """Create a standalone studio job (namespace='studio') and schedule the runner.

    Skips pending_confirm — UI submit is the explicit user consent.
    Output will be written to <data_root>/studio/<job_id>/ when run.
    Both IMAGE and VIDEO kinds are accepted; only IMAGE enforces params.n ∈ [1, 4].

    The runner is fired via BackgroundTasks so the response returns immediately;
    the UI then polls /api/jobs/<id> to observe status transitions.
    """
    sid = body.studio_agent_session_id
    request_id = body.client_request_id
    # 核对与新建放在同一把按请求 ID 的锁里：首个请求还在路上时的重发不能两边都建任务、都排运行。
    # 不复用 job_lock：save_job 内部会再拿同一个 job_lock。
    request_lock = (
        file_lock(data_root.runtime_dir() / "locks" / f"studio-request-{request_id}.lock")
        if request_id else nullcontext()
    )
    with request_lock, (studio_agent_sessions.locked_session(sid) if sid else nullcontext()):
        # 同一请求 ID 重发（上次回包途中断开）：返回已建的任务，不再下单、不再排一次运行。
        if request_id and (existing := _studio_job_for_request(request_id)) is not None:
            return existing.model_dump(mode="json")
        job = _create_user_job(
            body, namespace="studio", studio_agent_session_id=sid,
            job_id=_studio_request_job_id(request_id) if request_id else None,
        )
    # The BackgroundTask only detaches a tracked asyncio task; the potentially long provider
    # lifecycle is not tied to Uvicorn's response-drain phase during shutdown.
    background.add_task(_start_studio_job_task, job.job_id)
    return job.model_dump(mode="json")


@router.get("/studio/jobs/by-request/{request_id}")
def get_studio_job_by_request(request_id: str) -> dict:
    """提交受理未知时核对：这个请求 ID 建过任务就返回它，没建过 404。"""
    if not re.fullmatch(_STUDIO_REQUEST_ID_PATTERN, request_id):
        raise HTTPException(422, detail="请求 ID 格式不对")
    job = _studio_job_for_request(request_id)
    if job is None:
        raise HTTPException(404, detail="Cobrush 没有收到这次提交")
    return job.model_dump(mode="json")


@router.post("/studio/jobs/{job_id}/requery")
def requery_studio_job(job_id: str, background: BackgroundTasks) -> dict:
    """失败卡「重新查询」：上游已有任务号的失败任务回到排队，凭原任务号续查，不重新下单。"""
    with job_lock(job_id):
        try:
            job = read_job(job_id)
        except FileNotFoundError as error:
            raise HTTPException(404, detail="找不到这一轮，可能已被删除") from error
        if job.namespace != "studio":
            raise HTTPException(404, detail="找不到这一轮，可能已被删除")
        if job.status == JobStatus.PENDING:
            return job.model_dump(mode="json")
        if job.status != JobStatus.FAILED:
            raise HTTPException(409, detail="这一轮已经结束，不需要重新查询")
        resumed = job.model_copy(update={
            "status": JobStatus.PENDING, "error": None, "error_code": None,
            "completed_at": None, "progress_phase": None, "cancel_requested_at": None,
        })
        # 与服务重启后的续查同一判据：只有凭任务号（或网关幂等键）能接回的才放行，绝不重新提交。
        if not is_resumable_studio_job(resumed):
            raise HTTPException(409, detail="这一轮没有可以续查的上游任务号")
        job = write_job_under_lock(resumed)
    background.add_task(_start_studio_job_task, job_id)
    return job.model_dump(mode="json")


class _StudioJobToCanvas(BaseModel):
    project_id: str = Field(min_length=1, max_length=160)
    output_index: int = Field(ge=0)


@router.post("/studio/jobs/{job_id}/canvas")
def post_studio_job_to_canvas(job_id: str, body: _StudioJobToCanvas) -> dict:
    """结果卡「加入画布」：在目标画布新建图片 / 视频节点，不建个人资产（D4）。"""
    from character_workflow.lib.studio_jobs import add_job_output_to_canvas

    try:
        return add_job_output_to_canvas(job_id, body.output_index, body.project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, detail="找不到这一轮，可能已被删除") from e
    except LookupError as e:
        raise HTTPException(404, detail=str(e) if not isinstance(e, KeyError) else "找不到目标画布") from e
    except ValueError as e:
        raise HTTPException(422, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, detail="画布正在被修改，请稍后重试") from e
