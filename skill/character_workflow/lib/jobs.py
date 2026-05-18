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


def write_job_pending_confirm(
    *, job_id: str, character_id: str, prompt: str, model: str,
    params: dict[str, Any], seed: int | None,
) -> Job:
    """画师确认前的中间态 —— Skill 先把出图调用细节落盘，UI 渲染卡片，
    画师在终端说"出图"或在 Web 点确认后才推进到 RUNNING。"""
    job = Job(
        job_id=job_id,
        character_id=character_id,
        prompt=prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=model,
        params=JobParams(**params),
        seed=seed,
        output_paths=[],
        status=JobStatus.PENDING_CONFIRM,
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


def remove_image_from_job(job_id: str, image_path: str) -> Job:
    """从 job 的 output_paths 移除一张图，并删除磁盘文件。
    路径不在 output_paths 时抛 ValueError；不存在文件忽略不报错。"""
    job = read_job(job_id)
    if image_path not in job.output_paths:
        raise ValueError(f"image {image_path} not in job {job_id} output_paths")
    p = Path(image_path)
    if p.exists():
        p.unlink()
    new_paths = [x for x in job.output_paths if x != image_path]
    updated = job.model_copy(update={"output_paths": new_paths})
    return _write(updated)
