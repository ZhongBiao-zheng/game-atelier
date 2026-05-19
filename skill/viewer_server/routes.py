"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from skill.character_workflow.lib.active_character import read_active, write_active
from skill.character_workflow.lib.jobs import read_job, remove_image_from_job
from skill.character_workflow.lib.projects import (
    assign_character, create_project, delete_project, read_projects,
    rename_project,
)
from skill.character_workflow.lib.schemas import (
    ActiveCharacterFile, CharacterEntry, CharacterProjectAssign, ClipboardAttempt,
    FeedbackPost, Job, JobStatus, ProjectCreate, ProjectRename, ProjectsFile,
    SpecPatch, WebEditableJobPatch,
)


def _display_name(spec_path: Path) -> str:
    """Parse first `# heading` from spec markdown as display name. Fallback to file stem."""
    try:
        with spec_path.open("r", encoding="utf-8") as f:
            for _ in range(20):  # only scan top of file
                line = f.readline()
                if not line:
                    break
                m = re.match(r"^#\s+(.+?)\s*$", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return spec_path.stem


router = APIRouter(prefix="/api")


def _runtime() -> Path:
    return Path(os.environ.get("RUNTIME_DIR", ".runtime"))


def _project_root() -> Path:
    return Path.cwd()


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
    lines = text.split("\n")
    # Replace first `# heading`. If none, prepend one.
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
        return {"image_storage_root": ""}
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
    """两条鉴权路径：
    - `job_id` 在场：以 job.output_paths / params.reference_images 作为白名单（任意磁盘位置）
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
        if str(target) not in {str(Path(p).resolve()) for p in whitelist}:
            raise HTTPException(403, detail="path not in job whitelist")
        return FileResponse(str(target))
    cfg_path = _runtime() / "config.json"
    if not cfg_path.exists():
        raise HTTPException(403, detail="config missing")
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = Path(cfg.get("image_storage_root", "")).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(403, detail="path outside image_storage_root")
    return FileResponse(str(target))


@router.delete("/jobs/{job_id}/image")
def delete_job_image(job_id: str, path: str) -> dict:
    try:
        remove_image_from_job(job_id, path)
    except FileNotFoundError as e:
        raise HTTPException(404, detail=f"job {job_id} not found") from e
    except ValueError as e:
        raise HTTPException(404, detail=str(e)) from e
    return {"ok": True}


@router.get("/projects", response_model=ProjectsFile)
def get_projects() -> ProjectsFile:
    return read_projects()


@router.post("/projects", response_model=ProjectsFile)
def post_project(payload: ProjectCreate) -> ProjectsFile:
    create_project(payload.name)
    return read_projects()


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
    """画师不要这版 prompt —— 把 pending_confirm 推到 failed 并写明原因。
    Skill 在终端看见就停手，重新对话改 prompt。"""
    p = _runtime() / "jobs" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, detail=f"job {job_id} not found")
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("status") != JobStatus.PENDING_CONFIRM.value:
        raise HTTPException(409, detail=f"job not in pending_confirm (current: {data.get('status')})")
    data["status"] = JobStatus.FAILED.value
    data["error"] = "画师取消"
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return {"ok": True, "job_id": job_id, "status": JobStatus.FAILED.value}


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
