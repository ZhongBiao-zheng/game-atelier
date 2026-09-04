"""jobs/<job_id>.json IO — Skill 与 viewer-server 双进程共写，互斥靠 job_lock。"""
from __future__ import annotations

import json
import logging
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from pydantic import ValidationError

from character_workflow.lib import data_root, keys
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus, Namespace

from character_workflow.lib.file_lock import file_lock, try_file_lock


logger = logging.getLogger(__name__)


_UNSET = object()


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _path(job_id: str) -> Path:
    return _runtime_dir() / "jobs" / f"{job_id}.json"


def job_output_dir(character_id: str, kind: AssetSlot, project_root: Path | None = None) -> Path:
    """按 asset_slot 决定出图输出落到 characters/<id>/<portrait|promo|turnaround>/。"""
    root = project_root if project_root is not None else data_root.resolve_data_root()
    return root / "characters" / character_id / kind.value


def job_output_dir_for(job: "Job") -> Path:
    """Namespace-aware output dir dispatcher.
    Studio jobs → <data_root>/studio/<job_id>/
    Character jobs → <data_root>/characters/<character_id>/<asset_slot>/
    """
    if job.namespace == "studio":
        from character_workflow.lib.studio_jobs import studio_output_dir
        return studio_output_dir(job.job_id)
    if job.namespace == "canvas":
        from character_workflow.lib.canvas_projects import canvas_output_dir
        return canvas_output_dir(job.canvas_project_id, job.job_id)
    if job.namespace == "ui":
        from character_workflow.lib.ui_jobs import screen_output_dir
        return screen_output_dir(job.project_id, job.ui_scheme_id, job.screen_id)
    if job.namespace == "video":
        from character_workflow.lib.video_jobs import production_output_dir
        return production_output_dir(job.project_id, job.production_id)
    return job_output_dir(job.character_id, job.asset_slot)


@contextmanager
def job_lock(job_id: str) -> Iterator[None]:
    """per-job 互斥锁 —— 「读→改→写」必须整段持锁，否则 Skill / viewer-server
    双进程 read-modify-write 互相覆盖 = last-writer-wins。
    本模块的写入口已自带锁；模块外直接读改写 job 文件（如 routes.post_prompt）必须显式持有。

    锁加在 sidecar .lock 文件上而非 job 文件本身：原子写走 tmp.replace 换 inode，
    锁在被换掉的旧 inode 上等于没锁。进程崩溃时 OS 自动释放，不会留死锁。"""
    with file_lock(_runtime_dir() / "jobs" / f"{job_id}.lock"):
        yield


@contextmanager
def job_execution_lock(job_id: str) -> Iterator[bool]:
    """Claim one provider runner per Job across threads/processes without blocking duplicates."""
    with try_file_lock(_runtime_dir() / "jobs" / f"{job_id}.run.lock") as acquired:
        yield acquired


def new_job_id() -> str:
    """job_id 唯一生成点 —— submit / retry 共用，防止两处格式漂移。"""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"job-{ts}{secrets.token_hex(4)}"


def _write(job: Job) -> Job:
    p = _path(job.job_id)
    atomic_write_text(p, job.model_dump_json(indent=2))
    return job


def save_job(job: Job) -> Job:
    """Persist a complete Job model after structured updates."""
    with job_lock(job.job_id):
        return _write(job)


def update_job_params(job_id: str, params: dict[str, Any] | JobParams) -> Job:
    """Atomically replace params without overwriting concurrent status/phase/output updates."""
    normalized = params if isinstance(params, JobParams) else JobParams(**params)
    with job_lock(job_id):
        current = read_job(job_id)
        return write_job_under_lock(current.model_copy(update={"params": normalized}))


def write_job_under_lock(job: Job) -> Job:
    """Persist a Job while the caller holds ``job_lock(job.job_id)``.

    Cross-file transactions use this narrow primitive so their full read-modify-write sequence can
    follow the fixed project-lock → job-lock order without recursively acquiring the sidecar lock.
    """
    return _write(job)


def migrate_ui_job_to_scheme(
    job_id: str,
    project_id: str,
    scheme_id: str,
    old_path_prefix: str,
    new_path_prefix: str,
) -> Job | None:
    """One-time structured upgrade for a pre-scheme UI job.

    The raw document cannot validate until ``ui_scheme_id`` is added, so this upgrade lives beside
    the normal Job IO, holds the same per-job lock, validates the complete model, then persists it.
    """
    with job_lock(job_id):
        path = _path(job_id)
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("namespace") != "ui" or data.get("project_id") != project_id:
            return None
        data["ui_scheme_id"] = scheme_id
        data["output_paths"] = [
            _replace_path_prefix(value, old_path_prefix, new_path_prefix)
            if isinstance(value, str) else value
            for value in data.get("output_paths", [])
        ]
        return _write(_load_job(data))


def _replace_path_prefix(value: str, old_prefix: str, new_prefix: str) -> str:
    """Rewrite stored relative or absolute paths regardless of their platform separator."""
    rewritten = value.replace(old_prefix, new_prefix)
    return rewritten.replace(
        old_prefix.replace("/", "\\"),
        new_prefix.replace("/", "\\"),
    )


def _load_job(data: Any) -> Job:
    """读盘构造 Job：先剥离已废弃字段（seed），存量 JSON 不触发 extra=forbid。

    非 dict（坏文件被截断 / 手改成 `[]` 或裸值）时跳过 `.pop`，交给 model_validate
    抛 ValidationError → 上层 except 走「跳过 + 留日志」；绝不在 `.pop` 阶段抛
    Type/AttributeError 逃逸容错网，否则整个 /api/jobs 列表会 500（角色页全空）。"""
    if isinstance(data, dict):
        data.pop("seed", None)
    return Job.model_validate(data)


def list_jobs() -> list[Job]:
    jobs_dir = _runtime_dir() / "jobs"
    if not jobs_dir.exists():
        return []
    jobs: list[Job] = []
    for p in sorted(jobs_dir.glob("*.json")):
        # 一条坏文件（半写 / 手改 schema 不符）不能拖垮整个列表 → 跳过并留日志。
        try:
            jobs.append(_load_job(json.loads(p.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError, ValidationError):
            logger.warning("skipping bad job file: %s", p.name)
    return jobs


def write_job(
    *, job_id: str, character_id: str, prompt: str, model: str,
    params: dict[str, Any],
    status: JobStatus = JobStatus.PENDING_CONFIRM,
    asset_slot: AssetSlot = AssetSlot.PORTRAIT,
    source_image: str | None = None,
    alias: str | None = None,
    namespace: Namespace = "character",
    project_id: str | None = None,
    ui_scheme_id: str | None = None,
    screen_id: str | None = None,
    production_id: str | None = None,
    canvas_project_id: str | None = None,
    kind: JobKind = JobKind.IMAGE,
) -> Job:
    """落盘一条 job 文件。默认 PENDING_CONFIRM —— Skill 先写好调用细节，
    UI 渲染"出图卡片"，画师在终端或 Web 点确认后才推进到 PENDING 调图像服务。

    asset_slot 决定出图输出目录（characters/<id>/<slot>/），由 job_output_dir() 计算。
    source_image 给 promo / turnaround Skill 传画师上传的参考图绝对路径。
    alias 不传时，按 keys.preferred_alias_for_kind(asset_slot) 自动解析；同步从 keys.json 拿 provider。"""
    if alias is None:
        alias = keys.preferred_alias_for_kind(asset_slot.value)
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
        output_paths=[],
        status=status,
        error=None,
        asset_slot=asset_slot,
        namespace=namespace,
        project_id=project_id,
        ui_scheme_id=ui_scheme_id,
        screen_id=screen_id,
        production_id=production_id,
        canvas_project_id=canvas_project_id,
        kind=kind,
        source_image=source_image,
        alias=alias,
        provider=provider,
    )
    with job_lock(job_id):
        return _write(job)


def read_job(job_id: str) -> Job:
    return _load_job(json.loads(_path(job_id).read_text(encoding="utf-8")))


def update_job_status(
    job_id: str, *, status: JobStatus,
    output_paths: list[str] | None = None,
    error: str | None | object = _UNSET,
) -> Job:
    with job_lock(job_id):
        job = read_job(job_id)
        update: dict[str, Any] = {"status": status}
        # 终态清空进度卡点，避免 retry/回看读到陈旧 phase；并盖出图完成时间戳（算耗时/展示生成时间用）。
        if status in (
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        ):
            update["progress_phase"] = None
            update["completed_at"] = datetime.now(timezone.utc).isoformat()
        if output_paths is not None:
            update["output_paths"] = output_paths
        if error is not _UNSET:
            update["error"] = error
        updated = job.model_copy(update=update)
        return _write(updated)


def request_job_cancel(job_id: str) -> Job:
    """登记停止请求（幂等）。只写标记不改 status：runner 在下一个可中断点把它落成 CANCELED，
    同步阻塞中的上游请求打不断，不能假装已经停了。终态 job 原样返回。"""
    with job_lock(job_id):
        job = read_job(job_id)
        if job.status in (
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        ) or job.cancel_requested_at is not None:
            return job
        return _write(job.model_copy(update={
            "cancel_requested_at": datetime.now(timezone.utc).isoformat(),
        }))


def update_job_phase(job_id: str, phase: str) -> Job:
    """视频 caller 回写进度卡点（sent / downloading）。终态 job 不回写。"""
    with job_lock(job_id):
        job = read_job(job_id)
        if job.status in (
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        ):
            return job
        return _write(job.model_copy(update={"progress_phase": phase}))


def remove_image_from_job(job_id: str, image_path: str) -> Job:
    """从 job 的 output_paths 移除一张图，并删除磁盘文件。
    路径不在 output_paths 时抛 ValueError；不存在文件忽略不报错。"""
    with job_lock(job_id):
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
    """删除 failed / canceled job 的元数据；若它意外带 output_paths，也一并清理文件。"""
    with job_lock(job_id):
        job = read_job(job_id)
        if job.status not in (JobStatus.FAILED, JobStatus.CANCELED):
            raise ValueError(f"job {job_id} is {job.status.value}, not failed")
        for image_path in job.output_paths:
            p = Path(image_path)
            if p.exists():
                p.unlink()
        _path(job_id).unlink()


def clone_job_for_retry(job_id: str) -> Job:
    """克隆一条 FAILED job 为新的 PENDING_CONFIRM job 用于重试。

    原 job 与其 error 记录原样保留；新 job 清空结果性字段
    （output_paths / error / params.actual_size / params.warnings），
    其余参数原样复制，并以 retry_of 指回原 job。"""
    src = read_job(job_id)
    if src.workshop_request_id:
        raise ValueError("工坊请求任务重试需要新建生成请求并重新批准")
    if src.status != JobStatus.FAILED:
        raise ValueError(
            f"job {job_id} is {src.status.value}, not failed —— 只有 failed job 可重试"
        )
    params = src.params.model_copy(update={
        "actual_size": None,
        "actual_cost_cny": None,
        "warnings": None,
        # “再次生成”是明确的新订单，不能复用上一单的终态/过期任务 ID。
        "provider_task_protocol": None,
        "provider_task_ids": None,
    })
    clone = src.model_copy(update={
        "job_id": new_job_id(),
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "params": params,
        "output_paths": [],
        "status": JobStatus.PENDING_CONFIRM,
        "error": None,
        "retry_of": job_id,
    })
    return save_job(clone)


def fail_orphan_studio_jobs(error: str = "server restarted, job interrupted") -> list[str]:
    """viewer-server 启动时回收孤儿 studio job，返回被回收的 job_id 列表。

    studio job 只在 viewer-server 进程的受控 executor 内跑，server 启动时仍 pending
    且没有可恢复厂商任务 ID 的请求，必然已随上次进程一起中断 —— 直接判 FAILED。
    character job 由独立 Skill 进程跑，不能在这里清（前端按时限提示作废）。"""
    reclaimed: list[str] = []
    for job in list_jobs():
        if job.namespace == "studio" and job.status == JobStatus.PENDING:
            if is_resumable_studio_job(job):
                continue
            update_job_status(job.job_id, status=JobStatus.FAILED, error=error)
            reclaimed.append(job.job_id)
    return reclaimed


def is_resumable_studio_job(job: Job) -> bool:
    return bool(
        job.namespace == "studio"
        and job.status == JobStatus.PENDING
        and job.params.provider_task_protocol == "tuzi_async"
        and job.params.provider_task_ids
    )


def resumable_studio_jobs() -> list[str]:
    """Return pending Studio jobs that can continue without creating a new billed request."""
    return sorted(job.job_id for job in list_jobs() if is_resumable_studio_job(job))
