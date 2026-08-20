"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from character_workflow.lib import data_root, keys
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.atomic_io import (
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
)
from character_workflow.lib.job_runner import image_dimensions_from_bytes
from character_workflow.lib.jobs import (
    _load_job, delete_failed_job, job_lock, list_jobs, read_job, remove_image_from_job,
    save_job, update_job_status, write_job,
)
from character_workflow.lib.schemas import AssetSlot as _AssetSlot
from character_workflow.lib.projects import (
    assign_character, create_project, delete_project, read_projects,
    rename_project, reorder_projects,
)
from pydantic import BaseModel, Field, ValidationError
from pydantic import field_validator

from character_workflow.lib.schemas import (
    ActiveCharacterFile, CanonicalSet, CanonicalStatusFile, CharacterEntry,
    CharacterProjectAssign, ClipboardAttempt,
    FeedbackPost, Job, JobKind, JobParams, JobStatus, ProjectCreate, ProjectRename,
    ProjectVideosResponse, ProjectWorkspaceSummary, ProjectsFile,
    ScreenCanonicalSet, ScreenCanonicalStatusFile, SpecPatch, VideoSelectedResponse,
    WebEditableJobPatch,
)


logger = logging.getLogger(__name__)


class CharacterCreate(BaseModel):
    name: str


def _display_name(spec_path: Path) -> str:
    """Parse display name from spec.md: YAML frontmatter `name:` first, then `# heading`."""
    try:
        text = spec_path.read_text(encoding="utf-8")
        # YAML frontmatter: ---\n...\nname: <value>\n...\n---
        if text.startswith("---"):
            end = text.find("\n---", 3)
            if end != -1:
                frontmatter = text[3:end]
                m = re.search(r"^name:\s*(.+?)\s*$", frontmatter, re.MULTILINE)
                if m:
                    return m.group(1)
        # Legacy: first `# heading`
        for line in text.splitlines()[:20]:
            m = re.match(r"^#\s+(.+?)\s*$", line)
            if m:
                return m.group(1)
    except OSError:
        pass
    # Last resort: parent dir name (character id)
    return spec_path.parent.name


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
            id=d.name, name=_display_name(spec), status="idle", latest_job_id=None,
            thumbnail=_latest_portrait(d, root),
        ))
    return out


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


@router.get("/projects/{project_id}/screens/canonical", response_model=ScreenCanonicalStatusFile)
def get_screen_canonical(project_id: str) -> ScreenCanonicalStatusFile:
    from character_workflow.lib import stale
    try:
        return stale.screen_canonical_status(project_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个项目（可能已被删除）")


@router.post("/projects/{project_id}/screens/canonical", response_model=ScreenCanonicalStatusFile)
def post_screen_canonical(project_id: str, payload: ScreenCanonicalSet) -> ScreenCanonicalStatusFile:
    """选定 / 取消某 screen 的风格定稿（B3）。path=None 取消。style_variant 从 job 反查，不用前端报。"""
    from character_workflow.lib import stale, ui_jobs
    try:
        if payload.path is None:
            ui_jobs.clear_screen_canonical(project_id, payload.screen_id)
        else:
            ui_jobs.set_screen_canonical(project_id, payload.screen_id, payload.path)
        return stale.screen_canonical_status(project_id)
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
        for field, value in patch.model_dump(exclude_unset=True).items():
            data[field] = value
        atomic_write_json(p, data)
    return {"ok": True}


@router.post("/feedback")
def post_feedback(payload: FeedbackPost) -> dict:
    draft_dir = _runtime() / "draft"
    draft_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    p = draft_dir / f"{ts}.md"
    body = payload.text
    if payload.character_id:
        body = f"<!-- character: {payload.character_id} -->\n{body}"
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
            "mj_sref", "mj_cref", "mj_oref",
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


@router.post("/uploads")
async def post_upload(file: UploadFile = File(...)) -> dict:
    """画师在 Web 上传源图 → .runtime/uploads/<uuid><ext>。
    返回的 path 可直接拼到 `/game-atelier:promo <id> --upload <path>` 复制命令里，
    Skill 拿到后将其挪到 characters/<id>/source/。
    """
    raw_name = file.filename or "upload"
    ext = Path(raw_name).suffix.lower()
    if ext not in _UPLOAD_ALLOWED_EXTS:
        raise HTTPException(422, detail=_ext_reject_detail(raw_name, ext, _UPLOAD_ALLOWED_EXTS))
    body = await file.read()
    limit = _upload_max_bytes(ext)
    if len(body) > limit:
        raise HTTPException(413, detail=_size_reject_detail(raw_name, body, limit))
    uploads = _runtime() / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    target = uploads / name
    atomic_write_bytes(target, body)
    return {"path": str(target.resolve()), "filename": raw_name}


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

    return {"job_id": job_id, "path": str(target.resolve()), "filename": raw_name}


@router.post("/characters", response_model=CharacterEntry)
def create_character(payload: CharacterCreate) -> CharacterEntry:
    import time as _time
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail="角色名不能为空")
    char_id = f"char-{int(_time.time())}"
    root = _project_root() / "characters" / char_id
    for sub in ("portrait", "promo", "turnaround", "source"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    spec_content = f"# {name}\n\n（尚无档案 — 请在终端 /game-atelier:character 对话补全）\n"
    (root / "spec.md").write_text(spec_content, encoding="utf-8")
    write_active(char_id)
    return CharacterEntry(id=char_id, name=name, status="idle", latest_job_id=None)


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


@router.get("/projects/{project_id}/workspaces", response_model=ProjectWorkspaceSummary)
def get_project_workspaces(project_id: str) -> ProjectWorkspaceSummary:
    from character_workflow.lib.workspace_summary import project_workspace_summary
    try:
        return project_workspace_summary(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


@router.get("/projects/{project_id}/videos", response_model=ProjectVideosResponse)
def get_project_videos(project_id: str) -> ProjectVideosResponse:
    from character_workflow.lib.video_jobs import list_productions
    try:
        return ProjectVideosResponse(productions=list_productions(project_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None


class _VideoSelectedSet(BaseModel):
    model_config = {"extra": "forbid"}
    path: str | None = None


@router.post(
    "/projects/{project_id}/videos/{production_id}/shots/{shot_id}/selected",
    response_model=VideoSelectedResponse,
)
def post_project_video_selected(
    project_id: str,
    production_id: str,
    shot_id: str,
    payload: _VideoSelectedSet,
) -> VideoSelectedResponse:
    from character_workflow.lib.video_jobs import set_selected
    try:
        selected = set_selected(project_id, production_id, shot_id, payload.path)
    except KeyError:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）") from None
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return VideoSelectedResponse(shots=selected)


@router.post("/projects", response_model=ProjectsFile)
def post_project(payload: ProjectCreate) -> ProjectsFile:
    create_project(payload.name)
    return read_projects()


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
    if payload.project_id is not None:
        try:
            return assign_character(character_id, payload.project_id)
        except KeyError as e:
            raise HTTPException(404, detail=f"找不到项目 {payload.project_id}（可能已被删除）") from e
    return assign_character(character_id, None)


# job 状态 → 中文（报错里给画师看，别把 pending_confirm 这种内部枚举原样丢出去）
_STATUS_CN = {
    "pending_confirm": "等待确认出图",
    "pending": "正在出图",
    "done": "已完成",
    "failed": "已失败",
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
    title: str = "选择项目文件夹"
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
    # 逃生舱：连明确判定为非视觉的模型也一并返回（deny 词表判过头时用）。
    include_all: bool = False


# 模型分类：image / video / unknown / excluded。
#
# excluded 是**唯一**授权丢弃的类别，条件很窄：上游明确标注了协议、且每一条协议都是非视觉。
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
# 协议动词（冒号后半段）判视觉；seedance:generations 这类动词无信息量，靠厂商前缀兜。
_PROTOCOL_IMAGE_HINTS = (
    "image-generations", "image-generation", "images", "image-edits", "images-edits",
    "image2image", "t2i", "text2image",
)
_PROTOCOL_VIDEO_HINTS = (
    "video", "seedance", "vidu", "happyhorse", "t2v", "i2v", "r2v",
    "text2video", "image2video",
)
# 明确非视觉的协议动词：全部命中才判 excluded。
_PROTOCOL_NON_VISUAL_HINTS = (
    "chat-completions", "completions", "responses", "messages", "embeddings", "rerank",
    "moderations", "t2a", "tts", "asr", "speech", "audio", "transcriptions", "translations",
    "voice_clone", "web-search", "web-reader", "search", "layout-parsing", "ocr",
)


def _id_hits(mid: str, hints: tuple[str, ...]) -> bool:
    """id 关键词按**词边界**匹配 —— 裸子串会把 `inkling`（纯文本）判成 kling 视频、
    把 `wanx`（通义万相，图像）判成视频。前后不许紧邻字母数字。"""
    return any(re.search(rf"(?<![a-z0-9]){re.escape(h)}(?![a-z0-9])", mid) for h in hints)


def _classify_model(item: dict) -> str:
    """返回 image / video / unknown / excluded —— 只有 excluded 会被过滤掉。"""
    protocols = [str(p).lower() for p in (item.get("supported_protocols") or [])]
    if any(h in p for p in protocols for h in _PROTOCOL_IMAGE_HINTS):
        return "image"
    if any(h in p for p in protocols for h in _PROTOCOL_VIDEO_HINTS):
        return "video"
    # 每一条协议都是非视觉才排除；混合标注（含一条看不懂的）保守留下。
    if protocols and all(
        any(h in p for h in _PROTOCOL_NON_VISUAL_HINTS) for p in protocols
    ):
        return "excluded"

    # OpenRouter 等不给 supported_protocols，但给 architecture.output_modalities —— 这是
    # 权威字段，必须排在 id 猜测之前（实测它能修好 openrouter/auto、干掉 inkling 假阳性）。
    arch = item.get("architecture")
    out = {str(m).lower() for m in (arch or {}).get("output_modalities") or []} if isinstance(arch, dict) else set()
    if "video" in out:
        return "video"
    if "image" in out:
        return "image"
    if out and not (out & {"image", "video"}):
        # 上游明说输出里没有图也没有视频（纯文本 / 纯音频）——它自己声明的，可以信。
        return "excluded"

    mid = str(item.get("id") or "").lower()
    if _id_hits(mid, _VIDEO_ID_HINTS):
        return "video"
    if _id_hits(mid, _IMAGE_ID_HINTS):
        return "image"
    return "unknown"


def _guess_model_modality(item: dict) -> str | None:
    """分类结果里只有 image / video 能当 modality；unknown 交给画师标，excluded 不入列表。"""
    category = _classify_model(item)
    return category if category in ("image", "video") else None


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
        # 明确的非视觉模型不入列表：一把词元跳动 key 上游有 78 个模型，其中 61 个是对话 /
        # 语音 / 搜索类，全塞进选择器只会淹掉那 17 个真正能出图出片的。include_all 是逃生舱：
        # deny 词表哪天判过头了，画师能自己看到全量，不至于变成死路。
        if category == "excluded" and not payload.include_all:
            excluded += 1
            continue
        modality = category if category in ("image", "video") else None
        # 视频：协议 guess（resolve 不中 → None，交后端 dispatch 时判定 / 诚实报错）。
        # 图片：直接读上游协议标注（决定走 Ark 原生端点还是 OpenAI 兼容入口）。
        if modality == "video":
            protocol = resolve_protocol(preview_provider, base_url, mid)
        elif modality == "image":
            protocol = _image_protocol(item)
        else:
            protocol = None
        models.append({
            "id": mid,
            "name": str(item.get("name") or mid),
            "modality": modality,
            # unknown 与 excluded 都要能被前端区分：前者是「需要你确认」，不是「其他垃圾」。
            "category": category,
            "protocol": protocol,
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


@router.get("/gallery/project")
def gallery_project(project: str = Query(min_length=1)) -> dict:
    """项目作品：assignments 反查该项目的角色 → 各角色三槽的图。

    已隐藏的不出（与首页作品展示同语义），最新在前。
    """
    pf = read_projects()
    proj = next((p for p in pf.projects if p.id == project), None)
    if proj is None:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）")
    member_ids = [cid for cid, pid in pf.assignments.items() if pid == proj.id]
    hidden = set(_read_gallery_hidden())
    job_ids_by_path = _gallery_job_ids_by_path()
    items: list[dict] = []
    for char_id in member_ids:
        char_dir = _project_root() / "characters" / char_id
        if not char_dir.is_dir():
            continue
        char_name = _display_name(char_dir / "spec.md")
        for slot in _GALLERY_SLOTS:
            slot_dir = char_dir / slot
            if not slot_dir.is_dir():
                continue
            for f in slot_dir.iterdir():
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
                    "character_id": char_id,
                    "character_name": char_name,
                    "asset_slot": slot,
                    "source": "character",
                    "filename": f.name,
                    "path": rel,
                    "job_id": job_ids_by_path.get(rel),
                    "mtime": mtime,
                })
    items.sort(key=lambda it: it["mtime"], reverse=True)
    return {"items": items}


@router.get("/gallery/screens")
def gallery_screens(project: str = Query(min_length=1)) -> dict:
    """B2 项目页「页面」区：projects/<slug>/screens/<screen-id>/ 下的 UI 页面图。

    扁平 items（前端按 screen_id 分组），组内/组间都最新在前。
    """
    pf = read_projects()
    proj = next((p for p in pf.projects if p.id == project), None)
    if proj is None:
        raise HTTPException(status_code=404, detail="找不到这个项目（可能已被删除）")
    screens_dir = data_root.projects_dir() / proj.slug / "screens"
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
    p = _gallery_hidden_file()
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


def _gallery_job_ids_by_path() -> dict[str, str]:
    root = _project_root()
    result: dict[str, str] = {}
    try:
        jobs = list_jobs()
    except Exception:
        return result
    for job in jobs:
        for raw_path in job.output_paths:
            path = Path(raw_path)
            absolute = path if path.is_absolute() else root / path
            try:
                relative = absolute.resolve().relative_to(root).as_posix()
            except ValueError:
                relative = raw_path
            result.setdefault(raw_path, job.job_id)
            result.setdefault(str(absolute.resolve()), job.job_id)
            result.setdefault(relative, job.job_id)
    return result


@router.get("/gallery/image")
def gallery_image(path: str) -> FileResponse:
    """Serve image files under characters/*, studio/* or projects/*/screens/*. Rejects traversal."""
    root = _project_root()
    target = (root / path).resolve()
    characters_dir = (root / "characters").resolve()
    studio_dir = (root / "studio").resolve()
    projects_root = data_root.projects_dir().resolve()
    # projects 分支只放行 screens / videos 资产子树（style.md / design 文档不得经此外读）。
    project_parts = target.relative_to(projects_root).parts if target.is_relative_to(projects_root) else ()
    in_project_assets = (
        len(project_parts) >= 3
        and project_parts[1] == "screens"
    ) or (
        len(project_parts) >= 5
        and project_parts[1] == "videos"
        and project_parts[3] in {"shots", "exports"}
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


def _run_studio_job_safely(job_id: str) -> None:
    """BackgroundTasks wrapper — runs job_runner.run_job and pins failures to job state.

    Lazy import keeps test monkeypatching (`routes._run_studio_job_safely`) effective
    and avoids importing the caller chain at module load.
    """
    from character_workflow.lib.job_runner import run_job
    try:
        run_job(job_id)
    except Exception as e:  # noqa: BLE001
        # run_job already calls update_job_status(FAILED) on its own exception path,
        # but guard against any uncaught path (e.g., raised before its try block).
        try:
            job = read_job(job_id)
        except FileNotFoundError:
            return
        if job.status != JobStatus.DONE and job.status != JobStatus.FAILED:
            update_job_status(job_id, status=JobStatus.FAILED, error=str(e))


@router.post("/studio/jobs", status_code=201)
def create_studio_job(body: _StudioJobCreate, background: BackgroundTasks) -> dict:
    """Create a standalone studio job (namespace='studio') and schedule the runner.

    Skips pending_confirm — UI submit is the explicit user consent.
    Output will be written to <data_root>/studio/<job_id>/ when run.
    Both IMAGE and VIDEO kinds are accepted; only IMAGE enforces params.n ∈ [1, 4].

    The runner is fired via BackgroundTasks so the response returns immediately;
    the UI then polls /api/jobs/<id> to observe status transitions.
    """
    db = keys.read_keys_db()
    alias = body.alias or db.default_alias
    if not alias:
        raise HTTPException(status_code=400, detail="no default key configured")
    key_row = next((k for k in db.keys if k.alias == alias), None)
    if not key_row:
        raise HTTPException(status_code=400, detail=f"unknown alias {alias}")
    params = body.params.model_copy(deep=True)
    if body.kind == JobKind.IMAGE:
        image_count = params.n if params.n is not None else 1
        if image_count < 1 or image_count > 4:
            raise HTTPException(status_code=422, detail="params.n must be between 1 and 4")
        params.n = image_count

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    job_id = f"job-{ts}{uuid.uuid4().hex[:8]}"

    job = Job(
        job_id=job_id,
        character_id=alias,  # placeholder for non-null invariant; runner reads namespace
        prompt=body.prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=body.model,
        params=params,
        output_paths=[],
        status=JobStatus.PENDING,  # Studio skips pending_confirm (UI submit = explicit consent)
        error=None,
        asset_slot=_AssetSlot.PORTRAIT,  # ignored when namespace="studio"
        kind=body.kind,
        namespace="studio",
        alias=alias,
        provider=key_row.provider,
    )
    save_job(job)
    # Dispatch through module-level symbol so tests can monkeypatch routes._run_studio_job_safely.
    from viewer_server import routes as _self
    background.add_task(_self._run_studio_job_safely, job.job_id)
    return job.model_dump(mode="json")
