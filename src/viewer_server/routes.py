"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from character_workflow.lib import data_root, keys
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.character_derivatives import (
    character_display_name,
    create_character_derivative,
    initialize_character_directory,
    new_temporary_character_id,
    read_character_derivative,
)
from character_workflow.lib.atomic_io import (
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
)
from character_workflow.lib.job_runner import image_dimensions_from_bytes
from character_workflow.lib.jobs import (
    _load_job, delete_failed_job, is_resumable_studio_job, job_lock, list_jobs, read_job,
    remove_image_from_job,
    new_job_id, save_job, update_job_status, write_job,
)
from character_workflow.lib.schemas import AssetSlot as _AssetSlot
from character_workflow.lib.projects import (
    assign_character, create_project, delete_project, read_projects,
    rename_project, reorder_projects, resolve_project, touch_project,
)
from character_workflow.lib.project_gallery import (
    gallery_job_ids_by_path,
    project_gallery,
    project_gallery_media,
    project_id_for_media_path,
    project_index,
    read_gallery_hidden,
)
from pydantic import BaseModel, Field, ValidationError
from pydantic import field_validator

from character_workflow.lib.schemas import (
    ActiveCharacterFile, CanonicalSet, CanonicalStatusFile, CharacterEntry,
    CharacterAssociationPatch, CharacterAssociationsFile,
    CanvasAgentSession, CanvasAgentSessionCreate, CanvasAgentSessionList,
    CanvasAngleRunCreate, CanvasCandidateDismiss, CanvasDocument,
    CanvasCreationAssetInsertRequest,
    CanvasLayerDecompositionCreate,
    CanvasPackageCommitRequest, CanvasPackageImportResponse,
    CanvasMaskEditCreate, CanvasMediaOperationRequest, CanvasMediaOperationResponse,
    CanvasProject, CanvasProjectCreate, CanvasProjectDeleteRequest, CanvasProjectExportRequest,
    CanvasProjectList, CanvasProjectRename, CanvasReversePromptConfigCreate,
    CanvasReversePromptCreate, CanvasRunCreate, CanvasRunResponse, CanvasRunRetry,
    CanvasUiPreferences, CanvasUiPreferencesUpdate, CanvasUploadResponse,
    CharacterIndexResponse, CharacterWorkspaceResponse,
    CharacterDerivativeCreate,
    CharacterProjectAssign, ClipboardAttempt,
    CreationAsset, CreationAssetList, CreationAssetUseRequest,
    CreationImagePathCreate, CreationPromptAssetCreate, CreationPromptAssetUpdate,
    FeedbackPost, GalleryMedia, Job, JobKind, JobParams, JobStatus, ProjectCreate,
    ProjectRename, ProjectGalleryResponse, ProjectIndexResponse,
    ProjectVideoProduction, ProjectVideoReferencesResponse,
    ProjectVideosResponse, ProjectWorkspaceSummary,
    ProjectsFile,
    ScreenCanonicalSet, ScreenCanonicalStatusFile, SpecPatch, VideoSelectedResponse,
    VideoReferencesResponse, VideoReferencesSet,
    UiSchemeCreate, UiSchemeDefaultSet, UiSchemesFile,
    WebEditableJobPatch,
)


_STUDIO_SHUTDOWN_EVENT = threading.Event()
_STUDIO_RECOVERY_DELAY_SECONDS = 30
_STUDIO_RUNNER_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="studio-job")
_STUDIO_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


logger = logging.getLogger(__name__)


class CharacterCreate(BaseModel):
    name: str
    project_id: str | None = None


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


@router.get("/spec/{character_id}")
def get_spec(character_id: str) -> dict:
    p = _project_root() / "characters" / character_id / "spec.md"
    if not p.exists():
        raise HTTPException(404, detail=f"找不到角色 {character_id} 的 spec.md（可能已被删除）")
    return {"content": p.read_text(encoding="utf-8")}


_THUMBNAIL_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def _latest_portrait(char_dir: Path, root: Path) -> str | None:
    """名册缩略图 = portrait 目录 mtime 最新的图片，返回 data-root 相对路径。

    走文件 mtime 而非 job JSON：画师手动上传的立绘没有 job，也应入选。
    """
    portrait = char_dir / "portrait"
    if not portrait.is_dir():
        return None
    best: Path | None = None
    best_mtime = -1.0
    for f in portrait.iterdir():
        if f.is_file() and f.suffix.lower() in _THUMBNAIL_EXTS:
            mtime = f.stat().st_mtime
            if mtime > best_mtime:
                best, best_mtime = f, mtime
    return best.relative_to(root).as_posix() if best else None


@router.get("/characters", response_model=list[CharacterEntry])
def get_characters() -> list[CharacterEntry]:
    root = _project_root()
    chars_dir = root / "characters"
    if not chars_dir.exists():
        return []
    out: list[CharacterEntry] = []
    for d in sorted(chars_dir.iterdir()):
        if not d.is_dir():
            continue
        spec = d / "spec.md"
        if not spec.exists():
            continue
        out.append(CharacterEntry(
            id=d.name, name=character_display_name(d.name), status="idle", latest_job_id=None,
            thumbnail=_latest_portrait(d, root),
            derivative=read_character_derivative(d.name),
        ))
    return out


@router.get(
    "/projects/{project_id}/characters/index",
    response_model=CharacterIndexResponse,
)
def get_character_index(project_id: str) -> CharacterIndexResponse:
    from character_workflow.lib.character_workspace import character_index
    try:
        return character_index(project_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个项目（可能已被删除）") from None


@router.get(
    "/projects/{project_id}/characters/{character_id}/workspace",
    response_model=CharacterWorkspaceResponse,
)
def get_character_workspace(
    project_id: str,
    character_id: str,
) -> CharacterWorkspaceResponse:
    from character_workflow.lib.character_workspace import character_workspace
    try:
        return character_workspace(project_id, character_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个角色或项目") from None
    except ValueError as error:
        raise HTTPException(400, detail=str(error)) from error


@router.put(
    "/projects/{project_id}/character-associations",
    response_model=CharacterAssociationsFile,
)
def put_character_association(
    project_id: str,
    payload: CharacterAssociationPatch,
) -> CharacterAssociationsFile:
    from character_workflow.lib.character_workspace import set_manual_association
    try:
        return set_manual_association(project_id, payload)
    except KeyError as error:
        raise HTTPException(404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(400, detail=str(error)) from error


@router.get(
    "/projects/{project_id}/character-associations",
    response_model=CharacterAssociationsFile,
)
def get_character_associations(project_id: str) -> CharacterAssociationsFile:
    from character_workflow.lib.character_workspace import read_associations
    try:
        return read_associations(project_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个项目（可能已被删除）") from None


@router.get("/home")
def get_home() -> dict:
    return {"home": str(Path.home())}


@router.post("/characters/{character_id}/rename")
def rename_character(character_id: str, payload: dict = Body(...)) -> dict:
    new_name = (payload.get("name") or "").strip()
    if not new_name:
        raise HTTPException(422, detail="名字不能为空")
    if "\n" in new_name or len(new_name) > 80:
        raise HTTPException(
            422, detail=f"名字不合法：不能换行、且不超过 80 字（当前 {len(new_name)} 字）"
        )
    p = _project_root() / "characters" / character_id / "spec.md"
    if not p.exists():
        raise HTTPException(
            404,
            detail=f"找不到角色 {character_id}（characters/{character_id}/spec.md 不存在，可能已被删除）",
        )
    text = p.read_text(encoding="utf-8")
    # YAML frontmatter: update `name:` field
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            frontmatter = text[3:end]
            if re.search(r"^name:\s*", frontmatter, re.MULTILINE):
                new_frontmatter = re.sub(r"^name:\s*.+$", f"name: {new_name}", frontmatter, flags=re.MULTILINE)
                new_text = "---" + new_frontmatter + text[end:]
            else:
                new_frontmatter = frontmatter.rstrip() + f"\nname: {new_name}\n"
                new_text = "---" + new_frontmatter + text[end:]
        else:
            new_text = text
    else:
        # Legacy: replace first `# heading`
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if re.match(r"^#\s+", line):
                lines[i] = f"# {new_name}"
                break
        else:
            lines = [f"# {new_name}", ""] + lines
        new_text = "\n".join(lines)
    atomic_write_text(p, new_text)
    return {"ok": True, "id": character_id, "name": new_name}


@router.get("/active-character", response_model=ActiveCharacterFile)
def get_active_character() -> ActiveCharacterFile:
    a = read_active()
    return ActiveCharacterFile(active_id=a.active_id, updated_at=a.updated_at)


@router.get("/images")
def get_images(character: str) -> dict:
    jobs_dir = _runtime() / "jobs"
    paths: list[str] = []
    if jobs_dir.exists():
        for p in jobs_dir.glob("*.json"):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                logger.warning("skipping bad job file: %s", p.name)
                continue
            if data.get("character_id") == character:
                paths.extend(data.get("output_paths", []))
    return {"character_id": character, "output_paths": paths}


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
        "show_studio_on_home": bool(cfg.get("show_studio_on_home", False)),
    }


@router.get("/characters/{character_id}/canonical", response_model=CanonicalStatusFile)
def get_canonical(character_id: str) -> CanonicalStatusFile:
    """定稿表 + A3 stale 标记（spec_stale / style_stale 为指纹比对计算态，不落盘）。"""
    from character_workflow.lib import stale
    return stale.character_canonical_status(character_id)


@router.post("/characters/{character_id}/canonical", response_model=CanonicalStatusFile)
def post_canonical(character_id: str, payload: CanonicalSet) -> CanonicalStatusFile:
    """设为 / 取消定稿（A2）。path=None 取消该 slot 定稿。"""
    from character_workflow.lib import canonical, stale
    try:
        if payload.path is None:
            canonical.clear_canonical(character_id, payload.slot)
        else:
            canonical.set_canonical(character_id, payload.slot, payload.path)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=str(e))
    except ValueError as e:
        raise HTTPException(400, detail=str(e))
    return stale.character_canonical_status(character_id)


@router.get(
    "/projects/{project_id}/ui-schemes/{scheme_id}/screens/canonical",
    response_model=ScreenCanonicalStatusFile,
)
def get_screen_canonical(project_id: str, scheme_id: str) -> ScreenCanonicalStatusFile:
    from character_workflow.lib import stale
    try:
        return stale.screen_canonical_status(project_id, scheme_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个项目（可能已被删除）")


@router.post(
    "/projects/{project_id}/ui-schemes/{scheme_id}/screens/canonical",
    response_model=ScreenCanonicalStatusFile,
)
def post_screen_canonical(
    project_id: str,
    scheme_id: str,
    payload: ScreenCanonicalSet,
) -> ScreenCanonicalStatusFile:
    """选定 / 取消某 screen 的风格定稿（B3）。path=None 取消。style_variant 从 job 反查，不用前端报。"""
    from character_workflow.lib import stale, ui_jobs
    try:
        if payload.path is None:
            ui_jobs.clear_screen_canonical(project_id, scheme_id, payload.screen_id)
        else:
            ui_jobs.set_screen_canonical(project_id, scheme_id, payload.screen_id, payload.path)
        return stale.screen_canonical_status(project_id, scheme_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个项目（可能已被删除）")
    except FileNotFoundError as e:
        raise HTTPException(404, detail=str(e))
    except ValueError as e:
        raise HTTPException(400, detail=str(e))


@router.post("/spec/{character_id}")
def post_spec(character_id: str, patch: SpecPatch) -> dict:
    p = _project_root() / "characters" / character_id / "spec.md"
    atomic_write_text(p, patch.content)
    write_active(character_id)
    return {"ok": True, "path": str(p)}


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
            raise HTTPException(403, detail="Canvas Job 的快照和参数不能通过通用编辑接口修改")
        for field, value in patch.model_dump(exclude_unset=True).items():
            if field == "params" and isinstance(value, dict):
                existing_params = data.get("params")
                existing_params = existing_params if isinstance(existing_params, dict) else {}
                # These fields identify an already billed provider task.  Browser edits must never
                # replace or erase them, otherwise a forged/stale id could retrieve the wrong task
                # or make the runner submit a second order after losing its recovery handle.
                for owned in ("provider_task_protocol", "provider_task_ids"):
                    if owned in existing_params:
                        value[owned] = existing_params[owned]
                    else:
                        value.pop(owned, None)
            data[field] = value
        # Validate the complete post-patch document before replacing the durable Job JSON.  This
        # catches explicit nulls and cross-field violations without discarding legacy raw fields.
        validated = dict(data)
        validated.pop("seed", None)
        Job.model_validate(validated)
        atomic_write_json(p, data)
    return {"ok": True}


@router.post("/feedback")
def post_feedback(payload: FeedbackPost) -> dict:
    draft_dir = _runtime() / "draft"
    draft_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    p = draft_dir / f"{ts}.md"
    body = f"<!-- character: {payload.character_id} -->\n{payload.text}"
    atomic_write_text(p, body)
    return {"ok": True, "path": str(p)}


@router.post("/clipboard-attempt")
def post_clipboard_attempt(attempt: ClipboardAttempt) -> dict:
    log_path = _runtime() / "clipboard.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(attempt.model_dump_json() + "\n")
    return {"ok": True}


@router.get("/raw")
def get_raw_image(path: str, job_id: str | None = None) -> FileResponse:
    """三条鉴权路径：
    - `job_id` 在场：以 job.output_paths / params.reference_images / source_image 作为白名单
    - 路径在 .runtime/uploads/ 下：放行（画师刚上传，还没绑到 job 上时的 preview 用）
    - 否则回退到 image_storage_root 前缀检查（兼容老链接）

    相对路径解析基准：data root（_project_root()），而非 CWD。
    /api/gallery/recent 返回的是相对路径（如 characters/foo/turnaround/v2.png），
    若用 Path(path).resolve() 会解析到 repo 根，与 job.output_paths 里的绝对路径对不上 → 403/404。
    """
    raw = Path(path)
    target = (raw if raw.is_absolute() else _project_root() / raw).resolve()
    if not target.exists():
        raise HTTPException(404)
    if job_id is not None:
        try:
            job = read_job(job_id)
        except FileNotFoundError as e:
            raise HTTPException(404, detail=f"找不到出图记录 {job_id}（可能已被删除）") from e
        whitelist = set(job.output_paths)
        params = job.params.model_dump() if job.params else {}
        for field in (
            "reference_images", "reference_videos", "reference_audios",
            "mask_image", "mj_sref", "mj_cref", "mj_oref",
        ):
            value = params.get(field)
            if isinstance(value, str):
                whitelist.add(value)
            elif isinstance(value, list):
                whitelist.update(item for item in value if isinstance(item, str))
        if job.source_image:
            whitelist.add(job.source_image)
        normalized_whitelist = {
            str((Path(p) if Path(p).is_absolute() else _project_root() / p).resolve())
            for p in whitelist
        }
        if str(target) not in normalized_whitelist:
            raise HTTPException(403, detail="读图被拒：这个路径不在该 job 登记的产物列表里")
        return FileResponse(str(target))
    uploads_dir = (_runtime() / "uploads").resolve()
    if str(target).startswith(str(uploads_dir) + os.sep):
        return FileResponse(str(target))
    cfg_path = _runtime() / "config.json"
    if not cfg_path.exists():
        raise HTTPException(
            403, detail="读图被拒：.runtime/config.json 不存在，无法确认这张图在允许的目录里"
        )
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = Path(cfg.get("image_storage_root", "")).resolve()
    # is_relative_to 带分隔符语义：/x/images-evil 不能过 /x/images（与 gallery_image 对齐）。
    if not target.is_relative_to(root):
        raise HTTPException(403, detail="读图被拒：这个路径在图片存储根目录之外")
    return FileResponse(str(target))


_IMAGE_UPLOAD_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
_VIDEO_UPLOAD_EXTS = {".mp4", ".webm", ".mov"}
_AUDIO_UPLOAD_EXTS = {".mp3", ".wav", ".m4a", ".aac"}
_UPLOAD_ALLOWED_EXTS = _IMAGE_UPLOAD_EXTS | _VIDEO_UPLOAD_EXTS | _AUDIO_UPLOAD_EXTS
_IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024  # 10MB — stills
_MEDIA_UPLOAD_MAX_BYTES = 100 * 1024 * 1024  # 100MB — video/audio reference assets


def _upload_max_bytes(ext: str) -> int:
    return _IMAGE_UPLOAD_MAX_BYTES if ext in _IMAGE_UPLOAD_EXTS else _MEDIA_UPLOAD_MAX_BYTES


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
    if ext not in _UPLOAD_ALLOWED_EXTS:
        raise HTTPException(422, detail=_ext_reject_detail(raw_name, ext, _UPLOAD_ALLOWED_EXTS))
    body = await file.read()
    limit = _upload_max_bytes(ext)
    if len(body) > limit:
        raise HTTPException(413, detail=_size_reject_detail(raw_name, body, limit))
    media_kind: Literal["image", "video", "audio"] = (
        "image" if ext in _IMAGE_UPLOAD_EXTS else "video" if ext in _VIDEO_UPLOAD_EXTS else "audio"
    )
    return raw_name, ext, body, media_kind


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


@router.post("/characters/{character_id}/gallery/{kind}")
async def post_gallery_image(
    character_id: str,
    kind: str,
    file: UploadFile = File(...),
) -> dict:
    """直接上传图片到角色图廊，落盘到 characters/<id>/<kind>/，并创建 done 状态 job。"""
    valid_kinds = {k.value for k in _AssetSlot}
    if kind not in valid_kinds:
        raise HTTPException(
            422,
            detail=f"图廊槽位「{kind}」不存在：只能是 {'/'.join(sorted(valid_kinds))}",
        )

    raw_name = file.filename or "upload"
    ext = Path(raw_name).suffix.lower()
    if ext not in _IMAGE_UPLOAD_EXTS:
        raise HTTPException(422, detail=_ext_reject_detail(raw_name, ext, _IMAGE_UPLOAD_EXTS))

    body = await file.read()
    if len(body) > _IMAGE_UPLOAD_MAX_BYTES:
        raise HTTPException(
            413, detail=_size_reject_detail(raw_name, body, _IMAGE_UPLOAD_MAX_BYTES)
        )

    job_id, target = await run_in_threadpool(_store_gallery_upload, character_id, kind, ext, body)
    return {"job_id": job_id, "path": str(target.resolve()), "filename": raw_name}


def _store_gallery_upload(
    character_id: str,
    kind: str,
    ext: str,
    body: bytes,
) -> tuple[str, Path]:
    out_dir = _project_root() / "characters" / character_id / kind
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    job_id = f"job-{ts}{uuid.uuid4().hex[:8]}"
    # 命名对齐 AI 出图规范：v1/v2/v3...，保留上传文件的原始扩展名
    n = 1
    while (out_dir / f"v{n}{ext}").exists():
        n += 1
    target = out_dir / f"v{n}{ext}"
    atomic_write_bytes(target, body)

    write_job(
        job_id=job_id,
        character_id=character_id,
        prompt="手动上传",
        model="manual",
        params={},
        asset_slot=_AssetSlot(kind),
    )
    update_job_status(job_id, status=JobStatus.DONE, output_paths=[str(target.resolve())])
    return job_id, target


@router.post("/characters", response_model=CharacterEntry)
def create_character(payload: CharacterCreate) -> CharacterEntry:
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail="角色名不能为空")
    if payload.project_id is not None:
        try:
            resolve_project(payload.project_id)
        except KeyError as error:
            raise HTTPException(404, detail="找不到当前项目（可能已被删除）") from error
    char_id = new_temporary_character_id()
    spec_content = f"# {name}\n\n（尚无档案 — 请在终端 /game-atelier:character 对话补全）\n"
    initialize_character_directory(char_id, spec_content)
    try:
        if payload.project_id is not None:
            assign_character(char_id, payload.project_id)
        write_active(char_id)
    except Exception:
        if payload.project_id is not None:
            try:
                assign_character(char_id, None)
            except Exception:
                logger.warning("回滚新角色项目归属失败: %s", char_id, exc_info=True)
        shutil.rmtree(data_root.characters_dir() / char_id, ignore_errors=True)
        raise
    return CharacterEntry(
        id=char_id, name=name, status="idle", latest_job_id=None, derivative=None,
    )


def _resolve_derivative_sources(
    source_character_id: str,
    project_id: str,
    requested_paths: list[str],
) -> list[Path]:
    from character_workflow.lib.canonical import read_canonical

    root = data_root.resolve_data_root().resolve()
    uploads = data_root.runtime_dir().resolve() / "uploads"
    canonical = read_canonical(source_character_id)
    raw_paths = [
        (entry.path, False)
        for entry in (canonical.portrait, canonical.promo, canonical.turnaround)
        if entry is not None
    ]
    raw_paths.extend((path, True) for path in requested_paths)

    resolved: list[Path] = []
    seen: set[Path] = set()
    for raw_path, required in raw_paths:
        candidate = Path(raw_path)
        absolute = (candidate if candidate.is_absolute() else root / candidate).resolve()
        if absolute in seen:
            continue
        if not absolute.is_file() and not required:
            continue
        if not absolute.is_file() or absolute.suffix.lower() not in _IMAGE_UPLOAD_EXTS:
            raise ValueError(f"找不到可用的衍生来源图片：{raw_path}")
        if absolute.is_relative_to(uploads):
            pass
        else:
            try:
                relative = absolute.relative_to(root).as_posix()
            except ValueError as error:
                raise ValueError("衍生来源必须来自当前项目或本次上传") from error
            if project_id_for_media_path(relative) != project_id:
                raise ValueError("衍生来源必须来自当前项目或本次上传")
        seen.add(absolute)
        resolved.append(absolute)
    return resolved


@router.post("/characters/{source_character_id}/derivatives", response_model=CharacterEntry)
def post_character_derivative(
    source_character_id: str,
    payload: CharacterDerivativeCreate,
) -> CharacterEntry:
    source_dir = data_root.characters_dir() / source_character_id
    if not (source_dir / "spec.md").is_file():
        raise HTTPException(404, detail=f"找不到来源角色 {source_character_id}")
    projects = read_projects()
    project_id = projects.assignments.get(source_character_id)
    if project_id is None:
        raise HTTPException(400, detail="来源角色必须先归属项目，才能创建衍生")
    try:
        source_paths = _resolve_derivative_sources(
            source_character_id,
            project_id,
            payload.source_paths,
        )
        derivative_id, derivative = create_character_derivative(
            source_character_id,
            payload.name,
            source_paths,
        )
    except FileNotFoundError as error:
        raise HTTPException(404, detail=f"找不到来源角色 {source_character_id}") from error
    except ValueError as error:
        raise HTTPException(400, detail=str(error)) from error
    try:
        write_active(derivative_id)
    except Exception:
        try:
            assign_character(derivative_id, None)
        except Exception:
            logger.warning("回滚角色衍生项目归属失败: %s", derivative_id, exc_info=True)
        shutil.rmtree(data_root.characters_dir() / derivative_id, ignore_errors=True)
        raise
    return CharacterEntry(
        id=derivative_id,
        name=payload.name,
        status="idle",
        latest_job_id=None,
        derivative=derivative,
    )


@router.delete("/characters/{character_id}")
def delete_character(character_id: str) -> dict:
    chars_dir = (_project_root() / "characters").resolve()
    target = (chars_dir / character_id).resolve()
    if not target.is_relative_to(chars_dir) or not target.is_dir():
        raise HTTPException(404, detail=f"找不到角色 {character_id}（目录不存在，可能已被删除）")
    shutil.rmtree(target)
    assign_character(character_id, None)
    if read_active().active_id == character_id:
        write_active(None)
    return {"ok": True, "id": character_id}


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


@router.get("/projects", response_model=ProjectsFile)
def get_projects() -> ProjectsFile:
    return read_projects()


@router.get("/projects/{project_id}/ui-schemes", response_model=UiSchemesFile)
def get_ui_schemes(
    project_id: str,
    visible_only: bool = Query(default=False),
) -> UiSchemesFile:
    from character_workflow.lib.ui_schemes import read_schemes, read_visible_schemes
    try:
        return read_visible_schemes(project_id) if visible_only else read_schemes(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.post("/projects/{project_id}/ui-schemes", response_model=UiSchemesFile)
def post_ui_scheme(project_id: str, payload: UiSchemeCreate) -> UiSchemesFile:
    from character_workflow.lib.ui_schemes import create_scheme
    try:
        return create_scheme(project_id, payload)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/projects/{project_id}/ui-schemes/default", response_model=UiSchemesFile)
def post_ui_scheme_default(project_id: str, payload: UiSchemeDefaultSet) -> UiSchemesFile:
    from character_workflow.lib.ui_schemes import set_default
    try:
        return set_default(project_id, payload.scheme_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/projects/{project_id}/workspaces", response_model=ProjectWorkspaceSummary)
def get_project_workspaces(
    project_id: str,
    ui_scheme: str | None = Query(default=None),
) -> ProjectWorkspaceSummary:
    from character_workflow.lib.workspace_summary import project_workspace_summary
    try:
        return project_workspace_summary(project_id, ui_scheme)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.get("/projects/{project_id}/videos", response_model=ProjectVideosResponse)
def get_project_videos(project_id: str) -> ProjectVideosResponse:
    from character_workflow.lib.video_jobs import list_productions
    try:
        return ProjectVideosResponse(productions=list_productions(project_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.get(
    "/projects/{project_id}/videos/{production_id}",
    response_model=ProjectVideoProduction,
)
def get_project_video(project_id: str, production_id: str) -> ProjectVideoProduction:
    from character_workflow.lib.video_jobs import get_production
    try:
        return get_production(project_id, production_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get(
    "/projects/{project_id}/video-references",
    response_model=ProjectVideoReferencesResponse,
)
def get_project_video_references(project_id: str) -> ProjectVideoReferencesResponse:
    from character_workflow.lib.video_jobs import list_reference_candidates
    try:
        return ProjectVideoReferencesResponse(candidates=list_reference_candidates(project_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.post(
    "/projects/{project_id}/videos/{production_id}/references",
    response_model=VideoReferencesResponse,
)
def post_project_video_references(
    project_id: str,
    production_id: str,
    payload: VideoReferencesSet,
) -> VideoReferencesResponse:
    from character_workflow.lib.video_jobs import set_references
    try:
        paths = set_references(project_id, production_id, payload.paths)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return VideoReferencesResponse(paths=paths)


class _VideoSelectedSet(BaseModel):
    model_config = {"extra": "forbid"}
    path: str | None = None


@router.post(
    "/projects/{project_id}/videos/{production_id}/selected",
    response_model=VideoSelectedResponse,
)
def post_project_video_selected(
    project_id: str,
    production_id: str,
    payload: _VideoSelectedSet,
) -> VideoSelectedResponse:
    from character_workflow.lib.video_jobs import set_selected
    try:
        selected = set_selected(project_id, production_id, payload.path)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return VideoSelectedResponse(path=selected)


@router.post("/projects", response_model=ProjectsFile)
def post_project(payload: ProjectCreate) -> ProjectsFile:
    create_project(payload.name)
    return read_projects()


@router.get("/projects/index", response_model=ProjectIndexResponse)
def get_project_index() -> ProjectIndexResponse:
    return project_index()


@router.get("/projects/{project_id}/gallery/media", response_model=GalleryMedia)
def get_project_gallery_media(
    project_id: str,
    path: str = Query(min_length=1),
) -> GalleryMedia:
    try:
        return project_gallery_media(project_id, path)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="找不到这个项目作品") from error


@router.get("/projects/{project_id}/gallery", response_model=ProjectGalleryResponse)
def get_project_gallery(
    project_id: str,
    category: str = Query(default="all"),
    limit: int = Query(default=40, ge=1, le=100),
    cursor: str | None = None,
) -> ProjectGalleryResponse:
    try:
        return project_gallery(project_id, category=category, limit=limit, cursor=cursor)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class ProjectReorder(BaseModel):
    ordered_ids: list[str]


@router.post("/projects/reorder", response_model=ProjectsFile)
def post_projects_reorder(payload: ProjectReorder) -> ProjectsFile:
    return reorder_projects(payload.ordered_ids)


@router.post("/projects/{project_id}/rename", response_model=ProjectsFile)
def post_project_rename(project_id: str, payload: ProjectRename) -> ProjectsFile:
    try:
        rename_project(project_id, payload.name)
    except KeyError as e:
        raise HTTPException(404, detail=f"找不到项目 {project_id}（可能已被删除）") from e
    return read_projects()


@router.delete("/projects/{project_id}", response_model=ProjectsFile)
def delete_project_route(project_id: str) -> ProjectsFile:
    delete_project(project_id)
    return read_projects()


class _ExperiencePatch(BaseModel):
    model_config = {"extra": "forbid"}
    project: str = Field(min_length=1)
    worldview_md: str


def _project_worldview_path(slug: str) -> Path:
    return data_root.projects_dir() / slug / "worldview.md"


@router.get("/experience")
def get_experience(project: str = Query(min_length=1)) -> dict:
    pf = read_projects()
    proj = next((p for p in pf.projects if p.id == project), None)
    if proj is None:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）")
    wv_path = _project_worldview_path(proj.slug)
    worldview_md = wv_path.read_text(encoding="utf-8") if wv_path.exists() else ""
    char_count = sum(1 for pid in pf.assignments.values() if pid == proj.id)
    return {
        "project": {
            "id": proj.id, "slug": proj.slug, "name": proj.name,
            "created_at": proj.created_at, "character_count": char_count,
        },
        "worldview_md": worldview_md,
    }


@router.post("/experience")
def post_experience(patch: _ExperiencePatch) -> dict:
    pf = read_projects()
    proj = next((p for p in pf.projects if p.id == patch.project), None)
    if proj is None:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）")
    wv_path = _project_worldview_path(proj.slug)
    wv_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(wv_path, patch.worldview_md)
    return {"ok": True}


@router.post("/characters/{character_id}/project", response_model=ProjectsFile)
def post_character_project(character_id: str, payload: CharacterProjectAssign) -> ProjectsFile:
    try:
        return assign_character(character_id, payload.project_id)
    except KeyError as e:
        raise HTTPException(
            404, detail=f"找不到项目 {payload.project_id}（可能已被删除）"
        ) from e


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
    - pending 且超过 STALE_PENDING_MINUTES：出图进程疑似已死 —— 标 FAILED 留痕。
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
        if is_resumable_studio_job(job):
            raise HTTPException(
                409,
                detail=(
                    "这笔厂商任务已经提交并可能已扣费，不能作废。系统会继续查询同一个任务，"
                    "不会重新下单；请等待恢复结果。"
                ),
            )
        age = _pending_age_minutes(job)
        if age is None or age >= STALE_PENDING_MINUTES:
            update_job_status(
                job_id, status=JobStatus.FAILED,
                error=f"cancelled: pending 超过 {STALE_PENDING_MINUTES} 分钟，疑似进程中断",
            )
            return {"ok": True, "job_id": job_id, "status": JobStatus.FAILED.value}
        raise HTTPException(
            409,
            detail=(
                f"这一单还在出图中（已等 {age:.0f} 分钟），不到 {STALE_PENDING_MINUTES} 分钟不能作废"
                " —— 过早作废会让真出完的图找不回来。请再等等，或到厂商后台确认。"
            ),
        )
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
    if "show_studio_on_home" in payload:
        value = payload["show_studio_on_home"]
        if not isinstance(value, bool):
            raise HTTPException(422, detail="show_studio_on_home 必须是布尔值（true / false）")
        cfg["show_studio_on_home"] = value
        updated = True
    if not updated:
        raise HTTPException(
            422, detail="没有可识别的设置项：只接受 image_storage_root / show_studio_on_home"
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


@router.post("/keys", status_code=201)
def create_key(payload: _KeyCreatePayload) -> dict:
    from datetime import datetime, timezone
    try:
        spec = keys.KeySpec(
            alias=payload.alias, provider=payload.provider,
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


def _extra_model_list_urls(models_url: str, provider: str) -> list[str]:
    """默认 /models 之外还需要拉的列表 URL。

    OpenRouter 实测（2026-08-13）：`GET /api/v1/models` 返回 409 条，里面**一个视频模型
    都没有**；23 个视频模型（veo / sora / kling / seedance / hailuo / runway…）只在
    `?output_modalities=video` 或 `/videos/models` 下列出。不额外拉这一次，OpenRouter key
    的用户在设置页永远拉不到视频模型、只能手填 id —— keys.json 里那几个就是这么来的。

    别把「默认端点里没有」当成「这个平台没有」：先按 host 试专用列表，再下结论。
    """
    host = urlsplit(models_url).netloc.lower()
    if "openrouter.ai" in host or provider == "openrouter":
        sep = "&" if "?" in models_url else "?"
        return [f"{models_url}{sep}output_modalities=video"]
    return []


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
    import requests

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

    url = base_url.rstrip("/")
    if not url.endswith("/models"):
        url = f"{url}/models"
    headers = {"Authorization": f"Bearer {access_key}"} if access_key else {}
    rows = _fetch_model_rows(url, headers)
    # 有些上游把视频模型排除在默认 /models 之外，必须额外拉一次才看得见（见下方函数注释）。
    # 额外列表拉不到不该让主列表失败：降级成「只有图片模型」，而不是整个功能报错。
    for extra_url in _extra_model_list_urls(url, preview_provider):
        try:
            rows = rows + _fetch_model_rows(extra_url, headers)
        except (HTTPException, requests.RequestException):
            pass

    from character_workflow.lib.callers.video_registry import resolve_protocol

    models = []
    seen_ids: set[str] = set()
    excluded = 0
    total = 0
    for item in rows:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        mid = str(item["id"])
        if mid in seen_ids:  # 聚合商常给同一模型挂多个别名条目
            continue
        seen_ids.add(mid)
        total += 1
        category = _classify_model(item)
        # 明确不能生成内容的模型不入列表；include_all 是逃生舱：
        # deny 词表哪天判过头了，画师能自己看到全量，不至于变成死路。
        if category == "excluded" and not payload.include_all:
            excluded += 1
            continue
        modality = category if category in ("text", "image", "video", "audio") else None
        # 视频：协议 guess（resolve 不中 → None，交后端 dispatch 时判定 / 诚实报错）。
        # 图片：直接读上游协议标注（决定走 Ark 原生端点还是 OpenAI 兼容入口）。
        if modality == "video":
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

    应用设置 show_studio_on_home 开启时，Studio 出图（studio/<job_id>/*）也混排进来。
    """
    characters_dir = _project_root() / "characters"
    items: list[dict] = []
    project_assignments = read_projects().assignments
    job_ids_by_path = _gallery_job_ids_by_path()
    hidden = set(_read_gallery_hidden())
    if characters_dir.exists():
        for char_dir in characters_dir.iterdir():
            if not char_dir.is_dir():
                continue
            for slot in _GALLERY_SLOTS:
                slot_dir = char_dir / slot
                if not slot_dir.is_dir():
                    continue
                for f in slot_dir.iterdir():
                    if f.suffix.lower() not in _GALLERY_EXTS:
                        continue
                    rel = f.relative_to(_project_root()).as_posix()
                    if rel in hidden:
                        continue  # 画师点过「隐藏」：工坊可见，首页作品展示不出
                    try:
                        mtime = f.stat().st_mtime
                    except OSError:
                        continue  # F3: broken symlink / permissions issue
                    items.append({
                        "character_id": char_dir.name,
                        "project_id": project_assignments.get(char_dir.name),
                        "asset_slot": slot,
                        "source": "character",
                        "filename": f.name,
                        "path": rel,
                        "job_id": job_ids_by_path.get(rel),
                        "mtime": mtime,
                    })
    studio_dir = _project_root() / "studio"
    if bool(_read_config().get("show_studio_on_home", False)) and studio_dir.exists():
        for job_dir in studio_dir.iterdir():
            if not job_dir.is_dir():
                continue
            for f in job_dir.iterdir():
                if f.suffix.lower() not in _GALLERY_EXTS:
                    continue
                rel = f.relative_to(_project_root()).as_posix()
                if rel in hidden:
                    continue
                try:
                    mtime = f.stat().st_mtime
                except OSError:
                    continue
                items.append({
                    "character_id": None,
                    "project_id": None,
                    "asset_slot": None,
                    "source": "studio",
                    "filename": f.name,
                    "path": rel,
                    # jobs 索引兜底目录名：studio 输出目录名即 job_id。
                    "job_id": job_ids_by_path.get(rel, job_dir.name),
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


@router.get("/gallery/screens")
def gallery_screens(
    project: str = Query(min_length=1),
    scheme: str = Query(min_length=1),
) -> dict:
    """项目 UI 方案下的页面版本图。

    扁平 items（前端按 screen_id 分组），组内/组间都最新在前。
    """
    pf = read_projects()
    proj = next((p for p in pf.projects if p.id == project), None)
    if proj is None:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）")
    from character_workflow.lib.ui_schemes import resolve_scheme, scheme_screens_dir
    try:
        _, ui_scheme = resolve_scheme(project, scheme)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    screens_dir = scheme_screens_dir(proj, ui_scheme.id)
    job_ids_by_path = _gallery_job_ids_by_path()
    # B3：风格候选的来源关系存在 job.params，前端并排对比按 style_variant 分列。
    jobs_by_id = {j.job_id: j for j in list_jobs()}
    items: list[dict] = []
    if screens_dir.is_dir():
        for screen_dir in screens_dir.iterdir():
            if not screen_dir.is_dir():
                continue
            for f in screen_dir.iterdir():
                if f.suffix.lower() not in _GALLERY_EXTS:
                    continue
                try:
                    mtime = f.stat().st_mtime
                except OSError:
                    continue
                rel = f.relative_to(_project_root()).as_posix()
                job_id = job_ids_by_path.get(rel)
                job = jobs_by_id.get(job_id) if job_id else None
                items.append({
                    "screen_id": screen_dir.name,
                    "filename": f.name,
                    "path": rel,
                    "job_id": job_id,
                    "style_variant": job.params.style_variant if job else None,
                    "base_version": job.params.base_version if job else None,
                    "model": job.model if job else None,
                    "provider": job.provider if job else None,
                    "prompt": job.prompt if job else None,
                    "mtime": mtime,
                })
    items.sort(key=lambda it: it["mtime"], reverse=True)
    return {"items": items}


def _gallery_hidden_file() -> Path:
    return _runtime() / "gallery-hidden.json"


def _read_gallery_hidden() -> list[str]:
    return read_gallery_hidden()


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
    project_id = project_id_for_media_path(target)
    if project_id is not None:
        touch_project(project_id)
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


def _gallery_job_ids_by_path() -> dict[str, str]:
    return gallery_job_ids_by_path()


@router.get("/gallery/image")
def gallery_image(path: str) -> FileResponse:
    """Serve gallery media from the explicit asset roots. Reject traversal."""
    root = _project_root()
    target = (root / path).resolve()
    characters_dir = (root / "characters").resolve()
    studio_dir = (root / "studio").resolve()
    projects_root = data_root.projects_dir().resolve()
    # projects 分支只放行 ui/<scheme>/screens 与 videos 资产（style/design 文档不可读）。
    project_parts = target.relative_to(projects_root).parts if target.is_relative_to(projects_root) else ()
    in_project_assets = (
        len(project_parts) >= 5
        and project_parts[1] == "ui"
        and project_parts[3] == "screens"
    ) or (
        len(project_parts) >= 5
        and project_parts[1] == "videos"
        and project_parts[3] == "versions"
        and target.suffix.lower() == ".mp4"
    )
    if not (
        target.is_relative_to(characters_dir)
        or target.is_relative_to(studio_dir)
        or in_project_assets
    ):
        raise HTTPException(status_code=400, detail="path outside allowed roots")
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)


class _StudioJobCreate(BaseModel):
    model_config = {"extra": "forbid"}
    prompt: str = Field(min_length=1)
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
    if body.kind not in {JobKind.IMAGE, JobKind.VIDEO}:
        raise HTTPException(422, detail="创作台目前只接受图片或视频任务")
    db = keys.read_keys_db()
    alias = body.alias or db.default_alias
    if not alias:
        raise HTTPException(status_code=400, detail="no default key configured")
    key_row = next((k for k in db.keys if k.alias == alias), None)
    if not key_row:
        raise HTTPException(status_code=400, detail=f"unknown alias {alias}")
    params = body.params.model_copy(deep=True)
    # Provider task handles are runner-owned.  A Studio create request always represents a new
    # order and may not attach itself to an arbitrary existing Tuzi task.
    params.provider_task_protocol = None
    params.provider_task_ids = None
    if body.kind == JobKind.IMAGE:
        image_count = params.n if params.n is not None else 1
        if image_count < 1 or image_count > 4:
            raise HTTPException(status_code=422, detail="params.n must be between 1 and 4")
        params.n = image_count

    job = Job(
        job_id=new_job_id(),
        character_id=alias,
        prompt=body.prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=body.model,
        params=params,
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        asset_slot=_AssetSlot.PORTRAIT,
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
        return Response(status_code=204)
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
    try:
        session = read_canvas_agent_session(project_id, session_id)
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
        raise HTTPException(409, detail=str(error)) from error
    if isinstance(error, (KeyError, FileNotFoundError)):
        raise HTTPException(404, detail="找不到这个创作资产或文件") from None
    if isinstance(error, ValueError):
        raise HTTPException(422, detail=str(error)) from error
    raise error


@router.get("/creation-assets", response_model=CreationAssetList)
def get_creation_assets(
    kind: Literal["prompt", "image"] | None = Query(default=None),
    scope: Literal["all", "project"] = Query(default="all"),
    project_id: str | None = Query(default=None),
):
    from character_workflow.lib.creation_assets import list_creation_assets
    try:
        return list_creation_assets(
            kind=kind,
            scope=scope,
            project_id=project_id,
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


@router.post("/creation-assets/images/from-path", response_model=CreationAsset, status_code=201)
def post_creation_image_from_path(payload: CreationImagePathCreate):
    from character_workflow.lib.creation_assets import create_image_asset_from_path
    try:
        return create_image_asset_from_path(
            title=payload.title,
            source_path=payload.source_path,
            tags=payload.tags,
            project_id=payload.project_id,
            allow_existing=payload.allow_existing,
        )
    except (FileNotFoundError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


@router.post("/creation-assets/images/upload", response_model=CreationAsset, status_code=201)
async def post_creation_image_upload(
    file: UploadFile = File(...),
    title: str = Form(...),
    tags: str = Form(default="[]"),
    project_id: str | None = Form(default=None),
    allow_existing: bool = Form(default=False),
):
    from character_workflow.lib.creation_assets import create_image_asset_from_bytes
    try:
        parsed_tags = json.loads(tags)
        if not isinstance(parsed_tags, list) or not all(isinstance(tag, str) for tag in parsed_tags):
            raise ValueError("tags 必须是字符串数组")
        return create_image_asset_from_bytes(
            title=title,
            body=await file.read(),
            filename=file.filename or "image",
            mime_type=file.content_type,
            tags=parsed_tags,
            project_id=project_id,
            allow_existing=allow_existing,
        )
    except (json.JSONDecodeError, KeyError, ValueError) as error:
        _raise_creation_asset_error(error)


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


@router.put("/creation-assets/{asset_id}/image", response_model=CreationAsset)
async def put_creation_image_asset(
    asset_id: str,
    title: str = Form(...),
    tags: str = Form(default="[]"),
    file: UploadFile | None = File(default=None),
):
    from character_workflow.lib.creation_assets import update_image_asset_from_bytes
    try:
        parsed_tags = json.loads(tags)
        if not isinstance(parsed_tags, list) or not all(isinstance(tag, str) for tag in parsed_tags):
            raise ValueError("tags 必须是字符串数组")
        body = await file.read() if file is not None else None
        return update_image_asset_from_bytes(
            asset_id,
            title=title,
            tags=parsed_tags,
            body=body,
            filename=file.filename or "image" if file is not None else "image",
            mime_type=file.content_type if file is not None else None,
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
    from character_workflow.lib.creation_assets import creation_asset_image_path
    try:
        return FileResponse(creation_asset_image_path(asset_id))
    except (KeyError, ValueError) as error:
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
    from character_workflow.lib.creation_assets import insert_creation_asset_into_canvas
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
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


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
            "upscale": "canvas_media_invalid_request",
        }.get(operation_kind, "canvas_media_invalid_request")
        raise HTTPException(422, detail={
            "code": error_code,
            "message": "图片处理参数无效，请检查选区、切线或放大设置。",
        }) from None

    try:
        return await run_in_threadpool(execute_canvas_media_operation, project_id, request)
    except CanvasMediaOperationError as error:
        status = 404 if error.code == "canvas_media_source_missing" else 422
        raise HTTPException(
            status,
            detail={"code": error.code, "message": error.message},
        ) from error
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
    "/canvas/projects/{project_id}/runs/mask-edit",
    response_model=CanvasRunResponse,
    status_code=201,
)
async def post_canvas_mask_edit(
    project_id: str,
    background: BackgroundTasks,
    surface_node_id: str = Form(...),
    expected_revision: int = Form(...),
    requested_count: int = Form(1),
    mask_file: UploadFile = File(...),
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_masks import CanvasMaskError
    from character_workflow.lib.canvas_runs import CanvasRunCommandError, submit_mask_edit_run

    try:
        payload = CanvasMaskEditCreate(
            surface_node_id=surface_node_id,
            expected_revision=expected_revision,
            requested_count=requested_count,
        )
        body = await mask_file.read(25 * 1024 * 1024 + 1)
        job, document = await run_in_threadpool(
            submit_mask_edit_run,
            project_id,
            payload.surface_node_id,
            payload.expected_revision,
            payload.requested_count,
            body,
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
    "/canvas/projects/{project_id}/runs/{run_id}/retry",
    response_model=CanvasRunResponse,
    status_code=201,
)
def post_canvas_run_retry(
    project_id: str,
    run_id: str,
    payload: CanvasRunRetry,
    background: BackgroundTasks,
) -> CanvasRunResponse:
    from character_workflow.lib.canvas_runs import retry_canvas_run

    try:
        job, document = retry_canvas_run(
            project_id,
            run_id,
            payload.expected_revision,
        )
    except KeyError:
        raise HTTPException(404, detail="找不到这个生成记录") from None
    except RuntimeError as error:
        detail = str(error)
        if detail.startswith("revision_conflict:"):
            current_revision = int(detail.split(":", 1)[1])
            raise HTTPException(409, detail={
                "code": "revision_conflict",
                "current_revision": current_revision,
            }) from None
        messages = {
            "run_not_terminal": (
                "当前生成尚未结束，不能重试",
                "等待当前生成结束，或先停止生成。",
            ),
            "result_node_missing": (
                "原结果节点已被删除，不能在原位置重试",
                "恢复结果节点，或新建生成节点后重新提交。",
            ),
        }
        message, recovery = messages.get(detail, (detail, "检查画布当前状态后重试。"))
        raise HTTPException(409, detail={
            "code": detail,
            "message": message,
            "recovery": recovery,
        }) from error
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


class _CharacterArchiveTarget(BaseModel):
    model_config = {"extra": "forbid"}
    kind: Literal["character"]
    character_id: str = Field(min_length=1)
    asset_slot: _AssetSlot


class _UiArchiveTarget(BaseModel):
    model_config = {"extra": "forbid"}
    kind: Literal["ui"]
    ui_scheme_id: str = Field(min_length=1)
    screen_id: str = Field(min_length=1)


class _VideoArchiveTarget(BaseModel):
    model_config = {"extra": "forbid"}
    kind: Literal["video"]
    production_id: str = Field(min_length=1)


_StudioArchiveTarget = Annotated[
    _CharacterArchiveTarget | _UiArchiveTarget | _VideoArchiveTarget,
    Field(discriminator="kind"),
]


class _StudioArchiveRequest(BaseModel):
    model_config = {"extra": "forbid"}
    source_path: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    target: _StudioArchiveTarget


@router.get("/projects/{project_id}/studio-archive-targets")
def get_studio_archive_targets(
    project_id: str,
    media_kind: JobKind = Query(),
) -> dict:
    from character_workflow.lib.studio_archive import list_archive_targets

    try:
        return {"targets": list_archive_targets(project_id, media_kind)}
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.post("/studio/jobs/{job_id}/archive", status_code=201)
def post_studio_archive(job_id: str, body: _StudioArchiveRequest) -> dict:
    from character_workflow.lib.studio_archive import archive_studio_output

    try:
        job = archive_studio_output(
            job_id,
            body.source_path,
            body.project_id,
            body.target.model_dump(mode="json"),
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"job": job.model_dump(mode="json"), "path": job.output_paths[0]}


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
