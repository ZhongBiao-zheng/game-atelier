"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import random
import re
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from character_workflow.lib import data_root, keys, model_routes
from character_workflow.lib.atomic_io import (
    atomic_write_bytes,
    atomic_write_json,
)
from character_workflow.lib.job_runner import image_dimensions_from_bytes
from character_workflow.lib.local_paths import data_root_file
from character_workflow.lib.jobs import (
    _load_job, delete_failed_job, is_resumable_studio_job, job_lock, list_jobs, read_job,
    remove_image_from_job, request_job_cancel,
    new_job_id, save_job, update_job_status,
)
from pydantic import BaseModel, Field, ValidationError
from pydantic import field_validator

from character_workflow.lib.schemas import (
    JOB_PARAM_PATH_FIELDS,
    CanvasAgentSession, CanvasAgentSessionCreate, CanvasAgentSessionList,
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
            out.append(_load_job(json.loads(p.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError, ValidationError):
            logger.warning("skipping bad job file: %s", p.name)
    return out


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str) -> Job:
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）")
    return _load_job(json.loads(p.read_text(encoding="utf-8")))




_THUMBNAIL_EXTS = {".png", ".jpg", ".jpeg", ".webp"}






















def _read_config() -> dict:
    p = _runtime() / "config.json"
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
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
# 减 mask_image：只由服务端写（画布局部编辑），两个浏览器入口都先把浏览器传的丢掉。
# 加 source_image：不是 JobParams 的声明字段，但 extra="allow" 让浏览器能塞进来，caller 会回退读它。
_BROWSER_REF_FIELDS = tuple(
    field for field in JOB_PARAM_PATH_FIELDS if field != "mask_image"
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
                # mask_image 同理只由服务端写。
                for owned in (
                    "provider_task_protocol", "provider_task_ids", "video_submission_attempts",
                    "mask_image", "image_edit", "mj_submission_ids", "mj_submit_uncertain",
                    "evolink_state", "edit_inputs", "edit_prompt",
                    "route_id", "route_order", "route_tried",
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
        # 全部声明的路径字段都放行（含服务端写的 mask_image）；params 里的 extra 字段 source_image
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














@router.delete("/jobs/{job_id}/image")
def delete_job_image(job_id: str, path: str) -> dict:
    try:
        remove_image_from_job(job_id, path)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from e
    except ValueError as e:
        raise HTTPException(404, detail=f"这张图不在该记录里：{e}") from e
    return {"ok": True}


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
        age = _pending_age_minutes(job)
        if not is_resumable_studio_job(job) and (age is None or age >= STALE_PENDING_MINUTES):
            update_job_status(
                job_id, status=JobStatus.FAILED,
                error=f"cancelled: pending 超过 {STALE_PENDING_MINUTES} 分钟，疑似进程中断",
            )
            return {"ok": True, "job_id": job_id, "status": JobStatus.FAILED.value}
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


def _pick_folder_macos(payload: "_FolderPickerPayload") -> dict:
    script = f"choose folder with prompt {_osascript_string(payload.title)}"
    if payload.initial_path:
        initial = Path(os.path.expandvars(os.path.expanduser(payload.initial_path)))
        script += f" default location POSIX file {_osascript_string(str(initial))}"
    proc = subprocess.run(
        ["osascript", "-e", f"POSIX path of ({script})"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        if "User canceled" in stderr or "用户已取消" in stderr:
            return {"path": None}
        raise HTTPException(
            500, detail=f"打不开系统文件夹选择器：{stderr or '子进程没有给出原因'}"
        )
    return {"path": str(Path(proc.stdout.strip()).expanduser().resolve())}


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


@router.get("/onboarding/status")
def onboarding_status() -> dict:
    """Proxies `bootstrap.py --check` so Web 不用知道状态机细节。"""
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--check"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"检查 Python 运行环境失败（bootstrap --check）：{proc.stderr}")
    return json.loads(proc.stdout)


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


@router.post("/onboarding/data-root")
def set_data_root(payload: _DataRootPayload) -> dict:
    """Web 选完目录后落 global config，Skill 下次启动会从 global config 读。"""
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--init-data-root", payload.path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"初始化数据目录失败（init-data-root）：{proc.stderr}")
    body = json.loads(proc.stdout)
    if root := body.get("data_root"):
        os.environ["GAME_ATELIER_DATA_ROOT"] = root
    return body


class _KeyCreatePayload(BaseModel):
    enabled: bool = True
    alias: str
    provider: str
    base_url: str | None = None
    billing_group: str | None = None
    access_key: str
    secret_key: str | None = None
    capabilities: list[str] = []
    models: list[keys.ModelSpec] = []
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = []
    notes: str = ""
    created_at: str | None = None

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

    @field_validator("models", mode="before")
    @classmethod
    def _normalize_models(cls, value: object) -> object:
        if isinstance(value, list):
            return [
                {"name": item, "id": item} if isinstance(item, str) else item
                for item in value
            ]
        return value


@router.get("/keys")
def list_keys() -> dict:
    db = keys.read_keys_db()
    return {"keys": keys.keys_for_api(), "default_alias": db.default_alias}


def _route_payload(route: model_routes.ModelRoute) -> dict:
    members, candidate_alias, estimates = model_routes.route_preview(route)
    return {
        "mode": route.mode, "candidate_alias": candidate_alias,
        "id": route.id, "name": route.name, "modality": route.modality,
        "members": [
            {"alias": m.alias, "provider": m.provider, "base_url": m.base_url,
             "billing_group": m.billing_group, "estimate_cny": estimates[m.alias],
             "model_id": m.model_id, "name": m.name, "protocol": m.protocol,
             **({"via": list(m.via)} if m.via else {})}
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


@router.post("/keys", status_code=201)
def create_key(payload: _KeyCreatePayload) -> dict:
    from datetime import datetime, timezone
    try:
        spec = keys.KeySpec(
            alias=payload.alias, provider=payload.provider, enabled=payload.enabled,
            base_url=payload.base_url,
            billing_group=payload.billing_group,
            access_key=payload.access_key, secret_key=payload.secret_key,
            capabilities=payload.capabilities, models=payload.models,
            homepage_url=payload.homepage_url,
            docs_url=payload.docs_url,
            api_key_url=payload.api_key_url,
            modalities=payload.modalities,
            notes=payload.notes,
            created_at=payload.created_at or datetime.now(timezone.utc).isoformat(),
        )
    except Exception as e:
        raise HTTPException(422, str(e)) from e
    try:
        keys.add_key(spec)
    except keys.DuplicateAliasError:
        raise HTTPException(
            409, f"别名「{payload.alias}」已经存在：换个别名，或直接改那条已有的密钥"
        ) from None
    if spec.provider == "atelier":
        # 局域网网关接进来就排在每个路由组的第一位，本机 KEY 作兜底（ADR-0025）。
        model_routes.put_alias_first(spec.alias)
    return {"alias": payload.alias}


@router.patch("/keys/{alias}")
def patch_key_endpoint(alias: str, payload: _KeyPatchPayload) -> dict:
    patch_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    # billing_group 留空表示明确关闭聚合商计价；不能像密钥字段一样把显式 null 当作“未传”。
    if "billing_group" in payload.model_fields_set:
        patch_data["billing_group"] = payload.billing_group
    try:
        keys.patch_key(alias, patch_data)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"找不到别名「{alias}」的密钥（可能已被删除）") from None
    return {"alias": alias}


@router.delete("/keys/{alias}", status_code=204)
def delete_key_endpoint(alias: str) -> None:
    keys.delete_key(alias)
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


class _ModelsPreviewPayload(BaseModel):
    alias: str | None = None
    provider: str | None = None
    base_url: str | None = None
    access_key: str | None = None
    # 逃生舱：连判定为不可生成的模型也一并返回（词表判过头时用）。
    include_all: bool = False


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
)
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
    if any(_protocol_is_openai_speech(protocol) for protocol in protocols):
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
    if _id_hits(mid, _TEXT_ID_HINTS):
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
    return None


def _audio_protocol(item: dict) -> str | None:
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    if any(_protocol_is_openai_speech(protocol) for protocol in protocols):
        return "openai-speech"
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


def _fetch_model_rows(url: str, headers: dict) -> list:
    """拉一次上游模型列表并归一成 list；任何一步失败都抛 502 带上游原文。"""
    import requests

    try:
        resp = requests.get(url, headers=headers, timeout=20)
    except requests.RequestException as e:
        raise HTTPException(502, f"请求上游失败: {e}") from e
    if resp.status_code >= 400:
        raise HTTPException(502, f"上游 {resp.status_code}: {resp.text[:200]}")
    try:
        body = resp.json()
    except ValueError as e:
        raise HTTPException(502, f"上游响应非 JSON: {resp.text[:200]}") from e
    rows = body.get("data") if isinstance(body, dict) else body
    if not isinstance(rows, list):
        raise HTTPException(502, "上游响应缺少模型列表（data）")
    return rows


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


def _model_input_modalities(item: dict) -> list[str]:
    """Normalize explicit upstream input modality declarations; never infer vision from model ids."""
    arch = item.get("architecture")
    raw = item.get("input_modalities")
    if raw is None and isinstance(arch, dict):
        raw = arch.get("input_modalities")
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

    url = _model_list_url(base_url, preview_provider)
    headers = {"Authorization": f"Bearer {access_key}"} if access_key else {}
    rows = _fetch_model_rows(url, headers)

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
        if evolink and mid != "mj-v8.2":
            excluded += 1
            continue
        category = "image" if evolink else _classify_model(item)
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
            protocol = _text_protocol(item)
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
    return {"models": models, "total": total, "excluded": excluded}


_GALLERY_SLOTS = ("portrait", "promo", "turnaround")
_GALLERY_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


@router.get("/gallery/recent")
def gallery_recent(limit: int = Query(default=24, ge=1, le=100)) -> dict:
    """Return random character images from portrait/promo/turnaround.

    Studio 只混入已完成任务登记的图片产物。
    show_canvas_on_home（默认开）时混入画布上正在显示、没打码的生成图。
    """
    items: list[dict] = []
    hidden = set(_read_gallery_hidden())
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
    for canvas_project_id, canvas_job_id, f in list_canvas_gallery_images() if show_canvas else []:
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


def _read_gallery_hidden() -> list[str]:
    path = data_root.runtime_dir() / "gallery-hidden.json"
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    paths = payload.get("paths") if isinstance(payload, dict) else None
    if not isinstance(paths, list):
        return []
    return [value for value in paths if isinstance(value, str)]



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
    path: str = Field(min_length=1)
    hidden: bool


@router.get("/gallery/hidden")
def gallery_hidden() -> dict:
    return {"paths": _read_gallery_hidden()}


@router.post("/gallery/hidden")
def post_gallery_hidden(patch: _GalleryHiddenPatch) -> dict:
    target = _normalize_gallery_path(patch.path)
    paths = [p for p in _read_gallery_hidden() if p != target]
    if patch.hidden:
        paths.append(target)
    atomic_write_json(_gallery_hidden_file(), {"paths": paths})
    return {"paths": paths}


def _gallery_favorites_file() -> Path:
    return _runtime() / "gallery-favorites.json"


def _read_gallery_favorites() -> list[str]:
    p = _gallery_favorites_file()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
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
        data = json.loads(p.read_text(encoding="utf-8"))
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


class _StudioJobCreate(BaseModel):
    model_config = {"extra": "forbid"}
    prompt: str = Field(min_length=1)
    prompt_template: str | None = Field(default=None, max_length=40_000)
    model: str
    params: JobParams
    alias: str | None = None
    kind: JobKind = JobKind.IMAGE


def _create_user_job(
    body: _StudioJobCreate,
    *,
    namespace: Literal["studio"],
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
    if not prompt.strip():
        raise HTTPException(status_code=422, detail="生成提示词不能为空")
    if body.kind not in {JobKind.IMAGE, JobKind.VIDEO}:
        raise HTTPException(422, detail="创作台目前只接受图片或视频任务")
    params = body.params.model_copy(deep=True)
    # Provider task handles are runner-owned.  A Studio create request always represents a new
    # order and may not attach itself to an arbitrary existing Tuzi task.
    params.provider_task_protocol = None
    params.provider_task_ids = None
    params.video_submission_attempts = None
    params.mask_image = None
    params.image_edit = None
    params.mj_submission_ids = None
    params.mj_submit_uncertain = None
    params.evolink_state = None
    params.edit_inputs = None
    params.edit_prompt = None
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
        job_id=new_job_id(),
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


@router.delete("/canvas/projects/{project_id}", status_code=204)
def delete_canvas_project_route(
    project_id: str,
    payload: CanvasProjectDeleteRequest,
) -> Response:
    from character_workflow.lib.canvas_packages import (
        CanvasPackageError,
        CanvasProjectBusyError,
        delete_canvas_project,
    )
    try:
        delete_canvas_project(project_id, payload.expected_revision)
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
    return Response(status_code=204)


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
    from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session
    from viewer_server.canvas_chat_routes import recover_if_stale
    try:
        session = recover_if_stale(read_canvas_agent_session(project_id, session_id))
        response.headers["ETag"] = f'"{session.revision}"'
        return session
    except (KeyError, ValueError) as error:
        _raise_canvas_agent_session_error(error)


@router.delete(
    "/canvas/projects/{project_id}/agent/sessions/{session_id}",
    status_code=204,
)
def delete_canvas_agent_session_route(
    project_id: str,
    session_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> Response:
    from character_workflow.lib.canvas_agent_sessions import delete_canvas_agent_session
    from viewer_server.canvas_chat_routes import cancel
    cancel(project_id, session_id)
    try:
        delete_canvas_agent_session(
            project_id,
            session_id,
            _canvas_if_match(if_match, "Agent 会话"),
        )
        return Response(status_code=204)
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
):
    from character_workflow.lib.creation_assets import list_creation_assets
    try:
        return list_creation_assets(
            kind=kind,
            scope=scope,
            project_id=project_id,
            has_category=has_category,
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


@router.post("/creation-assets/{asset_id}/use", response_model=CreationAsset)
def post_creation_asset_use(asset_id: str, payload: CreationAssetUseRequest):
    from character_workflow.lib.creation_assets import mark_creation_asset_used
    try:
        return mark_creation_asset_used(asset_id, payload.project_id)
    except (KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.delete("/creation-assets/{asset_id}", status_code=204)
def delete_creation_asset_route(asset_id: str) -> Response:
    from character_workflow.lib.creation_assets import delete_creation_asset
    try:
        delete_creation_asset(asset_id)
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
    from character_workflow.lib.canvas_runs import run_canvas_job_scheduled

    try:
        run_canvas_job_scheduled(job_id)
    except Exception:  # noqa: BLE001
        # run_canvas_job persists both the friendly Job failure and failed candidates.
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
    from character_workflow.lib.job_runner import JobExecutionBusy, run_job

    try:
        job = run_job(job_id, should_cancel=_STUDIO_SHUTDOWN_EVENT.is_set)
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
        should_retry = await loop.run_in_executor(
            _STUDIO_RUNNER_EXECUTOR,
            _run_studio_job_once,
            job_id,
        )
        if not should_retry:
            return
        if max_recovery_attempts is not None and attempts >= max_recovery_attempts:
            return
        await asyncio.sleep(_STUDIO_RECOVERY_DELAY_SECONDS)


async def _start_studio_job_task(job_id: str) -> None:
    """Detach a Studio runner from the response lifecycle and track it for shutdown."""
    from viewer_server import routes as _self

    result = _self._run_studio_job_safely(job_id)
    if not inspect.isawaitable(result):
        return
    task = asyncio.create_task(result)
    _STUDIO_BACKGROUND_TASKS.add(task)
    task.add_done_callback(_STUDIO_BACKGROUND_TASKS.discard)


@router.post("/studio/jobs", status_code=201)
def create_studio_job(body: _StudioJobCreate, background: BackgroundTasks) -> dict:
    """Create a standalone studio job (namespace='studio') and schedule the runner.

    Skips pending_confirm — UI submit is the explicit user consent.
    Output will be written to <data_root>/studio/<job_id>/ when run.
    Both IMAGE and VIDEO kinds are accepted; only IMAGE enforces params.n ∈ [1, 4].

    The runner is fired via BackgroundTasks so the response returns immediately;
    the UI then polls /api/jobs/<id> to observe status transitions.
    """
    job = _create_user_job(body, namespace="studio")
    # The BackgroundTask only detaches a tracked asyncio task; the potentially long provider
    # lifecycle is not tied to Uvicorn's response-drain phase during shutdown.
    background.add_task(_start_studio_job_task, job.job_id)
    return job.model_dump(mode="json")
