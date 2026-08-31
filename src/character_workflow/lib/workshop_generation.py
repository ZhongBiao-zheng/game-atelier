"""Frozen generation requests and conservative, single-Job approved execution."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import keys
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import (
    job_execution_lock, new_job_id, read_job, save_job, update_job_status,
)
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus
from character_workflow.lib.workshop import (
    WorkshopError, actor_id, digest, media_entries, media_id_for_path, paginate,
    read_stable, resolve_target, root, safe_path, target_display_name,
)
from character_workflow.lib.workshop_schema import (
    GetGenerationInput, PrepareGenerationInput, TargetInput, WithdrawGenerationInput,
)


class GenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str
    revision: int = 1
    state: Literal["awaiting_approval", "approved", "withdrawn", "expired"] = "awaiting_approval"
    owner_id: str
    grant_id: str | None
    input: PrepareGenerationInput
    fingerprint: str
    config_fingerprint: str
    created_at: str
    expires_at: str
    provider: str
    target_name: str = ""
    references: list[dict[str, Any]] = Field(default_factory=list)
    frozen_params: dict[str, Any]
    job_id: str
    approved_at: str | None = None
    approved_by: str | None = None
    execution_state: Literal["not_dispatched", "claimed", "needs_review"] = "not_dispatched"
    execution_message: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def request_path(request_id: str) -> Path:
    if not request_id.startswith("wr-") or len(request_id) != 43 or any(
        c not in "0123456789abcdef" for c in request_id[3:]
    ):
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "找不到生成请求", 404)
    return safe_path(root() / "requests" / f"{request_id}.json")


def read_request(request_id: str) -> GenerationRequest:
    try:
        return GenerationRequest.model_validate_json(read_stable(request_path(request_id), 512000))
    except FileNotFoundError:
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "找不到生成请求", 404) from None


def _save(request: GenerationRequest) -> None:
    atomic_write_json(request_path(request.request_id), request.model_dump(mode="json"))


def model_configuration(alias: str, model_id: str, kind: str):
    key = keys.find_by_alias(alias)
    model = next((m for m in key.models if m.id == model_id), None) if key else None
    if key is None or model is None or not key.access_key:
        raise WorkshopError("MODEL_UNAVAILABLE", "模型没有在本机配置，请先在设置中配置", 422)
    modalities = key.modalities or (["image"] if key.capabilities else [])
    if (model.modality is not None and model.modality != kind) or (
        model.modality is None and kind not in modalities
    ):
        raise WorkshopError("MODEL_UNAVAILABLE", "当前模型不支持此生成类型", 422)
    if kind == "video":
        from character_workflow.lib.callers import _effective_protocol
        from character_workflow.lib.callers.video_registry import VIDEO_ADAPTERS
        protocol = _effective_protocol(key, model.id)
        if protocol not in VIDEO_ADAPTERS:
            raise WorkshopError("MODEL_UNAVAILABLE", "当前视频模型没有已支持的调用协议", 422)
        model = model.model_copy(update={"protocol": protocol})
    else:
        from character_workflow.lib.callers import _provider_render
        if _provider_render(key, model.id) is None:
            raise WorkshopError("MODEL_UNAVAILABLE", "当前图片模型没有已支持的调用协议", 422)
    # The digest includes credentials but never returns them; changing an alias requires new consent.
    fingerprint = digest({"key": key.model_dump(exclude={"notes", "created_at"}),
                          "model": model.model_dump()})
    return key, model, fingerprint


def list_models(principal: Any, payload: TargetInput) -> dict:
    resolve_target(principal, payload.target)
    kind = "video" if payload.target.type == "video" else "image"
    rows = []
    for key in keys.read_keys_db().keys:
        for model in key.models:
            try:
                _, configured, _ = model_configuration(key.alias, model.id, kind)
            except WorkshopError:
                continue
            from character_workflow.lib.callers.openai_image import (
                fixed_nano_resolution_quality, image_family, max_reference_images,
                supports_image_quality,
            )
            from character_workflow.lib.video_caps import seedance_limits
            limits = {"image": max_reference_images(model.id), "video": 0, "audio": 0}
            duration = None
            if kind == "video":
                caps = seedance_limits(model.id) if configured.protocol == "seedance" else None
                image_limit = None if configured.protocol == "openrouter" else 2
                if configured.protocol == "dashscope":
                    normalized = model.id.lower()
                    if "video-edit" in normalized:
                        continue  # Local video references are not supported by this transport.
                    image_limit = 9 if "r2v" in normalized else (1 if "i2v" in normalized else 0)
                limits = {"image": caps.max_images if caps else image_limit,
                          "video": caps.max_videos if caps else 0,
                          "audio": caps.max_audios if caps else 0}
                if caps and caps.min_duration is not None and caps.max_duration is not None:
                    duration = {"min": caps.min_duration, "max": caps.max_duration}
            count = {"min": 1, "max": 4} if kind == "image" else {"min": 1, "max": 1}
            if kind == "image" and image_family(model.id) == "midjourney":
                count = {"min": 4, "max": 4}
            quality = (["auto", "low", "medium", "high"]
                       if kind == "image" and supports_image_quality(model.id) else None)
            rows.append({"alias": key.alias, "provider": key.provider, "model": model.id,
                         "name": model.name, "kind": kind, "protocol": configured.protocol,
                         "reference_limits": limits, "estimated_cost_cny": None,
                         "capabilities": {"count": count, "quality": quality,
                                          "fixed_quality": (fixed_nano_resolution_quality(model.id)
                                                            if kind == "image" else None),
                                          "size": None, "ratio": None, "duration": duration,
                                          "resolution": None},
                         "request_limits": {"max_references": 12},
                         "capability_basis": "当前本地适配器约束；null 表示未确认，prepare 会校验已知限制",
                         "price_basis": "费用待确认；以供应商实际账单为准"})
    return {"models": rows}


def _normalized(payload: PrepareGenerationInput, entries: list[dict], model, key) -> dict:
    from character_workflow.lib.canvas_runs import _validate_input_capabilities
    from character_workflow.lib.callers.openai_image import (
        fixed_nano_resolution_quality, image_family, normalize_image_pixel_size,
    )
    params = payload.params.model_dump(exclude_none=True, exclude={"type"})
    if payload.params.type == "image":
        if image_family(model.id) == "midjourney" and params["n"] != 4:
            raise WorkshopError("INVALID_PARAMETERS", "Midjourney 每次产生 4 张图，请明确填写 n=4", 422)
        if params.get("size") and params["size"] != "auto":
            params["size"] = normalize_image_pixel_size(model.id, params["size"])
        fixed_quality = fixed_nano_resolution_quality(model.id)
        if fixed_quality:
            params["quality"] = fixed_quality
    counts = [SimpleNamespace(kind=e["kind"]) for e in entries]
    for media_kind in ("image", "video", "audio"):
        params[f"reference_{media_kind}s"] = [
            entry["media_id"] for entry in entries if entry["kind"] == media_kind
        ]
    try:
        _validate_input_capabilities(model, JobKind(payload.params.type), counts,
                                     JobParams(**params), key.provider)
        if payload.params.type == "video":
            from character_workflow.lib.video_caps import validate_seedance_request
            validate_seedance_request(model.id, params, payload.prompt)
    except ValueError as error:
        raise WorkshopError("INVALID_PARAMETERS", str(error), 422) from None
    return params


def prepare_generation(principal: Any, payload: PrepareGenerationInput) -> dict:
    directory = resolve_target(principal, payload.target, "prepare_generation")
    owner = actor_id(principal)
    request_id = "wr-" + digest([owner, payload.target.model_dump(), payload.idempotency_key])[:40]
    path = request_path(request_id)
    with file_lock(path.with_suffix(".lock")):
        available = {entry["media_id"]: (entry, p)
                     for entry, p in media_entries(principal, payload.target)}
        if any(media_id not in available for media_id in payload.media_ids):
            raise WorkshopError("REFERENCE_NOT_ALLOWED", "参考素材不属于当前目标", 403)
        frozen = []
        total = 0
        # A bounded immutable copy is part of prepare, before the human approval is shown.
        for media_id in payload.media_ids:
            entry, source = available[media_id]
            body = read_stable(source, 100 * 1024 * 1024)
            total += len(body)
            if total > 200 * 1024 * 1024:
                raise WorkshopError("CONTENT_TOO_LARGE", "本次参考素材总计不能超过 200 MB", 413)
            frozen.append((entry, source.suffix, body, hashlib.sha256(body).hexdigest()))
        fingerprint = digest({"input": payload.model_dump(),
                              "references": [item[3] for item in frozen]})
        if path.exists():
            existing = read_request(request_id)
            if existing.fingerprint != fingerprint:
                raise WorkshopError("IDEMPOTENCY_CONFLICT", "同一幂等键的参数或参考内容已改变")
            return request_view(existing, agent=principal.kind == "agent")
        key, model, config_fingerprint = model_configuration(
            payload.alias, payload.model, payload.params.type)
        params = _normalized(payload, [item[0] for item in frozen], model, key)
        refs = []
        for entry, suffix, body, content_digest in frozen:
            snapshot = safe_path(root() / "inputs" / request_id /
                                 f"{entry['media_id']}{suffix.lower()}")
            atomic_write_bytes(snapshot, body)
            refs.append({**entry, "sha256": content_digest, "snapshot_path": str(snapshot)})
        for kind in ("image", "video", "audio"):
            params[f"reference_{kind}s"] = [ref["snapshot_path"] for ref in refs if ref["kind"] == kind]
        request = GenerationRequest(
            request_id=request_id, owner_id=owner, grant_id=principal.grant_id,
            input=payload, fingerprint=fingerprint, config_fingerprint=config_fingerprint,
            created_at=_now().isoformat(), expires_at=(_now() + timedelta(hours=24)).isoformat(),
            provider=key.provider, references=refs, frozen_params=params, job_id=new_job_id(),
            target_name=target_display_name(payload.target, directory),
        )
        _save(request)
        return request_view(request, agent=principal.kind == "agent")


def _job_for(request: GenerationRequest) -> Job:
    target = request.input.target
    return Job(
        job_id=request.job_id, namespace=target.type, character_id=(
            target.character_id if target.type == "character" else ""),
        asset_slot=AssetSlot(target.asset_slot) if target.type == "character" else AssetSlot.PORTRAIT,
        project_id=target.project_id,
        ui_scheme_id=target.ui_scheme_id if target.type == "ui" else None,
        screen_id=target.screen_id if target.type == "ui" else None,
        production_id=target.production_id if target.type == "video" else None,
        kind=JobKind(request.input.params.type), prompt=request.input.prompt,
        model=request.input.model, alias=request.input.alias, provider=request.provider,
        params=JobParams(**request.frozen_params), status=JobStatus.PENDING,
        submitted_at=request.approved_at or request.created_at, error=None, output_paths=[],
        workshop_request_id=request.request_id,
    )


def request_view(request: GenerationRequest, *, agent: bool = False) -> dict:
    job = None
    output_media_ids = []
    if request.state == "approved":
        try:
            saved = read_job(request.job_id)
            job = {"status": saved.status.value, "error": saved.error,
                   "output_count": len(saved.output_paths)}
            if agent and saved.error:
                job["error"] = "生成失败，请在本地工坊查看详情；不要自动重试"
            output_media_ids = _output_media_ids(request, saved)
        except FileNotFoundError:
            pass
    target = request.input.target
    name = getattr(target, "character_id", None) or getattr(target, "screen_id", None)
    name = name or getattr(target, "production_id", "")
    params = {k: v for k, v in request.frozen_params.items() if not k.startswith("reference_")}
    return {
        "request_id": request.request_id, "revision": request.revision, "state": request.state,
        "target": target.model_dump(), "target_name": request.target_name or name,
        "alias": request.input.alias, "provider": request.provider, "model": request.input.model,
        "prompt": request.input.prompt, "params": params,
        "references": [{k: v for k, v in ref.items() if k != "snapshot_path"}
                       for ref in request.references],
        "estimated_cost_cny": None, "price_basis": "费用待确认；以供应商实际账单为准",
        "created_at": request.created_at, "expires_at": request.expires_at,
        "job_id": request.job_id if request.state == "approved" else None,
        "job": job, "output_media_ids": output_media_ids,
        "execution_state": request.execution_state,
        "execution_message": ("执行需要人工复核，请在本地工坊检查任务及供应商订单"
                              if agent and request.execution_message else request.execution_message),
        "approval_url": f"/workshop/requests?request_id={request.request_id}",
    }


def _output_media_ids(request: GenerationRequest, job: Job) -> list[str]:
    local = SimpleNamespace(kind="local", session_id="request-view", grant_id=None)
    try:
        directory = resolve_target(local, request.input.target)
    except WorkshopError:
        return []  # Retained request history remains readable after a target is deleted.
    result = []
    for raw in job.output_paths:
        try:
            path = safe_path(Path(raw))
            if path.is_relative_to(directory) and path.is_file():
                result.append(media_id_for_path(request.input.target, path))
        except WorkshopError:
            continue
    return result


def _request_for(principal: Any, request_id: str, capability: str = "read") -> GenerationRequest:
    request = read_request(request_id)
    resolve_target(principal, request.input.target, capability)
    if principal.kind != "local" and request.owner_id != actor_id(principal):
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "请求不属于当前授权", 403)
    return request


def get_generation(principal: Any, payload: GetGenerationInput) -> dict:
    return request_view(_request_for(principal, payload.request_id), agent=principal.kind == "agent")


def frozen_reference(principal: Any, request_id: str, media_id: str) -> tuple[Path, str]:
    if actor_id(principal) != "local":
        raise WorkshopError("CAPABILITY_DENIED", "冻结参考仅在本地批准页预览", 403)
    request = _request_for(principal, request_id)
    ref = next((item for item in request.references if item["media_id"] == media_id), None)
    if ref is None:
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "参考素材不属于本次生成请求", 404)
    path = safe_path(Path(ref["snapshot_path"]))
    if hashlib.sha256(read_stable(path, 100 * 1024 * 1024)).hexdigest() != ref["sha256"]:
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "冻结参考已变化，请重新准备生成")
    return path, ref["mime_type"]


def list_requests(principal: Any, page: int = 1, page_size: int = 20) -> dict:
    if actor_id(principal) != "local":
        raise WorkshopError("CAPABILITY_DENIED", "待批准列表仅在本地管理页可见", 403)
    items = []
    for path in sorted((root() / "requests").glob("wr-*.json"), reverse=True):
        request = read_request(path.stem)
        items.append(request_view(request))
    items.sort(key=lambda r: r["created_at"], reverse=True)
    return paginate(items, page, page_size, "requests")


def _verify_snapshot(request: GenerationRequest) -> None:
    _, _, fingerprint = model_configuration(request.input.alias, request.input.model,
                                             request.input.params.type)
    if fingerprint != request.config_fingerprint:
        raise WorkshopError("APPROVAL_REQUIRED", "供应商或模型配置已改变，请重新准备生成")
    for ref in request.references:
        try:
            actual = hashlib.sha256(read_stable(Path(ref["snapshot_path"]), 100 * 1024 * 1024)).hexdigest()
        except (OSError, WorkshopError):
            raise WorkshopError("REFERENCE_NOT_ALLOWED", "冻结的参考素材已变化，请重新准备") from None
        if actual != ref["sha256"]:
            raise WorkshopError("REFERENCE_NOT_ALLOWED", "冻结的参考素材已变化，请重新准备")


def approve_generation(principal: Any, request_id: str, expected_revision: int,
                       grant_is_active: Callable[[str, str, str], bool]) -> dict:
    if actor_id(principal) != "local":
        raise WorkshopError("CAPABILITY_DENIED", "出图必须由用户在本地页面确认", 403)
    with file_lock(request_path(request_id).with_suffix(".lock")):
        request = _request_for(principal, request_id)
        if request.state == "approved":
            try:
                read_job(request.job_id)
            except FileNotFoundError:
                if request.execution_state != "not_dispatched":
                    raise WorkshopError("EXECUTION_NEEDS_REVIEW", "任务记录缺失，请核对供应商订单") from None
                _verify_grant(request, grant_is_active)
                _verify_snapshot(request)
                save_job(_job_for(request))
            return request_view(request)
        if request.revision != expected_revision:
            raise WorkshopError("DOCUMENT_CONFLICT", "生成请求已变化，请刷新")
        if request.state != "awaiting_approval":
            raise WorkshopError("APPROVAL_REQUIRED", "该请求已撤回或失效")
        if datetime.fromisoformat(request.expires_at) <= _now():
            request.state = "expired"
            request.revision += 1
            _save(request)
            raise WorkshopError("REQUEST_EXPIRED", "请求已过期，请重新准备")
        _verify_grant(request, grant_is_active)
        _verify_snapshot(request)
        request.state = "approved"
        request.approved_at = _now().isoformat()
        request.approved_by = principal.session_id
        request.revision += 1
        _save(request)
        # The fixed Job id makes a crash between these two files recoverable without a new order.
        save_job(_job_for(request))
        return request_view(request)


def withdraw_generation(principal: Any, payload: WithdrawGenerationInput) -> dict:
    with file_lock(request_path(payload.request_id).with_suffix(".lock")):
        request = _request_for(principal, payload.request_id, "prepare_generation")
        if request.state == "withdrawn":
            return request_view(request, agent=principal.kind == "agent")
        if request.revision != payload.expected_revision:
            raise WorkshopError("DOCUMENT_CONFLICT", "生成请求已变化，请刷新")
        if request.state != "awaiting_approval":
            raise WorkshopError("EXECUTION_NEEDS_REVIEW", "请求已获批准或过期，不能撤回已发送的订单")
        request.state = "withdrawn"
        request.revision += 1
        _save(request)
        return request_view(request, agent=principal.kind == "agent")


def _verify_grant(request: GenerationRequest,
                  grant_is_active: Callable[[str, str, str], bool] | None) -> None:
    if request.grant_id and (grant_is_active is None or not grant_is_active(
        request.grant_id, request.input.target.project_id, "prepare_generation"
    )):
        raise WorkshopError("CAPABILITY_DENIED", "发起请求的 Agent 授权已撤销或到期", 403)


def claim_execution(job: Job,
                    grant_is_active: Callable[[str, str, str], bool] | None = None) -> None:
    """Called only while the existing job_execution_lock is owned, before provider dispatch."""
    if not job.workshop_request_id:
        raise WorkshopError("APPROVAL_REQUIRED", "旧工坊草稿需要重新准备并在本地页面批准")
    with file_lock(request_path(job.workshop_request_id).with_suffix(".lock")):
        request = read_request(job.workshop_request_id)
        expected = _job_for(request)
        if (request.state != "approved" or request.job_id != job.job_id or not request.approved_at):
            raise WorkshopError("APPROVAL_REQUIRED", "该任务没有匹配的人工批准")
        _verify_grant(request, grant_is_active)
        fields = ("namespace", "character_id", "project_id", "ui_scheme_id", "screen_id",
                  "production_id", "asset_slot", "kind", "alias", "provider", "prompt", "model")
        if any(getattr(expected, key) != getattr(job, key) for key in fields):
            raise WorkshopError("APPROVAL_REQUIRED", "任务内容与批准快照不一致")
        for key, value in request.frozen_params.items():
            if getattr(job.params, key, None) != value:
                raise WorkshopError("APPROVAL_REQUIRED", "任务参数与批准快照不一致")
        runtime_fields = {"actual_size", "actual_cost_cny", "warnings", "requested_size",
                          "provider_task_ids", "provider_task_protocol"}
        unexpected = set(job.params.model_dump(exclude_none=True)) - set(request.frozen_params)
        if unexpected - runtime_fields or job.source_image is not None:
            raise WorkshopError("APPROVAL_REQUIRED", "任务含有未批准的参数或引用")
        if request.execution_state == "not_dispatched" and (
            job.params.provider_task_ids or job.params.provider_task_protocol
        ):
            raise WorkshopError("APPROVAL_REQUIRED", "新任务不能指定供应商历史订单")
        # Removed/reassigned targets cannot redirect a paid task's output destination.
        local = SimpleNamespace(kind="local", session_id="runner", grant_id=None)
        resolve_target(local, request.input.target)
        _verify_snapshot(request)
        if request.execution_state != "not_dispatched":
            resumable = (
                request.execution_state == "claimed" and job.kind == JobKind.IMAGE
                and job.params.provider_task_protocol == "tuzi_async"
                and len(job.params.provider_task_ids or []) == (job.params.n or 1)
            )
            if not resumable:
                request.execution_state = "needs_review"
                request.execution_message = "上次调用结果不明，请先核对供应商订单；不会自动重新出图"
                _save(request)
                raise WorkshopError("EXECUTION_NEEDS_REVIEW", request.execution_message)
        request.execution_state = "claimed"
        _save(request)


def recover_requests(grant_is_active: Callable[[str, str, str], bool] | None = None) -> list[str]:
    """Recover only Workshop-owned approved records, never Studio/Canvas or legacy drafts."""
    queued = []
    for path in (root() / "requests").glob("wr-*.json"):
        with file_lock(path.with_suffix(".lock")):
            request = read_request(path.stem)
            if request.state != "approved":
                continue
            with job_execution_lock(request.job_id) as acquired:
                if not acquired:
                    continue
                try:
                    job = read_job(request.job_id)
                except FileNotFoundError:
                    if request.execution_state != "not_dispatched":
                        request.execution_state = "needs_review"
                        _save(request)
                        continue
                    job = save_job(_job_for(request))
                if job.status != JobStatus.PENDING:
                    continue
                try:
                    _verify_grant(request, grant_is_active)
                except WorkshopError as error:
                    request.execution_state = "needs_review"
                    request.execution_message = error.message
                    _save(request)
                    update_job_status(job.job_id, status=JobStatus.FAILED, error=error.message)
                    continue
                if request.execution_state == "not_dispatched" or (
                    request.execution_state == "claimed" and job.kind == JobKind.IMAGE
                    and job.params.provider_task_protocol == "tuzi_async"
                    and len(job.params.provider_task_ids or []) == (job.params.n or 1)
                ):
                    queued.append(request.job_id)
                else:
                    request.execution_state = "needs_review"
                    request.execution_message = "服务中断后无法确认上游结果，请核对订单；不会自动重新出图"
                    _save(request)
                    update_job_status(job.job_id, status=JobStatus.FAILED,
                                      error=request.execution_message)
    return queued


def record_execution_rejection(job_id: str, message: str) -> None:
    job = read_job(job_id)
    if job.workshop_request_id:
        try:
            with file_lock(request_path(job.workshop_request_id).with_suffix(".lock")):
                request = read_request(job.workshop_request_id)
                if request.job_id == job_id:
                    request.execution_state = "needs_review"
                    request.execution_message = message
                    _save(request)
        except WorkshopError:
            pass
    if job.status == JobStatus.PENDING:
        update_job_status(job_id, status=JobStatus.FAILED, error=message)
