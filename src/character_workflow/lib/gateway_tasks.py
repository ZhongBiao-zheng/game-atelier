"""局域网网关任务（ADR-0025）：替接入端出图，走网关自己的路由组与失败切换。

网关任务不写进 `.runtime/jobs/`：网关主人的出图历史里不出现同事的图。任务文件与图片在
`.runtime/gateway/{tasks,files}/` 保留 24 小时供接入端下载；每个任务结束时向
`.runtime/gateway/usage/YYYY-MM.jsonl` 追加一行使用记录（估价、结算金额与用量）。

失败切换规则与 Job 完全一样（`model_routes.failover_reason`）：只在确定没执行的失败上换下一家。
网关不转发给另一个网关（成员里 `provider="atelier"` 的一律跳过），避免两台网关互相转发。
"""
from __future__ import annotations

import copy
import json
import logging
import mimetypes
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from character_workflow.lib import (
    data_root, gateway_access, gateway_keys, gateway_quota, keys, model_routes,
)
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.corrupt_files import count_files, parse_reason, quarantine
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.gateway_keys import GatewayKeyRecord
from character_workflow.lib.timed_lock import TimedLock

GATEWAY_PROVIDER = "atelier"
MAX_IMAGES_PER_TASK = 8
MAX_PROMPT_CHARS = 32_000
MAX_RUNNING = 8
MAX_RUNNING_PER_KEY = 4
RETENTION = timedelta(hours=24)
QUARANTINE_RETENTION = timedelta(days=30)

logger = logging.getLogger(__name__)

# 接入端能控制的只有这些出图参数；任何本机路径类字段（参考图、蒙版、MJ 参考）都不收，
# 参考图只能以文件上传。否则局域网里的人能让网关读它本机的任意文件。
_IMAGE_PARAMS = frozenset({
    "size", "size_mode", "custom_size", "ratio", "resolution", "quality", "background",
    "complexity", "output_format", "frame_count", "frame_duration_ms",
    "steps", "cfg_scale", "requested_size", "workflow_inputs",
    "bot_type", "mj_version", "mj_stylize", "mj_chaos", "mj_weird", "mj_seed", "mj_no",
    "mj_tile", "mj_iw", "mj_sref_code", "mj_profile", "mj_sw", "mj_cw", "mj_ow", "mj_flags",
})

ALLOWED_PARAMS_BY_KIND = {
    "image": _IMAGE_PARAMS,
    "image_edit": _IMAGE_PARAMS | {"image_edit"},
    "layer_split": _IMAGE_PARAMS | {"layer_decomposition"},
    "video": frozenset({"duration", "resolution", "ratio", "mode", "frame_mode",
                        "generate_audio", "watermark"}),
    "audio": frozenset({"voice", "speed", "response_format", "instructions", "lyrics", "instrumental"}),
}
FILE_GROUPS = {"ref": 16, "mask": 1, "mj_sref": 8, "mj_cref": 8, "mj_oref": 8,
               "video": 4, "audio": 4}
FILE_PARAMS = {"ref": "reference_images", "mask": "mask_image", "mj_sref": "mj_sref",
               "mj_cref": "mj_cref", "mj_oref": "mj_oref", "video": "reference_videos",
               "audio": "reference_audios"}
FILES_BY_KIND = {"image": {"ref", "mask", "mj_sref", "mj_cref", "mj_oref"},
                 "image_edit": {"ref", "mask"}, "layer_split": {"ref"},
                 "video": {"ref", "video", "audio"}, "audio": set()}


def modality_for(kind: str) -> str:
    return "image" if kind in {"image", "image_edit", "layer_split"} else kind


def file_limit(group: str) -> int:
    return (200 if group == "video" else 20) * 1024 * 1024


class EditOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["inpaint", "outpaint"]
    x: int = Field(default=0, ge=-16000, le=16000, strict=True)
    y: int = Field(default=0, ge=-16000, le=16000, strict=True)
    width: int | None = Field(default=None, gt=0, le=16384, strict=True)
    height: int | None = Field(default=None, gt=0, le=16384, strict=True)


class GatewayExtra(BaseModel):
    role: str
    file: str


TaskStatus = Literal["pending", "running", "done", "failed", "canceled"]
# 实付金额从哪来：upstream = 上游回报的真实金额（EvoLink / OpenRouter 的 usage.cost）；
# price_table = 本机价格表 × 上游回报的数量（语音字数、图层数、歌曲数）。旧任务没有这个字段（None）。
CostSource = Literal["upstream", "price_table"]
ErrorKind = Literal["unavailable", "unconfirmed", "failed"]
TERMINAL: frozenset[str] = frozenset({"done", "failed", "canceled"})
# caller 落进 params 的续查状态；本机任务重启续查用的是同一组键（lib/jobs.py）。
RESUME_KEYS = ("provider_task_protocol", "provider_task_ids", "mj_submission_ids",
               "mj_submit_uncertain", "evolink_state")
# 带着已存订单只轮询、不重新提交的协议（callers：openai_image 的 Tuzi 异步、declarative、
# evolink、yinchao_music；MJ 任务代理看 mj_submission_ids）。
RESUMABLE_PROTOCOLS = frozenset({"tuzi_images", "declarative", "evolink", "yinchao"})
# 视频协议里有「凭已存订单只轮询」入口的（callers 收 resume_video、回报 on_resume_state）。
# 续查状态存在 resume_params["video"]：{"protocol", "tasks": [{"id", ...}], "sent"?}，内容由各 caller 定。
VIDEO_RESUMABLE_PROTOCOLS = frozenset({
    "evolink", "openrouter", "seedance", "kling", "klingai", "dashscope"})


def is_unpriced(record: Any) -> bool:
    """成功但没有任何价格依据：实付、预估都为空，扣费也为 0（0 只是配额账本的占位）。

    任务对象与用量行（dict）共用这一判据；旧用量行没有新字段也能按原字段推断。
    """
    get = record.get if isinstance(record, dict) else (lambda name: getattr(record, name, None))
    return (get("status") == "done" and get("actual_cost_cny") is None
            and get("estimated_cny") is None and not get("charged_cny"))


class GatewayTask(BaseModel):
    task_id: str
    key_id: str
    key_name: str
    idempotency_key: str = Field(max_length=200)
    route_id: str
    kind: Literal["image", "image_edit", "layer_split", "video", "audio", "text"] = "image"
    estimated_cny: float | None = None
    reserved_cny: float = 0
    charged_cny: float = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    # 文本：上游已接受请求却没回用量（流式中途断开、没有用量块）。成员扣 0，由主机承担。
    usage_missing: bool | None = None
    prompt: str
    n: int
    size: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    files: dict[str, list[str]] = Field(default_factory=dict)
    extras: list[GatewayExtra] = Field(default_factory=list)
    layer_result: dict | None = None
    output_types: list[str] = Field(default_factory=list)
    member_trail: list[str] = Field(default_factory=list)
    upstream_task_ids: list[str] = Field(default_factory=list)
    # caller 续查要用的状态（订单号、协议、MJ 提交号、EvoLink 状态）；主机重启后凭它只轮询、不重提。
    resume_params: dict[str, Any] | None = None
    submission_attempts: list[dict] = Field(default_factory=list)
    status: TaskStatus = "pending"
    phase: str | None = None
    member_alias: str | None = None
    member_provider: str | None = None
    member_base_url: str | None = None
    member_model_id: str | None = None
    route_tried: list[str] = Field(default_factory=list)
    route_order: list[str] | None = None
    warnings: list[str] = Field(default_factory=list)
    actual_size: str | None = None
    actual_cost_cny: float | None = None
    actual_cost_source: CostSource | None = None
    outputs: list[str] = Field(default_factory=list)
    error: str | None = None
    error_kind: ErrorKind | None = None
    cancel_requested: bool = False
    created_at: str
    # 开始执行（离开排队）的时间；旧任务文件没有这个字段。
    started_at: str | None = None
    # 第一次把请求交给上游 caller 的时间（失败切换不覆盖）；None = 从没发出过。用于对账，不参与扣费。
    sent_at: str | None = None
    updated_at: str

    @field_validator("created_at", "updated_at", "started_at", "sent_at")
    @classmethod
    def _aware_iso_time(cls, value: str | None) -> str | None:
        # 清理与排序要拿它和带时区的时间比较；读不出的时间按坏文件处理，不能让清理抛错。
        if value is not None and datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("时间必须带时区")
        return value


class GatewayRequestError(Exception):
    """接入端请求不合法或不能受理；status 直接作为 HTTP 状态码。"""

    def __init__(self, status: int, message: str, *, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


# ---- 存储 ----

def _root() -> Path:
    return data_root.runtime_dir() / "gateway"


def _task_file(task_id: str) -> Path:
    return _root() / "tasks" / f"{task_id}.json"


def _files_dir(task_id: str) -> Path:
    return _root() / "files" / task_id


def usage_file(month: str) -> Path:
    return _root() / "usage" / f"{month}.jsonl"


def quarantine_dir() -> Path:
    """读不出的任务文件原样移到这里，不再参与受理、调度、清理与恢复。"""
    return _root() / "quarantine"


def quarantined_count() -> int:
    return count_files(quarantine_dir())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# 受理、调度、额度、结算共用；持有超过 200 ms 记一条告警（timed_lock），用来判断锁内全量扫盘是否成了瓶颈。
_lock = TimedLock("gateway_tasks._lock")
_running: dict[str, str] = {}  # task_id → key_id


def _workflow_name(task: GatewayTask) -> str | None:
    # Workflow route ids are opaque comfyui-<uuid>; the admin list needs the imported name.
    if task.member_provider != "comfyui" or not task.member_alias:
        return None
    from character_workflow.lib.keys import find_by_alias

    key = find_by_alias(task.member_alias)
    return next((model.name for model in key.models if model.id == task.member_model_id),
                None) if key else None


def task_snapshot(task: GatewayTask) -> dict:
    return {**task.model_dump(include={"task_id", "kind", "key_name", "route_id", "member_alias",
            "member_trail", "phase", "status", "created_at", "updated_at", "n", "output_types", "error"}),
            "prompt": task.prompt if task.kind != "text" else None, "outputs": len(task.outputs),
            "workflow_name": _workflow_name(task),
            # 按幂等键取消、主机没收到提交时记的占位（第 5 批 5-3）：没有路由、提示词、用量，任务列表单独标出。
            "placeholder": task.route_id == TOMBSTONE_ROUTE}


def _save(task: GatewayTask) -> GatewayTask:
    task = task.model_copy(update={"updated_at": _now().isoformat()})
    atomic_write_json(_task_file(task.task_id), task.model_dump(mode="json"))
    from . import gateway_live
    gateway_live.notify(task_snapshot(task))
    return task


def _read(task_id: str) -> GatewayTask | None:
    """读一个任务；文件损坏时隔离并当作不存在，一条坏文件不能让整个网关停摆。"""
    path = _task_file(task_id)
    try:
        return GatewayTask.model_validate_json(read_text_with_retry(path))
    except FileNotFoundError:
        return None
    except ValueError as error:  # JSON / UTF-8 / 校验
        quarantine(path, quarantine_dir(), f"网关任务 {parse_reason(error)}")
        return None


def _all_tasks() -> list[GatewayTask]:
    folder = _root() / "tasks"
    if not folder.is_dir():
        return []
    tasks = [_read(path.stem) for path in folder.glob("*.json")]
    return sorted((task for task in tasks if task), key=lambda task: task.created_at)


def _update(task_id: str, **changes: Any) -> GatewayTask:
    with _lock:
        task = _read(task_id)
        assert task is not None
        return _save(task.model_copy(update=changes))


# ---- 受理 ----

def _gateway_members(route: model_routes.ModelRoute) -> list[model_routes.RouteMember]:
    return [member for member in route.members if member.provider != GATEWAY_PROVIDER]


def submit(
    key: GatewayKeyRecord, *, idempotency_key: str, model: str, prompt: str, n: int,
    size: str | None, params: dict[str, Any], files: dict[str, list[tuple[str, bytes]]],
    kind: str = "image",
) -> GatewayTask:
    from character_workflow.lib.schemas import JobParams

    if not isinstance(kind, str) or kind not in ALLOWED_PARAMS_BY_KIND:
        raise GatewayRequestError(422, "不支持的任务类型")
    gateway_access.check_route(key, modality_for(kind), model)
    if not idempotency_key or len(idempotency_key) > 200:
        raise GatewayRequestError(422, "缺少 Idempotency-Key")
    unknown = sorted(set(params) - ALLOWED_PARAMS_BY_KIND[kind])
    if unknown:
        raise GatewayRequestError(422, f"网关不接受这些参数：{', '.join(unknown)}")
    try:
        params = JobParams.model_validate(params).model_dump(exclude_unset=True)
    except ValidationError as error:
        raise GatewayRequestError(422, "网关任务参数格式不对") from error
    if kind == "image_edit":
        try:
            options = EditOptions.model_validate(params.get("image_edit"))
        except ValidationError as error:
            raise GatewayRequestError(422, "编辑参数格式不对") from error
        if not files.get("ref") or not files.get("mask"):
            raise GatewayRequestError(422, "图片编辑需要源图和蒙版")
        if options.mode == "outpaint" and (options.width is None or options.height is None):
            raise GatewayRequestError(422, "扩图需要画布宽高")
        params["image_edit"] = options.model_dump(exclude_none=True)
    if kind == "layer_split":
        if params.get("layer_decomposition") is not True or len(files.get("ref", [])) != 1:
            raise GatewayRequestError(422, "图层拆分需要一张源图和 layer_decomposition=true")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise GatewayRequestError(422, "提示词为空或过长")
    if not 1 <= n <= MAX_IMAGES_PER_TASK:
        raise GatewayRequestError(422, f"张数必须在 1–{MAX_IMAGES_PER_TASK} 之间")
    for group, uploads in files.items():
        if group not in FILES_BY_KIND[kind] or len(uploads) > FILE_GROUPS[group]:
            raise GatewayRequestError(422, "素材类型或数量不对")
        if any(len(data) > file_limit(group) for _, data in uploads):
            raise GatewayRequestError(413, "素材文件过大")

    with _lock:
        existing = next((task for task in _all_tasks()
                         if task.key_id == key.id and task.idempotency_key == idempotency_key), None)
        if existing:
            return existing
        route_order: list[str] = []
        selection_params = {**params, "n": n, "size": size}
        for group, field in (("ref", "reference_images"), ("video", "reference_videos"),
                             ("audio", "reference_audios")):
            selection_params[field] = [name for name, _ in files.get(group, [])]
        picked = _pick_member(model, [], key, modality_for(kind), params=selection_params,
                              consume=False)
        if picked is None:
            raise GatewayRequestError(503, "网关没有可用的供应商")
        inputs = picked[1].workflow_inputs
        if not prompt.strip() and kind != "layer_split" and not (
            inputs is not None and not any(item.type == "prompt" for item in inputs)
        ):
            raise GatewayRequestError(422, "提示词为空或过长")
        estimate = _estimate(picked, n, size, params, kind, bool(files.get("video")),
                             text_length=len(prompt.strip()) if kind == "audio" else None)
        gateway_quota.admit(key, estimate or 0)
        picked = _pick_member(model, [], key, modality_for(kind), params=selection_params,
                              freeze_order=route_order, consume=True)
        if picked is None:
            raise GatewayRequestError(503, "网关没有可用的供应商")
        task_id = uuid.uuid4().hex
        stored = {}
        for group, uploads in files.items():
            stored[group] = []
            for index, (name, data) in enumerate(uploads):
                suffix = Path(name).suffix.lower()[:8] or ".bin"
                target = _files_dir(task_id) / "refs" / f"{group}-{index}{suffix}"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                stored[group].append(target.name)
        now = _now().isoformat()
        task = _save(GatewayTask(
            task_id=task_id, key_id=key.id, key_name=key.name, idempotency_key=idempotency_key,
            route_id=model, kind=kind, prompt=prompt, n=n, size=size, params=params, files=stored,
            created_at=now, updated_at=now, estimated_cny=estimate, reserved_cny=estimate or 0,
            route_order=route_order, member_alias=picked[0].alias,
            member_provider=picked[0].provider, member_base_url=picked[0].base_url,
            member_model_id=picked[1].id,
        ))
    logger.info("网关任务受理 task=%s key=%s route=%s kind=%s n=%d member=%s", task.task_id,
                task.key_id, task.route_id, task.kind, task.n, task.member_alias)
    pump()
    return task


def _estimate(picked, n: int, size: str | None, params: dict, kind="image",
              has_reference_video=False, text_length: int | None = None) -> float | None:
    from character_workflow.lib.generation_pricing import estimate_cost_cny
    from character_workflow.lib.image_size import normalize_image_size_params

    from character_workflow.lib.generation_pricing import with_manual_price

    member, model = picked
    effective = {**params, "n": n}
    if size is not None:
        effective["size"] = size
    if effective.get("size_mode") is not None:
        try:
            effective = normalize_image_size_params(member, model.id, effective)
        except ValueError as error:
            raise GatewayRequestError(422, str(error)) from error
    return with_manual_price(estimate_cost_cny(
        kind=modality_for(kind), provider=member.provider, base_url=member.base_url,
        billing_group=member.billing_group, model_id=model.id, protocol=model.protocol, n=n,
        size=effective.get("size"), size_mode=effective.get("size_mode"),
        quality=effective.get("quality"), resolution=effective.get("resolution"),
        duration=effective.get("duration"), ratio=effective.get("ratio"),
        generate_audio=effective.get("generate_audio", False),
        has_reference_video=has_reference_video, image_edit=kind == "image_edit",
        text_length=text_length,
    ), model)


def get_task(key_id: str, task_id: str) -> GatewayTask:
    task = _read(task_id) if _is_task_id(task_id) else None
    if task is None or task.key_id != key_id:
        raise GatewayRequestError(404, "任务不存在")
    return task


def output_file(key_id: str, task_id: str, index: int) -> Path:
    task = get_task(key_id, task_id)
    if task.status != "done" or not 0 <= index < len(task.outputs):
        raise GatewayRequestError(404, "产物不存在")
    return _files_dir(task_id) / "out" / task.outputs[index]


def extra_file(key_id: str, task_id: str, index: int) -> Path:
    task = get_task(key_id, task_id)
    if task.status != "done" or not 0 <= index < len(task.extras):
        raise GatewayRequestError(404, "过程图不存在")
    return _files_dir(task_id) / "extras" / task.extras[index].file


# 按幂等键取消、主机还没收到这把键时记的「已取消」占位任务：route_id 为空，不写用量行。
TOMBSTONE_ROUTE = ""
TOMBSTONE_LIMIT = 200  # 每把网关密钥在保留期（24 小时）内最多这么多个占位
CancelOutcome = Literal["canceled", "continuing", "finished"]


def cancel(key_id: str, task_id: str) -> GatewayTask:
    """成员停止（飙哥定 Q3-1=B「跑完并计费」）：还没发上游的取消、扣 0；已发上游的照常跑完、按成功规则计费，
    不设取消标记。回应里的 `cancel_outcome`（见 `cancel_outcome`）告诉成员是哪一种。"""
    task = get_task(key_id, task_id)
    if task.status in TERMINAL:
        return task
    logger.info("网关任务请求取消 task=%s", task_id)
    with _lock:
        current = _read(task_id)
        if current and current.status == "pending":
            return _finish(current, status="canceled", error="已停止")
        if current and current.status == "running" and (
                current.sent_at is None or _runs_on_this_host(current)):
            # 刚开始执行、还没发出：run_task 发上游前在同一把锁里看到标记就取消。
            # 主机本机执行的任务例外（见 _runs_on_this_host）：能真正中断、不计费，「跑完并计费」的理由不成立。
            return _update(task_id, cancel_requested=True)
        return current or task


def _runs_on_this_host(task: GatewayTask) -> bool:
    """任务是不是在主机本机执行（目前只有本机 ComfyUI）：按执行方式判断——供应商是 ComfyUI 且地址是本机。
    这类任务不经任何计费上游、能中断或移出队列，停止时真的取消、扣 0（对 Q3-1「跑完并计费」的解释，
    理由是那条决定针对上游取消不了或取消照扣的任务）。计费的云端 ComfyUI（如 RunningHub）走别的协议或非本机地址，
    不在其列。"""
    if task.member_provider != "comfyui":
        return False
    from character_workflow.lib.comfyui_schema import local_base_url

    try:
        local_base_url(task.member_base_url)
    except ValueError:
        return False
    return True


def cancel_outcome(task: GatewayTask) -> CancelOutcome:
    """取消请求的结果：canceled（没发上游，已取消或马上取消、扣 0）/ continuing（已发上游，会跑完并计费）/
    finished（取消前已经结束，按原结局）。成员端文案按它选，不按状态猜。"""
    if task.status == "canceled" or (task.status not in TERMINAL and task.cancel_requested):
        return "canceled"
    if task.status in TERMINAL:
        return "finished"
    return "continuing"


def cancel_by_key(key: GatewayKeyRecord, idempotency_key: str) -> GatewayTask:
    """按幂等键取消（成员不知道主机任务号时，例如提交结果未确认）。主机还没收到这把键时记一个「已取消」占位：
    后到的同键提交直接拿到它，不会执行。只接受格式合法、签发不满 20 小时的键；查找与建占位在同一把锁里，
    与 `submit` 的去重查找互斥。"""
    from character_workflow.lib.jobs import gateway_key_expired

    if gateway_key_expired(idempotency_key):
        raise GatewayRequestError(422, "幂等键格式不对或已超过 20 小时")
    with _lock:
        tasks = [task for task in _all_tasks() if task.key_id == key.id]
        existing = next((task for task in tasks if task.idempotency_key == idempotency_key), None)
        if existing is None:
            if sum(task.route_id == TOMBSTONE_ROUTE for task in tasks) >= TOMBSTONE_LIMIT:
                raise GatewayRequestError(429, "停止请求太多，请稍后再试")
            now = _now().isoformat()
            placeholder = _save(GatewayTask(
                task_id=uuid.uuid4().hex, key_id=key.id, key_name=key.name,
                idempotency_key=idempotency_key, route_id=TOMBSTONE_ROUTE, prompt="", n=0,
                status="canceled", error="已停止", created_at=now, updated_at=now))
            logger.info("网关任务按幂等键取消，主机未收到，记占位 task=%s", placeholder.task_id)
            return placeholder
    return cancel(key.id, existing.task_id)


def _is_task_id(value: str) -> bool:
    return len(value) == 32 and all(char in "0123456789abcdef" for char in value)


# ---- 调度 ----

def _update_in_progress() -> bool:
    """主机正在应用内更新（排空或等重启）：排队任务留着，更新后的新进程接着跑（排队任务重启后保持排队）。"""
    from viewer_server.update_routes import admission

    return admission().blocked()


def pump() -> None:
    """按提交顺序启动排队任务：全局最多 8 个、每把密钥最多 4 个同时执行；主机更新期间不启动。"""
    if _update_in_progress():
        return
    with _lock:
        for task in _all_tasks():
            if len(_running) >= MAX_RUNNING:
                return
            if task.status != "pending" or task.task_id in _running:
                continue
            if sum(1 for owner in _running.values() if owner == task.key_id) >= MAX_RUNNING_PER_KEY:
                continue
            _running[task.task_id] = task.key_id
            started = _now()
            _save(task.model_copy(update={
                "status": "running", "phase": "resuming" if task.resume_params else "queued",
                "started_at": task.started_at or started.isoformat()}))
            logger.info("网关任务开始 task=%s 排队=%.1fs", task.task_id,
                        _seconds(task.created_at, started.isoformat()) or 0)
            threading.Thread(target=_execute, args=(task.task_id,), daemon=True,
                             name=f"gateway-{task.task_id[:8]}").start()


def _execute(task_id: str) -> None:
    try:
        task = _read(task_id)
        if task is not None:
            run_task(task)
    finally:
        with _lock:
            _running.pop(task_id, None)
        pump()


def run_task(task: GatewayTask) -> GatewayTask:
    """执行一个网关任务直到终态；同步调用，测试直接用它。"""
    from character_workflow.lib.callers import dispatch, dispatch_audio, dispatch_video
    from character_workflow.lib.image_size import normalize_image_size_params
    from character_workflow.lib.job_runner import JobCanceled
    from character_workflow.lib.comfyui_client import ComfyUIUnavailableError

    task_id = task.task_id
    modality = modality_for(task.kind)
    tried: list[str] = []
    warnings: list[str] = []
    switched_from: tuple[str, model_routes.FailoverReason] | None = None
    last_error: BaseException | None = None

    def should_cancel() -> bool:
        current = _read(task_id)
        return bool(current and current.cancel_requested)

    while True:
        try:
            config = gateway_keys.read_config()
        except gateway_keys.GatewayConfigCorruptError as error:
            return _finish(_read(task_id), status="failed", error=str(error),
                           error_kind="unavailable")
        resume = _read(task_id).resume_params

        def refuse(message: str) -> GatewayTask:
            # 续查时上游已有订单：停在这里也只能判「未确认」，不能当成没执行。
            if resume:
                return _finish(_read(task_id), status="failed", error_kind="unconfirmed",
                               error=f"网关重启后无法续查（{message}），上游任务结果未确认")
            return _finish(_read(task_id), status="failed", error=message)

        owner = next((item for item in config.keys
                      if item.id == task.key_id and item.revoked_at is None), None)
        if owner is None:
            return refuse("网关密钥无效或已撤销")
        try:
            gateway_access.check_route(owner, modality, task.route_id)
        except GatewayRequestError as error:
            return refuse(error.message)
        if resume:
            # 主机重启后续查：只找原来那一家，凭已存订单轮询；不选别家、不重新提交。
            picked = _resume_member(_read(task_id))
            if picked is None:
                return _finish(_read(task_id), status="failed", error_kind="unconfirmed",
                               error="网关重启后原供应商已不可用，未确认是否已出图")
        else:
            try:
                picked = _pick_member(task.route_id, tried, owner, modality,
                                      route_order=task.route_order, params=task.params)
            except GatewayRequestError as error:
                return _finish(_read(task_id), status="failed", error=error.message,
                               error_kind="unavailable")
            if picked is None:
                return _exhausted(task_id, tried, warnings, switched_from, last_error)
        key, model = picked
        params: dict[str, Any] = {**task.params, "n": task.n, **{
            name: copy.deepcopy(value) for name, value in (resume or {}).items() if name in RESUME_KEYS}}
        if task.size is not None:
            params["size"] = task.size
        for group, names in task.files.items():
            paths = [str(_files_dir(task_id) / "refs" / name) for name in names]
            params[FILE_PARAMS[group]] = paths[0] if group == "mask" else paths
        if params.get("size_mode") is not None:
            try:
                params = normalize_image_size_params(key, model.id, params)
            except ValueError as error:
                tried.append(key.alias)
                last_error = error
                continue
        if switched_from:
            alias, reason = switched_from
            warnings.append(f"{alias}{model_routes.FAILOVER_LABELS[reason]}，已改用 {key.alias}")
        with _lock:
            if _read(task_id).cancel_requested:
                # 成员在发上游之前停止了（cancel 在同一把锁里只对还没发出的任务设标记）：取消、扣 0。
                return _finish(_read(task_id), status="canceled", error="已停止")
            sent = _update(task_id, member_alias=key.alias, member_provider=key.provider,
                           member_base_url=key.base_url, member_model_id=model.id, phase="sent",
                           route_tried=list(tried), member_trail=[*tried, key.alias],
                           warnings=list(warnings))
            if sent.sent_at is None:
                _update(task_id, sent_at=_now().isoformat())
        logger.info("网关任务发往上游 task=%s member=%s model=%s", task_id, key.alias, model.id)
        cost: dict[str, float] = {}
        with tempfile.TemporaryDirectory(prefix=f"gateway-{task_id[:8]}-") as tmp:
            try:
                def changed():
                    state = {name: copy.deepcopy(params[name]) for name in RESUME_KEYS
                             if params.get(name) not in (None, [], {})}
                    video_state = (_read(task_id).resume_params or {}).get("video")
                    if video_state:
                        state["video"] = video_state
                    _update(task_id, upstream_task_ids=params.get("provider_task_ids") or [],
                            resume_params=state or None)

                def on_resume_state(video_state):
                    # 视频 caller 每提交一单就回报一次续查所需的全部状态（订单、轮询地址、回显过滤集合）。
                    current = dict(_read(task_id).resume_params or {})
                    current["video"] = {"protocol": video_protocol, **copy.deepcopy(video_state)}
                    _update(task_id, resume_params=current)

                def on_task_id(identifier):
                    ids = list((_read(task_id)).upstream_task_ids)
                    if identifier not in ids:
                        _update(task_id, upstream_task_ids=[*ids, identifier])
                        logger.info("网关任务拿到上游订单 task=%s member=%s upstream=%s",
                                    task_id, key.alias, identifier)

                def on_submission(attempt):
                    previous = [a for a in _read(task_id).submission_attempts
                                if a.get("attempt") != attempt.get("attempt")]
                    _update(task_id, submission_attempts=[*previous, attempt])

                render = dispatch
                if task.kind == "image_edit":
                    from character_workflow.lib.callers.image_edit import render
                elif task.kind == "video":
                    render = dispatch_video
                elif task.kind == "audio":
                    render = dispatch_audio
                video_kwargs: dict[str, Any] = {}
                if task.kind == "video":
                    from character_workflow.lib.callers import _effective_protocol

                    video_protocol = _effective_protocol(key, model.id)
                    video_kwargs["on_resume_state"] = on_resume_state
                    if resume and resume.get("video"):
                        if resume["video"].get("protocol") != video_protocol:
                            # 停机期间 KEY 被改过，按 KEY 算出的协议对不上存下的订单：
                            # 不把别的协议的续查状态交给 caller。
                            return _finish(_read(task_id), status="failed", error_kind="unconfirmed",
                                           error="网关重启后原供应商的视频接口已变，未确认是否已出片")
                        video_kwargs["resume_video"] = copy.deepcopy(resume["video"])
                paths = render(
                    prompt=task.prompt, model=model.id, alias=key.alias, output_dir=Path(tmp),
                    n=task.n, size=params.get("size"), params=params, job_id=task_id,
                    on_phase=lambda phase: _update(task_id, phase=phase),
                    on_params_changed=changed, on_task_id=on_task_id, on_submission=on_submission,
                    on_cost_usd=lambda usd: cost.__setitem__("usd", usd),
                    should_cancel=should_cancel, **video_kwargs,
                )
                return _store_outputs(task_id, [Path(path) for path in paths],
                                      0.0 if key.provider == "comfyui" else cost.pop("usd", None), params)
            except Exception as error:  # noqa: BLE001 — 每种失败都要落成终态
                _record_cost(task_id, cost.get("usd"))
                if isinstance(error, JobCanceled) or should_cancel():
                    return _finish(_read(task_id), status="canceled", error="已停止")
                if isinstance(error, ComfyUIUnavailableError):
                    return _finish(_read(task_id), status="failed", error=str(error),
                                   error_kind="unconfirmed" if error.execution_started else "unavailable")
                current = _read(task_id)
                from character_workflow.lib.callers.task_submission import is_unconfirmed

                uncertain = (any(a.get("outcome") == "unconfirmed" for a in current.submission_attempts)
                             or is_unconfirmed(error))
                if current.upstream_task_ids or current.resume_params or uncertain:
                    return _finish(current, status="failed", error="上游任务结果未确认：" + _safe_error(error),
                                   error_kind="unconfirmed")
                reason = model_routes.failover_reason(error)
                if reason is None:
                    # 未确认已在上面按类型（is_unconfirmed）与尝试记录处理；到这里的是明确的失败（第 6 批删了按文案判断）。
                    return _finish(_read(task_id), status="failed", error=_safe_error(error),
                                   error_kind="failed")
                model_routes.cool_down(modality, key.alias, reason)
                tried.append(key.alias)
                switched_from = (key.alias, reason)
                last_error = error
                continue


def resumable(task: GatewayTask) -> bool:
    """这个任务有没有能续查的上游订单（主机重启后只轮询、不重提）。"""
    state = task.resume_params or {}
    if state.get("provider_task_protocol") in RESUMABLE_PROTOCOLS and state.get("provider_task_ids"):
        return True
    video = state.get("video") or {}
    if video:
        # 提交结果未确认（没拿到订单号）的那一单可能也在上游跑：整个任务不续查，按未确认处理。
        unconfirmed = any(a.get("outcome") == "unconfirmed" for a in task.submission_attempts)
        return (video.get("protocol") in VIDEO_RESUMABLE_PROTOCOLS and bool(video.get("tasks"))
                and not unconfirmed)
    # MJ 任务代理：提交结果未确认的不续查（caller 自己也拒绝重提）。
    return bool(state.get("mj_submission_ids")) and not state.get("mj_submit_uncertain")


def _resume_member(task: GatewayTask):
    """续查只能用原来那一家：KEY 还在、启用、模型还在。"""
    if not task.member_alias or not task.member_model_id:
        return None
    key = keys.find_by_alias(task.member_alias)
    if key is None or not key.enabled:
        return None
    model = next((item for item in key.models if item.id == task.member_model_id), None)
    return (key, model) if model is not None else None


def _pick_member(
    route_id: str, tried: list[str], owner: GatewayKeyRecord, modality="image", *,
    params: dict | None = None, route_order: list[str] | None = None,
    freeze_order: list[str] | None = None, consume: bool = False,
):
    try:
        route = model_routes.find_route(modality, route_id)
    except model_routes.NoSuchRouteError:
        return None
    excluded = [m.alias for m in route.members
                if m.provider == GATEWAY_PROVIDER or not gateway_access.member_allowed(owner, m.alias)
                or not gateway_access.member_relayable(modality, m)]
    if len(excluded) == len(route.members):
        return None
    if route_order is None and not tried:
        try:
            return model_routes.resolve_auto(modality, route_id, params=params, exclude=excluded,
                                             route_order=freeze_order, consume=consume)
        except model_routes.InsufficientBalanceError as error:
            raise GatewayRequestError(503, str(error)) from error
    selected = model_routes.next_member(modality, route_id, [*excluded, *tried],
                                        route_order=route_order, params=params, fallback=not tried)
    if selected is None and not tried:
        raise GatewayRequestError(503, str(model_routes.InsufficientBalanceError(route_id)))
    return selected


def _exhausted(task_id, tried, warnings, switched_from, last_error) -> GatewayTask:
    detail = _safe_error(last_error) if last_error else "网关没有可用的供应商"
    # 只要最后一次是「确定没执行」的失败，接入端就可以换自己的 KEY。
    kind: ErrorKind = "unavailable" if switched_from else "failed"
    return _finish(_read(task_id), status="failed", error=f"网关的供应商都不可用：{detail}",
                   error_kind=kind, route_tried=list(tried), warnings=list(warnings))


def _record_cost(task_id: str, cost_usd: float | None) -> None:
    if cost_usd is None:
        return
    from character_workflow.lib.job_runner import USD_TO_CNY

    with _lock:
        task = _read(task_id)
        _update(task_id, actual_cost_source="upstream", actual_cost_cny=round(
            (task.actual_cost_cny or 0) + cost_usd * USD_TO_CNY, 6,
        ))


def _store_outputs(task_id: str, paths: list[Path], cost_usd: float | None,
                   params: dict | None = None) -> GatewayTask:
    from character_workflow.lib.job_runner import image_dimensions, is_valid_audio, is_valid_video
    from character_workflow.lib.schemas import LayerDecompositionResult

    _record_cost(task_id, cost_usd)
    params = params or {}
    # 按人民币回报实付的 caller（语音按计费字数、图层拆分按层数）直接写进 params。
    if cost_usd is None and isinstance(params.get("actual_cost_cny"), int | float):
        _update(task_id, actual_cost_cny=float(params["actual_cost_cny"]),
                actual_cost_source="price_table")
    task = _read(task_id)
    modality = modality_for(task.kind)
    validate = {"image": image_dimensions, "video": is_valid_video, "audio": is_valid_audio}[modality]
    valid = [path for path in paths if validate(path)]
    if task.kind not in {"layer_split", "video"} and task.member_provider != "comfyui":
        valid = valid[:task.n]
    if not valid:
        return _finish(task, status="failed", error=f"{task.member_alias} 没有返回有效产物",
                       error_kind="failed")
    layer_result = None
    if task.kind == "layer_split":
        layer_result = LayerDecompositionResult.model_validate(
            params.get("layer_decomposition_result")).model_dump(mode="json")
        if len(layer_result["outputs"]) != len(valid):
            raise ValueError("图层元数据与产物数量不一致")
    out = _files_dir(task_id) / "out"
    out.mkdir(parents=True, exist_ok=True)
    names, types, extras = [], [], []
    actual_size = None
    if modality == "image":
        width, height = image_dimensions(valid[0])
        actual_size = f"{width}x{height}"
    allowed_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm",
                        ".mp3", ".wav", ".flac", ".opus", ".aac", ".pcm"}
    for index, path in enumerate(valid):
        suffix = path.suffix.lower() if path.suffix.lower() in allowed_suffixes else ".png"
        name = f"{index}{suffix}"
        shutil.move(str(path), out / name)
        names.append(name)
        types.append({".pcm": "audio/pcm", ".opus": "audio/ogg"}.get(suffix)
                     or mimetypes.guess_type(name)[0] or "application/octet-stream")
    for index, item in enumerate(params.get("edit_inputs") or []):
        source = Path(item["path"])
        if not image_dimensions(source):
            raise ValueError("编辑过程图无效")
        name = f"{index}.png"
        target = _files_dir(task_id) / "extras" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), target)
        extras.append(GatewayExtra(role=item["role"], file=name))
    model_routes.mark_healthy(modality, task.member_alias)
    return _finish(task, status="done", outputs=names, output_types=types, extras=extras,
                   layer_result=layer_result, actual_size=actual_size)


def _safe_error(error: BaseException) -> str:
    from character_workflow.lib.job_runner import _friendly_error

    message = _friendly_error(error)
    for key in keys.read_keys_db().keys:
        for secret in (key.access_key, key.secret_key):
            if secret:
                message = message.replace(secret, "<redacted>")
    return message


def settled_charge(task: GatewayTask) -> float:
    """这次任务扣成员额度多少（飙哥定：失败只扣能确认上游已收费的）。

    - 成功：有实付扣实付，没有按估价扣（含主机手设单价）。
    - 失败 / 取消：只扣上游回报的真实金额（如多任务中途失败时已完成部分的 usage.cost）；
      价格表算出来的金额不算确认收费，扣 0。
    - 旧任务没有实付来源：沿用原规则（有实付就扣实付）。
    """
    if task.actual_cost_cny is not None and (
        task.status == "done" or task.actual_cost_source in (None, "upstream")
    ):
        return task.actual_cost_cny
    return (task.estimated_cny or 0) if task.status == "done" else 0


def _finish(task: GatewayTask, **changes: Any) -> GatewayTask:
    with _lock:
        current = _read(task.task_id)
        if current is not None and current.status in TERMINAL:
            return current
        done = task.model_copy(update={**changes, "phase": None})
        done.charged_cny = settled_charge(done)
        # Keep reservation -> settlement atomic to admission and /me readers.
        _append_usage(done)
        saved = _save(done)
    timing = _timing(saved, saved.updated_at)
    logger.info("网关任务结束 task=%s status=%s error_kind=%s member=%s 排队=%s 执行=%s",
                saved.task_id, saved.status, saved.error_kind, saved.member_alias,
                timing["queue_s"], timing["duration_s"])
    return saved


def _seconds(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return round(max(0.0, (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()), 1)


def _timing(task: GatewayTask, finished_at: str) -> dict[str, Any]:
    """排队 = 受理到开始（没开始就到结束）；执行 = 开始到结束。文本调用受理即开始。"""
    started = task.started_at or (task.created_at if task.kind == "text" else None)
    return {
        "queued_at": task.created_at, "started_at": started, "finished_at": finished_at,
        "queue_s": _seconds(task.created_at, started or finished_at),
        "duration_s": _seconds(started, finished_at),
    }


def _append_usage(task: GatewayTask, extra: dict[str, Any] | None = None) -> None:
    """extra：只属于这一行的附加字段（文本中转的 call_tag），不进任务文件。"""
    now = _now()
    row = {
        **_timing(task, now.isoformat()),
        # 对账用：失败任务里「已发出、上游可能已收费」与「从没发出」要分得开。
        "sent_to_upstream": task.sent_at is not None, "sent_at": task.sent_at,
        "upstream_task_ids": list(task.upstream_task_ids),
        "time": now.isoformat(), "task_id": task.task_id, "key_id": task.key_id,
        "key_name": task.key_name, "route_id": task.route_id, "member_alias": task.member_alias,
        "provider": task.member_provider, "base_url": task.member_base_url,
        "model_id": task.member_model_id, "n": len(task.outputs) if task.status == "done" else 0,
        "requested_n": task.n, "size": task.actual_size or task.params.get("size") or task.size,
        "quality": task.params.get("quality"), "resolution": task.params.get("resolution"),
        "status": task.status, "actual_cost_cny": task.actual_cost_cny,
        "actual_cost_source": task.actual_cost_source,
        "error_kind": task.error_kind, "kind": task.kind,
        "estimated_cny": task.estimated_cny, "charged_cny": task.charged_cny,
        "input_tokens": task.input_tokens, "output_tokens": task.output_tokens,
        "usage_missing": task.usage_missing,
        "duration": task.params.get("duration"),
        "member_trail": list(dict.fromkeys([
            *task.route_tried, *([task.member_alias] if task.member_alias else []),
        ])),
        **(extra or {}),
    }
    path = usage_file(now.astimezone().strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        # A retry after writing usage but before saving terminal state must not double-charge.
        if any(row.get("task_id") == task.task_id for row in read_usage(path.stem)):
            return
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_usage(month: str) -> list[dict[str, Any]]:
    """逐行读；截断、乱码或不是对象的行跳过（结算与额度每次都读，一行坏不能拖垮受理）。"""
    path = usage_file(month)
    if not path.is_file():
        return []
    rows = []
    for raw in path.read_bytes().splitlines():
        try:
            row = json.loads(raw)
        except ValueError:  # JSONDecodeError / UnicodeDecodeError
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def charged(row: dict[str, Any]) -> float:
    """用量行的扣费；手改坏的非数字按 0（只读，不改原行）。"""
    value = row.get("charged_cny")
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def read_usage_range(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Read all intersecting local-calendar month files, including cross-month weeks."""
    rows = []
    month = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    while month <= end:
        for row in read_usage(month.strftime("%Y-%m")):
            try:
                at = datetime.fromisoformat(row["time"])
                if start <= at <= end:
                    rows.append(row)
            except (KeyError, ValueError, TypeError):
                continue
        month = month.replace(year=month.year + 1, month=1) if month.month == 12 else (
            month.replace(month=month.month + 1)
        )
    return rows


def last_used_at(key_id: str) -> str | None:
    times = [task.created_at for task in _all_tasks() if task.key_id == key_id]
    for path in sorted((_root() / "usage").glob("*.jsonl"), reverse=True):
        found = [row["time"] for row in read_usage(path.stem) if row.get("key_id") == key_id]
        if found:
            times.extend(found)
            break
    return max(times, key=datetime.fromisoformat) if times else None


# ---- 启动恢复与清理 ----

def recover_after_restart() -> None:
    """网关进程重启后：

    - 还在排队、从没发给上游的任务：继续排队（不存在重复提交）。
    - 执行中且有能续查的上游订单、原供应商还在：改回排队，由 `pump` 续查，只轮询不重提。
    - 其余执行中的任务：不能确认有没有出图，判「未确认」失败，扣 0。

    调用方随后要 `pump()` 才会开始执行。
    """
    with _lock:
        for task in _all_tasks():
            if task.task_id in _running or task.status not in ("pending", "running"):
                continue
            if task.status == "pending":
                logger.info("网关任务重启后继续排队 task=%s", task.task_id)
                continue
            if resumable(task) and _resume_member(task) is not None:
                logger.warning("网关任务因重启转为续查 task=%s member=%s upstream=%d", task.task_id,
                               task.member_alias, len(task.upstream_task_ids))
                _save(task.model_copy(update={"status": "pending", "phase": "resuming"}))
                continue
            logger.warning("网关任务因重启中断 task=%s 原状态=%s upstream=%d", task.task_id,
                           task.status, len(task.upstream_task_ids))
            _finish(task, status="failed", error="网关重启，未确认是否已出图",
                    error_kind="unconfirmed")


def _prune_quarantine(now: datetime) -> None:
    """隔离文件按文件名里的隔离时间保留 30 天；名字解析不出的不动。"""
    cutoff = now - QUARANTINE_RETENTION
    folder = quarantine_dir()
    if not folder.is_dir():
        return
    for path in folder.glob("*.json"):
        try:
            stamp = datetime.strptime(path.stem.rsplit(".", 1)[-1], "%Y%m%dT%H%M%S%fZ")
        except ValueError:
            continue
        if stamp.replace(tzinfo=timezone.utc) < cutoff:
            path.unlink(missing_ok=True)


def cleanup(now: datetime | None = None) -> int:
    """删除 24 小时前的任务与图片、30 天前的隔离文件；返回删掉的任务数。"""
    cutoff = (now or _now()) - RETENTION
    removed = 0
    _prune_quarantine(now or _now())
    with _lock:
        for task in _all_tasks():
            # 没结束的任务（排队、执行、重启后待续查）不删：删了预占和接入端的结果都会丢。
            if (task.task_id in _running or task.status not in TERMINAL
                    or datetime.fromisoformat(task.created_at) > cutoff):
                continue
            shutil.rmtree(_files_dir(task.task_id), ignore_errors=True)
            _task_file(task.task_id).unlink(missing_ok=True)
            removed += 1
    return removed
