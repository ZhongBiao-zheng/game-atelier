"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from character_workflow.lib import data_root, keys
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.jobs import (
    delete_failed_job, list_jobs, read_job, remove_image_from_job, save_job,
    update_job_status, write_job,
)
from character_workflow.lib.schemas import AssetSlot as _AssetSlot
from character_workflow.lib.projects import (
    assign_character, create_project, delete_project, read_projects,
    rename_project, reorder_projects,
)
from pydantic import BaseModel, Field
from pydantic import field_validator

from character_workflow.lib.schemas import (
    ActiveCharacterFile, CharacterEntry, CharacterProjectAssign, ClipboardAttempt,
    FeedbackPost, Job, JobKind, JobParams, JobStatus, ProjectCreate, ProjectRename,
    ProjectsFile, SpecPatch, WebEditableJobPatch,
)


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
        out.append(Job.model_validate(json.loads(p.read_text(encoding="utf-8"))))
    return out


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str) -> Job:
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"job {job_id} not found")
    return Job.model_validate(json.loads(p.read_text(encoding="utf-8")))


@router.get("/spec/{character_id}")
def get_spec(character_id: str) -> dict:
    p = _project_root() / "characters" / character_id / "spec.md"
    if not p.exists():
        raise HTTPException(404, detail=f"spec {character_id} not found")
    return {"content": p.read_text(encoding="utf-8")}


@router.get("/characters", response_model=list[CharacterEntry])
def get_characters() -> list[CharacterEntry]:
    chars_dir = _project_root() / "characters"
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
        ))
    return out


@router.get("/home")
def get_home() -> dict:
    return {"home": str(Path.home())}


@router.post("/characters/{character_id}/rename")
def rename_character(character_id: str, payload: dict = Body(...)) -> dict:
    new_name = (payload.get("name") or "").strip()
    if not new_name:
        raise HTTPException(422, detail="name required")
    if "\n" in new_name or len(new_name) > 80:
        raise HTTPException(422, detail="name too long or contains newline")
    p = _project_root() / "characters" / character_id / "spec.md"
    if not p.exists():
        raise HTTPException(404, detail=f"character {character_id} not found")
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
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    tmp.replace(p)
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
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("character_id") == character:
                paths.extend(data.get("output_paths", []))
    return {"character_id": character, "output_paths": paths}


@router.get("/config")
def get_config() -> dict:
    p = _runtime() / "config.json"
    if not p.exists():
        return {"image_storage_root": str(_project_root())}
    return json.loads(p.read_text(encoding="utf-8"))


@router.post("/spec/{character_id}")
def post_spec(character_id: str, patch: SpecPatch) -> dict:
    p = _project_root() / "characters" / character_id / "spec.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(patch.content, encoding="utf-8")
    tmp.replace(p)
    write_active(character_id)
    return {"ok": True, "path": str(p)}


@router.post("/prompt/{job_id}")
def post_prompt(job_id: str, patch: WebEditableJobPatch) -> dict:
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"job {job_id} not found")
    data = json.loads(p.read_text(encoding="utf-8"))
    for field, value in patch.model_dump(exclude_unset=True).items():
        data[field] = value
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
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
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(p)
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
    """
    target = Path(path).resolve()
    if not target.exists():
        raise HTTPException(404)
    if job_id is not None:
        try:
            job = read_job(job_id)
        except FileNotFoundError as e:
            raise HTTPException(404, detail=f"job {job_id} not found") from e
        whitelist = set(job.output_paths)
        refs = (job.params.model_dump().get("reference_images") or []) if job.params else []
        whitelist.update(refs)
        if job.source_image:
            whitelist.add(job.source_image)
        if str(target) not in {str(Path(p).resolve()) for p in whitelist}:
            raise HTTPException(403, detail="path not in job whitelist")
        return FileResponse(str(target))
    uploads_dir = (_runtime() / "uploads").resolve()
    if str(target).startswith(str(uploads_dir) + os.sep):
        return FileResponse(str(target))
    cfg_path = _runtime() / "config.json"
    if not cfg_path.exists():
        raise HTTPException(403, detail="config missing")
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = Path(cfg.get("image_storage_root", "")).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(403, detail="path outside image_storage_root")
    return FileResponse(str(target))


_UPLOAD_ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
_UPLOAD_MAX_BYTES = 10 * 1024 * 1024  # 10MB


@router.post("/uploads")
async def post_upload(file: UploadFile = File(...)) -> dict:
    """画师在 Web 上传源图 → .runtime/uploads/<uuid><ext>。
    返回的 path 可直接拼到 `/game-atelier:promo <id> --upload <path>` 复制命令里，
    Skill 拿到后将其挪到 characters/<id>/source/。
    """
    raw_name = file.filename or "upload"
    ext = Path(raw_name).suffix.lower()
    if ext not in _UPLOAD_ALLOWED_EXTS:
        raise HTTPException(422, detail=f"extension {ext or '(none)'} not allowed")
    body = await file.read()
    if len(body) > _UPLOAD_MAX_BYTES:
        raise HTTPException(413, detail=f"file too large: {len(body)} bytes (limit {_UPLOAD_MAX_BYTES})")
    uploads = _runtime() / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    target = uploads / name
    tmp = target.with_suffix(ext + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(target)
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
        raise HTTPException(422, detail=f"kind must be one of {sorted(valid_kinds)}")

    raw_name = file.filename or "upload"
    ext = Path(raw_name).suffix.lower()
    if ext not in _UPLOAD_ALLOWED_EXTS:
        raise HTTPException(422, detail=f"extension {ext or '(none)'} not allowed")

    body = await file.read()
    if len(body) > _UPLOAD_MAX_BYTES:
        raise HTTPException(413, detail=f"file too large: {len(body)} bytes (limit {_UPLOAD_MAX_BYTES})")

    out_dir = _project_root() / "characters" / character_id / kind
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    job_id = f"job-{ts}{uuid.uuid4().hex[:8]}"
    # 命名对齐 AI 出图规范：v1/v2/v3...，保留上传文件的原始扩展名
    n = 1
    while (out_dir / f"v{n}{ext}").exists():
        n += 1
    target = out_dir / f"v{n}{ext}"
    tmp = target.with_suffix(ext + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(target)

    write_job(
        job_id=job_id,
        character_id=character_id,
        prompt="手动上传",
        model="manual",
        params={},
        seed=None,
        asset_slot=_AssetSlot(kind),
    )
    update_job_status(job_id, status=JobStatus.DONE, output_paths=[str(target.resolve())])

    return {"job_id": job_id, "path": str(target.resolve()), "filename": raw_name}


@router.post("/characters", response_model=CharacterEntry)
def create_character(payload: CharacterCreate) -> CharacterEntry:
    import time as _time
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail="name required")
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
        raise HTTPException(404, detail=f"character {character_id} not found")

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
        raise HTTPException(404, detail=f"job {job_id} not found") from e
    except ValueError as e:
        raise HTTPException(404, detail=str(e)) from e
    return {"ok": True}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    try:
        delete_failed_job(job_id)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=f"job {job_id} not found") from e
    except ValueError as e:
        raise HTTPException(409, detail=str(e)) from e
    return {"ok": True}


@router.get("/projects", response_model=ProjectsFile)
def get_projects() -> ProjectsFile:
    return read_projects()


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
        raise HTTPException(404, detail=f"project {project_id} not found") from e
    return read_projects()


@router.delete("/projects/{project_id}", response_model=ProjectsFile)
def delete_project_route(project_id: str) -> ProjectsFile:
    delete_project(project_id)
    return read_projects()


@router.post("/characters/{character_id}/project", response_model=ProjectsFile)
def post_character_project(character_id: str, payload: CharacterProjectAssign) -> ProjectsFile:
    if payload.project_id is not None:
        try:
            return assign_character(character_id, payload.project_id)
        except KeyError as e:
            raise HTTPException(404, detail=f"project {payload.project_id} not found") from e
    return assign_character(character_id, None)


@router.post("/jobs/{job_id}/confirm")
def post_job_confirm(job_id: str) -> dict:
    """画师在 Web 端点了"出图"按钮 —— 把 pending_confirm 推到 pending。
    Skill 自己在终端轮询 / SSE 监听 job-changed，看见 pending 就动手。"""
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"job {job_id} not found")
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("status") != JobStatus.PENDING_CONFIRM.value:
        raise HTTPException(409, detail=f"job not in pending_confirm (current: {data.get('status')})")
    data["status"] = JobStatus.PENDING.value
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return {"ok": True, "job_id": job_id, "status": JobStatus.PENDING.value}


@router.post("/jobs/{job_id}/cancel")
def post_job_cancel(job_id: str) -> dict:
    """画师不要这版 prompt —— 直接删 json 文件。
    pending_confirm 从未真出图，留 FAILED 残骸会让 Web 把"作废的 prompt"误显示成"出图失败"。"""
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"job {job_id} not found")
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("status") != JobStatus.PENDING_CONFIRM.value:
        raise HTTPException(409, detail=f"job not in pending_confirm (current: {data.get('status')})")
    p.unlink()
    return {"ok": True, "job_id": job_id, "deleted": True}


@router.post("/config")
def post_config(payload: dict = Body(...)) -> dict:
    raw = (payload.get("image_storage_root") or "").strip()
    if not raw:
        raise HTTPException(422, detail="image_storage_root required")
    # Expand ~ and env vars; resolve to absolute path so future reads are stable.
    expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
    try:
        expanded.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(422, detail=f"无法创建目录：{e}") from e
    if not os.access(expanded, os.W_OK):
        raise HTTPException(422, detail=f"目录不可写：{expanded}")
    resolved = str(expanded.resolve())
    cfg_path = _runtime() / "config.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"image_storage_root": resolved}, indent=2))
    tmp.replace(cfg_path)
    return {"ok": True, "image_storage_root": resolved}


class _DataRootPayload(BaseModel):
    path: str


class _FolderPickerPayload(BaseModel):
    title: str = "选择项目文件夹"
    initial_path: str | None = None


def _osascript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _bootstrap_script() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "bootstrap.py"


@router.get("/onboarding/status")
def onboarding_status() -> dict:
    """Proxies `bootstrap.py --check` so Web 不用知道状态机细节。"""
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--check"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"bootstrap --check failed: {proc.stderr}")
    return json.loads(proc.stdout)


@router.post("/folder-picker")
def folder_picker(payload: _FolderPickerPayload) -> dict:
    """Open a native directory picker and return an absolute local path."""
    if sys.platform != "darwin":
        raise HTTPException(501, detail="folder picker is currently supported on macOS only")

    script = f"choose folder with prompt {_osascript_string(payload.title)}"
    if payload.initial_path:
        initial = Path(os.path.expandvars(os.path.expanduser(payload.initial_path)))
        script += f" default location POSIX file {_osascript_string(str(initial))}"
    proc = subprocess.run(
        ["osascript", "-e", f"POSIX path of ({script})"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "User canceled" in stderr or "用户已取消" in stderr:
            return {"path": None}
        raise HTTPException(500, detail=stderr or "folder picker failed")
    return {"path": str(Path(proc.stdout.strip()).expanduser().resolve())}


@router.post("/onboarding/data-root")
def set_data_root(payload: _DataRootPayload) -> dict:
    """Web 选完目录后落 global config，Skill 下次启动会从 global config 读。"""
    proc = subprocess.run(
        [sys.executable, str(_bootstrap_script()), "--init-data-root", payload.path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"init-data-root failed: {proc.stderr}")
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
    routing_scope: keys.RoutingScope = "general"
    routing_category: keys.RoutingCategory | None = None
    routing_hints: list[str] = []
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
    routing_scope: keys.RoutingScope | None = None
    routing_category: keys.RoutingCategory | None = None
    routing_hints: list[str] | None = None
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
            routing_scope=payload.routing_scope,
            routing_category=payload.routing_category,
            routing_hints=payload.routing_hints,
            notes=payload.notes,
            created_at=payload.created_at or datetime.now(timezone.utc).isoformat(),
        )
    except Exception as e:
        raise HTTPException(422, str(e)) from e
    try:
        keys.add_key(spec)
    except keys.DuplicateAliasError:
        raise HTTPException(409, f"alias '{payload.alias}' already exists") from None
    # secret_revealed is only emitted once at creation — never on GET/PATCH
    return {"alias": payload.alias, "secret_revealed": payload.access_key}


@router.patch("/keys/{alias}")
def patch_key_endpoint(alias: str, payload: _KeyPatchPayload) -> dict:
    patch_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    try:
        keys.patch_key(alias, patch_data)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"alias '{alias}' not found") from None
    return {"alias": alias}


@router.delete("/keys/{alias}", status_code=204)
def delete_key_endpoint(alias: str) -> None:
    keys.delete_key(alias)
    return None


_GALLERY_SLOTS = ("portrait", "promo", "turnaround")
_GALLERY_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


@router.get("/gallery/recent")
def gallery_recent(limit: int = Query(default=24, ge=1, le=100)) -> dict:
    """Return random character images from portrait/promo/turnaround."""
    characters_dir = _project_root() / "characters"
    items: list[dict] = []
    if not characters_dir.exists():
        return {"items": []}
    job_ids_by_path = _gallery_job_ids_by_path()
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
                try:
                    mtime = f.stat().st_mtime
                except OSError:
                    continue  # F3: broken symlink / permissions issue
                items.append({
                    "character_id": char_dir.name,
                    "asset_slot": slot,
                    "filename": f.name,
                    "path": str(f.relative_to(_project_root())),
                    "job_id": job_ids_by_path.get(str(f.relative_to(_project_root()))),
                    "mtime": mtime,
                })
    random.shuffle(items)
    return {"items": items[:limit]}


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
                relative = str(absolute.resolve().relative_to(root))
            except ValueError:
                relative = raw_path
            result.setdefault(raw_path, job.job_id)
            result.setdefault(str(absolute.resolve()), job.job_id)
            result.setdefault(relative, job.job_id)
    return result


@router.get("/gallery/image")
def gallery_image(path: str) -> FileResponse:
    """Serve image files under characters/* OR studio/*. Rejects path traversal."""
    root = _project_root()
    target = (root / path).resolve()
    characters_dir = (root / "characters").resolve()
    studio_dir = (root / "studio").resolve()
    if not (target.is_relative_to(characters_dir) or target.is_relative_to(studio_dir)):
        raise HTTPException(status_code=400, detail="path outside allowed roots")
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)


@router.post("/keys/{alias}/default")
def set_default_alias_endpoint(alias: str) -> dict:
    try:
        keys.set_default_alias(alias)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"alias '{alias}' not found") from None
    return {"default_alias": alias}


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
    and avoids importing lovart caller chain at module load.
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
    JobKind.VIDEO is not implemented and returns 422.

    The runner is fired via BackgroundTasks so the response returns immediately;
    the UI then polls /api/jobs/<id> to observe status transitions.
    """
    if body.kind == JobKind.VIDEO:
        raise HTTPException(status_code=422, detail="video not implemented")
    db = keys.read_keys_db()
    alias = body.alias or db.default_alias
    if not alias:
        raise HTTPException(status_code=400, detail="no default key configured")
    key_row = next((k for k in db.keys if k.alias == alias), None)
    if not key_row:
        raise HTTPException(status_code=400, detail=f"unknown alias {alias}")
    params = body.params.model_copy(deep=True)
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
        seed=None,
        output_paths=[],
        status=JobStatus.PENDING,  # Studio skips pending_confirm (UI submit = explicit consent)
        error=None,
        asset_slot=_AssetSlot.PORTRAIT,  # ignored when namespace="studio"
        kind=JobKind.IMAGE,
        namespace="studio",
        alias=alias,
        provider=key_row.provider,
    )
    save_job(job)
    # Dispatch through module-level symbol so tests can monkeypatch routes._run_studio_job_safely.
    from viewer_server import routes as _self
    background.add_task(_self._run_studio_job_safely, job.job_id)
    return job.model_dump(mode="json")
