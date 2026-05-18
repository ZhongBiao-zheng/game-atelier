"""HTTP routes — GET endpoints first, POST in Task C4."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

from skill.character_workflow.lib.active_character import read_active
from skill.character_workflow.lib.schemas import (
    ActiveCharacterFile, CharacterEntry, Job,
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
