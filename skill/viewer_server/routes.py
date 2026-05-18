"""HTTP routes — GET + POST endpoints."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from skill.character_workflow.lib.active_character import read_active, write_active
from skill.character_workflow.lib.schemas import (
    ActiveCharacterFile, CharacterEntry, ClipboardAttempt, FeedbackPost, Job,
    SpecPatch, WebEditableJobPatch,
)


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
    p = _project_root() / "characters" / f"{character_id}.md"
    if not p.exists():
        raise HTTPException(404, detail=f"spec {character_id} not found")
    return {"content": p.read_text(encoding="utf-8")}


@router.get("/characters", response_model=list[CharacterEntry])
def get_characters() -> list[CharacterEntry]:
    chars_dir = _project_root() / "characters"
    if not chars_dir.exists():
        return []
    out: list[CharacterEntry] = []
    for p in sorted(chars_dir.glob("*.md")):
        out.append(CharacterEntry(
            id=p.stem, name=p.stem, status="idle", latest_job_id=None,
        ))
    return out


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
    p = _project_root() / "characters" / f"{character_id}.md"
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


@router.post("/config")
def post_config(payload: dict = Body(...)) -> dict:
    root = payload.get("image_storage_root", "").strip()
    if not root:
        raise HTTPException(422, detail="image_storage_root required")
    cfg_path = _runtime() / "config.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"image_storage_root": root}, indent=2))
    tmp.replace(cfg_path)
    return {"ok": True}
