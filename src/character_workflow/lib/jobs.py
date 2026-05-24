"""jobs/<job_id>.json IO — only Skill writes these files."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root, keys
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus


_UNSET = object()


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _path(job_id: str) -> Path:
    return _runtime_dir() / "jobs" / f"{job_id}.json"


def job_output_dir(character_id: str, kind: JobKind, project_root: Path | None = None) -> Path:
    """按 kind 决定 lovart 输出落到 characters/<id>/<portrait|promo|turnaround>/。"""
    root = project_root if project_root is not None else data_root.resolve_data_root()
    return root / "characters" / character_id / kind.value


def _write(job: Job) -> Job:
    p = _path(job.job_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(job.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(p)
    return job


def save_job(job: Job) -> Job:
    """Persist a complete Job model after structured updates."""
    return _write(job)


def list_jobs() -> list[Job]:
    jobs_dir = _runtime_dir() / "jobs"
    if not jobs_dir.exists():
        return []
    jobs: list[Job] = []
    for p in sorted(jobs_dir.glob("*.json")):
        jobs.append(Job.model_validate(json.loads(p.read_text(encoding="utf-8"))))
    return jobs


def write_job(
    *, job_id: str, character_id: str, prompt: str, model: str,
    params: dict[str, Any], seed: int | None,
    status: JobStatus = JobStatus.PENDING_CONFIRM,
    kind: JobKind = JobKind.PORTRAIT,
    source_image: str | None = None,
    alias: str | None = None,
) -> Job:
    """落盘一条 job 文件。默认 PENDING_CONFIRM —— Skill 先写好调用细节，
    UI 渲染"出图卡片"，画师在终端或 Web 点确认后才推进到 PENDING 调 lovart。

    kind 决定 lovart 输出目录（characters/<id>/<kind>/），由 job_output_dir() 计算。
    source_image 给 promo / turnaround Skill 传画师上传的参考图绝对路径。
    alias 不传时，按 keys.preferred_alias_for_kind(kind) 自动解析；同步从 keys.json 拿 provider。"""
    if alias is None:
        alias = keys.preferred_alias_for_kind(kind.value)
    provider: str | None = None
    if alias is not None:
        k = keys.find_by_alias(alias)
        provider = k.provider if k else None
    job = Job(
        job_id=job_id,
        character_id=character_id,
        prompt=prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=model,
        params=JobParams(**params),
        seed=seed,
        output_paths=[],
        status=status,
        error=None,
        kind=kind,
        source_image=source_image,
        alias=alias,
        provider=provider,
    )
    return _write(job)


def read_job(job_id: str) -> Job:
    data = json.loads(_path(job_id).read_text(encoding="utf-8"))
    return Job.model_validate(data)


def update_job_status(
    job_id: str, *, status: JobStatus,
    output_paths: list[str] | None = None,
    error: str | None | object = _UNSET,
) -> Job:
    job = read_job(job_id)
    update: dict[str, Any] = {"status": status}
    if output_paths is not None:
        update["output_paths"] = output_paths
    if error is not _UNSET:
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


def delete_failed_job(job_id: str) -> None:
    """删除 failed job 的元数据；若它意外带 output_paths，也一并清理文件。"""
    job = read_job(job_id)
    if job.status != JobStatus.FAILED:
        raise ValueError(f"job {job_id} is {job.status.value}, not failed")
    for image_path in job.output_paths:
        p = Path(image_path)
        if p.exists():
            p.unlink()
    _path(job_id).unlink()
