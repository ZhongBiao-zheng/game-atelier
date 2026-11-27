"""jobs/<job_id>.json IO — Skill 与 viewer-server 双进程共写，互斥靠 job_lock。"""
from __future__ import annotations

import json
import logging
import secrets
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, get_args

from pydantic import ValidationError

from character_workflow.lib import data_root, keys, trash
from character_workflow.lib.atomic_io import atomic_write_text, read_text_with_retry
from character_workflow.lib.schemas import Job, JobErrorCode, JobKind, JobParams, JobStatus, Namespace

from character_workflow.lib.file_lock import file_lock, try_file_lock


logger = logging.getLogger(__name__)


_UNSET = object()


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _path(job_id: str) -> Path:
    return _runtime_dir() / "jobs" / f"{job_id}.json"


def job_output_dir_for(job: "Job") -> Path:
    if job.namespace == "studio":
        from character_workflow.lib.studio_jobs import studio_output_dir
        return studio_output_dir(job.job_id)
    from character_workflow.lib.canvas_projects import canvas_output_dir
    return canvas_output_dir(job.canvas_project_id, job.job_id)


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


_ERROR_CODE_PARAM = "_error_code"
_ERROR_CODES = frozenset(get_args(JobErrorCode))


def _write(job: Job) -> Job:
    p = _path(job.job_id)
    # 旧版 Job 顶层拒绝未知字段，params 允许扩展。归属只由提交入口写入。
    fields = {"studio_agent_session_id", "studio_agent_turn_id"}
    payload = job.model_dump(mode="json", exclude=fields | {"error_code"})
    payload["params"].pop("_studio_agent", None)
    payload["params"].pop(_ERROR_CODE_PARAM, None)
    if job.studio_agent_session_id:
        payload["params"]["_studio_agent"] = job.model_dump(include=fields, exclude_none=True)
    # 失败分类码同理放进 params：旧版读到顶层新字段会整条拒收（ADR-0030 数据须可被旧版读取）。
    if job.error_code and job.error:
        payload["params"][_ERROR_CODE_PARAM] = job.error_code
    atomic_write_text(p, json.dumps(payload, ensure_ascii=False, indent=2))
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


# 已废弃字段：seed，以及工坊退役（ADR-0027）删掉的六个字段。工坊退役前的每条任务都带着它们
# （值多为 null），只在作者本机手工清过；其他机器升级后若不剥离，extra=forbid 会让创作台历史整页消失。
# 只在读取时忽略，不改磁盘文件。
_RETIRED_FIELDS = (
    "seed", "asset_slot", "project_id", "ui_scheme_id", "screen_id", "production_id",
    "workshop_request_id",
)


def _load_job(data: Any) -> Job:
    """读盘构造 Job：先剥离已废弃字段，存量 JSON 不触发 extra=forbid。

    非 dict（坏文件被截断 / 手改成 `[]` 或裸值）时跳过 `.pop`，交给 model_validate
    抛 ValidationError → 上层 except 走「跳过 + 留日志」；绝不在 `.pop` 阶段抛
    Type/AttributeError 逃逸容错网，否则整个 /api/jobs 列表会 500（角色页全空）。"""
    if isinstance(data, dict):
        params = data.get("params")
        if isinstance(params, dict):
            owner = params.pop("_studio_agent", None)
            if isinstance(owner, dict):
                for key in ("studio_agent_session_id", "studio_agent_turn_id"):
                    if key in owner:
                        data[key] = owner[key]
            # 认不出的分类码当作没有：一个坏值不能让整条任务读不出来。
            # 旧记录或外部写入可能是数组 / 对象：先判类型，不可哈希的值查集合会抛 TypeError 绕过容错。
            code = params.pop(_ERROR_CODE_PARAM, None)
            if isinstance(code, str) and code in _ERROR_CODES:
                data["error_code"] = code
        for field in _RETIRED_FIELDS:
            data.pop(field, None)
    return Job.model_validate(data)


def list_jobs(*, strict: bool = False) -> list[Job]:
    jobs_dir = _runtime_dir() / "jobs"
    try:
        paths = sorted(path for path in jobs_dir.iterdir() if path.suffix == ".json")
    except FileNotFoundError:
        return []
    except PermissionError:
        if strict:
            raise
        return []
    jobs: list[Job] = []
    for p in paths:
        # 一条坏文件（半写 / 手改 schema 不符）不能拖垮整个列表 → 跳过并留日志。
        try:
            jobs.append(_load_job(json.loads(read_text_with_retry(p))))
        except FileNotFoundError:
            continue  # 枚举后被并发删除。
        except (OSError, json.JSONDecodeError, ValidationError):
            if strict:
                raise
            logger.warning("skipping bad job file: %s", p.name)
    return jobs


def last_used_by_alias() -> dict[str, str]:
    """每把 KEY 最近一次提交生成的时间。只读 alias / submitted_at 两个字段，不做整条校验。"""
    jobs_dir = _runtime_dir() / "jobs"
    latest: dict[str, tuple[datetime, str]] = {}
    for p in jobs_dir.glob("*.json") if jobs_dir.exists() else []:
        try:
            raw = json.loads(read_text_with_retry(p))
            alias, submitted = raw.get("alias"), raw.get("submitted_at")
            if not alias or not submitted:
                continue
            at = datetime.fromisoformat(submitted)
        except (OSError, json.JSONDecodeError, TypeError, ValueError, AttributeError):
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if alias not in latest or at > latest[alias][0]:
            latest[alias] = (at, submitted)
    return {alias: submitted for alias, (_, submitted) in latest.items()}


def write_job(
    *, job_id: str, character_id: str, prompt: str, model: str,
    params: dict[str, Any],
    status: JobStatus = JobStatus.PENDING_CONFIRM,
    source_image: str | None = None,
    alias: str | None = None,
    namespace: Namespace = "studio",
    canvas_project_id: str | None = None,
    kind: JobKind = JobKind.IMAGE,
) -> Job:
    """Persist a Studio or Canvas generation job."""
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
        namespace=namespace,
        canvas_project_id=canvas_project_id,
        kind=kind,
        source_image=source_image,
        alias=alias,
        provider=provider,
    )
    with job_lock(job_id):
        return _write(job)


def read_job(job_id: str) -> Job:
    # 锁外读：写入方持 job_lock 原子替换，Windows 上替换那一刻打开会 PermissionError，读取方重试越过。
    return _load_job(json.loads(read_text_with_retry(_path(job_id))))


def update_job_status(
    job_id: str, *, status: JobStatus,
    output_paths: list[str] | None = None,
    error: str | None | object = _UNSET,
    error_code: JobErrorCode | None = None,
) -> Job:
    """`error_code` 跟着 `error` 走：传了 error 就同时写分类码（缺省清掉），没传 error 两者都不动。"""
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
            update["error_code"] = error_code if error is not None else None
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


def cancel_queued_unsent(job_id: str) -> Job | None:
    """排队中、从没发出的任务直接落 CANCELED（Windows 实测 W5）；不满足条件返回 None、不改文件。

    调用方必须已持有 job_execution_lock 且拿到了（没有线程在跑它，runner 也起不来：run_job 先抢这把锁
    再读状态）。「从没发出」= 状态 PENDING、没有网关幂等键、没有上游任务号；判定与落终态在同一把 job_lock 里。"""
    with job_lock(job_id):
        job = read_job(job_id)
        if (job.status != JobStatus.PENDING or job.params.gateway_idempotency_key
                or job.params.provider_task_ids):
            return None
        now = datetime.now(timezone.utc).isoformat()
        return _write(job.model_copy(update={
            "status": JobStatus.CANCELED, "error": "已停止", "progress_phase": None,
            "completed_at": now, "cancel_requested_at": job.cancel_requested_at or now,
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


_ROUND_LABEL_LENGTH = 24


def _resolve_output(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else data_root.resolve_data_root() / raw


def _trashable_studio_job(job_id: str, *, history: bool) -> Job:
    job = read_job(job_id)
    if history and job.status not in (JobStatus.DONE, JobStatus.PARTIAL):
        raise ValueError("只能删除已完成的生成记录")
    if job.namespace != "studio" and not (history and job.namespace == "canvas"):
        raise ValueError("只能删除创作台的生成记录")
    if job.status in (JobStatus.PENDING, JobStatus.PENDING_CONFIRM):
        raise ValueError("生成中的记录不能删除，先停止")
    return job


def _round_label(job: Job) -> str:
    return " ".join(job.prompt.split())[:_ROUND_LABEL_LENGTH] or "生成结果"


_REMOVED_OUTPUTS_PARAM = "_removed_outputs"


def removed_output_slots(job: Job) -> set[int]:
    """这一轮里已单张删除的结果序号（产出时的位置）。存在 params 里，旧版读到也只是一个扩展字段。"""
    raw = (job.params.model_extra or {}).get(_REMOVED_OUTPUTS_PARAM)
    if not isinstance(raw, list):
        return set()
    return {value for value in raw if type(value) is int and value >= 0}


def output_slots(job: Job) -> list[tuple[int, str]]:
    """(稳定序号, 路径)：序号是这一份结果在这一轮产出时的位置，删掉别的单张后不变。

    Agent 历史里的 `output:<job_id>:<序号>` 按它解释，旧会话的引用始终指向原图。"""
    removed = removed_output_slots(job)
    slots: list[tuple[int, str]] = []
    slot = 0
    for path in job.output_paths:
        while slot in removed:
            slot += 1
        slots.append((slot, path))
        slot += 1
    return slots


def _with_removed_slots(job: Job, removed: set[int], output_paths: list[str]) -> Job:
    params = job.params.model_copy(update={_REMOVED_OUTPUTS_PARAM: sorted(removed) or None})
    return job.model_copy(update={"params": params, "output_paths": output_paths})


_USAGE_ARCHIVE = "usage-archive"


def _usage_archive_dir() -> Path:
    return _runtime_dir() / _USAGE_ARCHIVE


def archive_for_usage(job: Job) -> None:
    """任务记录离开 `.runtime/jobs/`（进回收站、删除）前留一份到用量侧：已发生的花费不随产物删除、
    还原或清空回收站而变化。调用方持 job_lock。"""
    _usage_archive_dir().mkdir(parents=True, exist_ok=True)
    atomic_write_text(_usage_archive_dir() / f"{job.job_id}.json", _path(job.job_id).read_text("utf-8"))


def list_usage_archive() -> list[Job]:
    """用量侧留存的已删除任务；读不出的跳过。是否仍在 `.runtime/jobs/` 由调用方去重（在的以现存为准）。"""
    archive = _usage_archive_dir()
    rows: list[Job] = []
    for path in sorted(archive.glob("*.json")) if archive.exists() else []:
        try:
            rows.append(_load_job(json.loads(read_text_with_retry(path))))
        except (OSError, json.JSONDecodeError, ValidationError):
            logger.warning("skipping bad usage archive file: %s", path.name)
    return rows


def trash_studio_job(job_id: str, output_path: str | None = None, *,
                     history_slots: set[int] | None = None) -> str:
    """创作台删除：移进回收站（30 天内可还原），返回 trash_id。

    不给 output_path 删整轮（任务文件与产物目录）；给了且这一轮不止一份产物时只删这一份：
    从 output_paths 摘掉并记下它的稳定序号，其余结果的序号不变，还原时按原位置插回。
    只收创作台自家的、已结束的任务。"""
    from character_workflow.lib.studio_jobs import studio_root

    with job_lock(job_id):
        job = _trashable_studio_job(job_id, history=history_slots is not None)
        slots = dict(output_slots(job))
        selected = history_slots
        if output_path is not None:
            selected = {slot for slot, path in slots.items() if path == output_path}
        if selected is not None:
            if not selected or not selected.issubset(slots):
                raise LookupError("这份结果不在这一轮里")
            if len(selected) < len(slots):
                remaining = [path for slot, path in slots.items() if slot not in selected]
                updated = _with_removed_slots(job, removed_output_slots(job) | selected, remaining)
                outputs = [(slot, slots[slot]) for slot in sorted(selected)]
                meta = {"job_id": job_id, "session_id": job.studio_agent_session_id}
                if len(outputs) == 1:
                    meta["output_slot"], meta["output_path"] = outputs[0]
                else:
                    meta["outputs"] = outputs
                # 画布版本归项目所有；回收站事务只需提交、还原任务的输出索引。
                paths = [_resolve_output(path) for _, path in outputs] if job.namespace == "studio" else []
                return trash.move_to_trash("round", _round_label(job), paths, meta,
                                           commit=lambda: _write(updated))
        output_dir = studio_root() / job_id
        paths: list[Path] = [_path(job_id)]
        # Canvas 的不可变版本引用原产物；删除任务记录时文件仍归项目所有。
        if job.namespace == "studio":
            if output_dir.exists():
                paths.append(output_dir)
            for raw in job.output_paths:
                path = _resolve_output(raw)
                if path.exists() and not path.resolve().is_relative_to(output_dir.resolve()):
                    paths.append(path)
        archive_for_usage(job)
        return trash.move_to_trash(
            "round", _round_label(job), paths,
            {"job_id": job_id, "session_id": job.studio_agent_session_id},
        )


def _reinsert_outputs(job_id: str, outputs: list[tuple[int, str]]) -> None:
    """持 job_lock：一次写回稳定序号；中断恢复时可以再次执行。"""
    job = read_job(job_id)
    slots = dict(output_slots(job))
    slots.update(outputs)
    removed = removed_output_slots(job) - slots.keys()
    _write(_with_removed_slots(job, removed, [path for _, path in sorted(slots.items())]))


def _restore_round(entry: trash.TrashEntry, restore_files: trash.RestoreFiles) -> None:
    job_id = entry.meta.get("job_id")
    if not isinstance(job_id, str):
        restore_files()
        return
    with job_lock(job_id):
        outputs = entry.meta.get("outputs")
        if outputs is None:
            output_path = entry.meta.get("output_path")
            slot = entry.meta.get("output_slot")
            if not isinstance(output_path, str) or type(slot) is not int:
                restore_files()
                return
            outputs = [(slot, output_path)]
        # 单张：所在的一轮必须还在，否则移回的文件会占住整轮的产物目录，整轮再也还原不了。
        if not _path(job_id).exists():
            raise trash.TrashConflict("这张所在的一轮已删除，先还原这一轮")
        restore_files(lambda: _reinsert_outputs(job_id, outputs))


trash.register_restore_handler("round", _restore_round)


def delete_failed_job(job_id: str) -> None:
    """删除 failed / canceled job 的元数据；若它意外带 output_paths，也一并清理文件。"""
    with job_lock(job_id):
        job = read_job(job_id)
        if job.status not in (JobStatus.FAILED, JobStatus.CANCELED):
            raise ValueError(f"job {job_id} is {job.status.value}, not failed")
        archive_for_usage(job)
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
        "video_submission_attempts": None,
        "mj_submission_ids": None,
        "mj_submit_uncertain": None,
        "evolink_state": None,
        "comfyui_resume": None,
        # 「自动」重试从组内顺序重新开始，不沿用上一单已经换掉的供应商。
        "route_tried": None,
        "gateway_idempotency_key": None,
        "gateway_request_fingerprint": None,
        "gateway_unconfirmed": None,
        "gateway_reattach_of": None,
        "gateway_cancel_pending": None,
        "gateway_settlement": None,
        "gateway_charged_on": None,
        _REMOVED_OUTPUTS_PARAM: None,
    })
    clone = src.model_copy(update={
        "job_id": new_job_id(),
        "studio_agent_session_id": None,
        "studio_agent_turn_id": None,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "params": params,
        "output_paths": [],
        "status": JobStatus.PENDING_CONFIRM,
        "error": None,
        "error_code": None,
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


def has_resumable_gateway_task(job: Job) -> bool:
    return bool(job.provider == "atelier"
                and job.params.provider_task_protocol == "atelier_gateway"
                and job.params.provider_task_ids)


# 主机网关任务结束后只留 24 小时；超过这个窗口再用原幂等键，主机会当成新任务。留 4 小时余量。
GATEWAY_REATTACH_WINDOW = timedelta(hours=20)


def gateway_key_expired(key: str | None) -> bool:
    """这把幂等键是否已超过接回窗口（从键第一次发出时算，签发时间编在键里）。

    「再次生成」接回与「等待网关」的 20 小时期限用的是这同一个判据；连续再次生成不会把窗口往后推。
    不是带时间格式的键一律算过期（不接回、不等待）。
    """
    from character_workflow.lib.callers.atelier_gateway import idempotency_key_issued_at

    issued = idempotency_key_issued_at(key)
    return issued is None or time.time() - issued > GATEWAY_REATTACH_WINDOW.total_seconds()


def is_waiting_gateway_job(job: Job) -> bool:
    """创作台「等待网关」的任务：这把幂等键在主机上的结局还不知道，且还在 20 小时内。"""
    return bool(job.provider == "atelier" and job.status == JobStatus.PENDING
                and job.params.gateway_unconfirmed and job.params.gateway_idempotency_key
                and not gateway_key_expired(job.params.gateway_idempotency_key))


def gateway_reattach_params(source: Job | None, alias: str | None) -> dict[str, Any]:
    """「再次生成」时从原任务继承的网关接回字段；不该接回时返回空字典。

    只接回：同一个局域网 Atelier 供应商、原任务失败且接入端没从主机拿到终态
    （`gateway_unconfirmed`）、这把幂等键第一次发出不满 20 小时。请求是否完全相同由 caller 按实际发给主机的
    内容比指纹，不同就换新键下新单。
    """
    # 「已停止」的也接回：主机已发上游的跑完并计费（飙哥定 Q3-1=B），请求相同就取回结果，不再下新单。
    if (source is None or source.status not in (JobStatus.FAILED, JobStatus.CANCELED)
            or source.provider != "atelier"
            or not alias or source.alias != alias):
        return {}
    params = source.params
    if not (params.gateway_unconfirmed and params.gateway_idempotency_key
            and params.gateway_request_fingerprint):
        return {}
    if gateway_key_expired(params.gateway_idempotency_key):
        return {}
    return {"gateway_idempotency_key": params.gateway_idempotency_key,
            "gateway_request_fingerprint": params.gateway_request_fingerprint,
            "gateway_reattach_of": source.job_id}


def has_resumable_music_task(job: Job) -> bool:
    """音乐任务拿到厂商任务号后只续查，不重新提交（音潮按首计费）。"""
    return bool(job.params.provider_task_protocol == "yinchao" and job.params.provider_task_ids)


def has_resumable_comfyui_task(job: Job) -> bool:
    state = job.params.comfyui_resume or {}
    return (job.provider == "comfyui" and bool(job.params.provider_task_ids)
            and state.get("prefix") == f"atelier/{job.job_id}")


def is_resumable_studio_job(job: Job) -> bool:
    if has_resumable_comfyui_task(job):
        return job.namespace == "studio" and job.status == JobStatus.PENDING
    if job.provider == "evolink":
        from .canvas_image_edits import has_resumable_mj_task
        return (job.namespace == "studio" and job.status == JobStatus.PENDING
                and has_resumable_mj_task(job))
    if job.namespace == "studio" and is_waiting_gateway_job(job):
        return True  # 等待网关：凭幂等键接回主机上的原任务，不会重复下单
    return bool(
        job.namespace == "studio"
        and job.status == JobStatus.PENDING
        and job.params.provider_task_protocol in ("tuzi_images", "atelier_gateway", "declarative")
        and job.params.provider_task_ids
    )


def resumable_studio_jobs() -> list[str]:
    """Return pending Studio jobs that can continue without creating a new billed request."""
    return sorted(job.job_id for job in list_jobs() if is_resumable_studio_job(job))
