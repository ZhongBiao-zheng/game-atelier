"""jobs/<job_id>.json IO — only Skill writes these files."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skill.character_workflow.lib.schemas import Job, JobParams, JobStatus


def _runtime_dir() -> Path:
    return Path(os.environ.get("RUNTIME_DIR", ".runtime"))


def _path(job_id: str) -> Path:
    return _runtime_dir() / "jobs" / f"{job_id}.json"


def _write(job: Job) -> Job:
    p = _path(job.job_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(job.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(p)
    return job


def write_job_pending(
    *, job_id: str, character_id: str, prompt: str, model: str,
    params: dict[str, Any], seed: int | None,
) -> Job:
    job = Job(
        job_id=job_id,
        character_id=character_id,
        prompt=prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=model,
        params=JobParams(**params),
        seed=seed,
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
    )
    return _write(job)


def read_job(job_id: str) -> Job:
    data = json.loads(_path(job_id).read_text(encoding="utf-8"))
    return Job.model_validate(data)


def update_job_status(
    job_id: str, *, status: JobStatus,
    output_paths: list[str] | None = None,
    error: str | None = None,
) -> Job:
    job = read_job(job_id)
    update: dict[str, Any] = {"status": status}
    if output_paths is not None:
        update["output_paths"] = output_paths
    if error is not None:
        update["error"] = error
    updated = job.model_copy(update=update)
    return _write(updated)
