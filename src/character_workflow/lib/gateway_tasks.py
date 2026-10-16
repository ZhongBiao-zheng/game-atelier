"""局域网网关任务（ADR-0025）：替接入端出图，走网关自己的路由组与失败切换。

网关任务不写进 `.runtime/jobs/`：网关主人的出图历史里不出现同事的图。任务文件与图片在
`.runtime/gateway/{tasks,files}/` 保留 24 小时供接入端下载；每个任务结束时向
`.runtime/gateway/usage/YYYY-MM.jsonl` 追加一行使用记录（估价输入，费用由前端按价表算）。

失败切换规则与 Job 完全一样（`model_routes.failover_reason`）：只在确定没执行的失败上换下一家。
网关不转发给另一个网关（成员里 `provider="atelier"` 的一律跳过），避免两台网关互相转发。
"""
from __future__ import annotations

import json
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from character_workflow.lib import data_root, keys, model_routes
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.gateway_keys import GatewayKeyRecord

GATEWAY_PROVIDER = "atelier"
MAX_REFERENCE_IMAGES = 16
MAX_REFERENCE_BYTES = 20 * 1024 * 1024
MAX_IMAGES_PER_TASK = 8
MAX_PROMPT_CHARS = 32_000
MAX_RUNNING = 8
MAX_RUNNING_PER_KEY = 4
RETENTION = timedelta(hours=24)

# 接入端能控制的只有这些出图参数；任何本机路径类字段（参考图、蒙版、MJ 参考）都不收，
# 参考图只能以文件上传。否则局域网里的人能让网关读它本机的任意文件。
ALLOWED_PARAMS = frozenset({
    "size", "size_mode", "custom_size", "ratio", "resolution", "quality", "background",
    "steps", "cfg_scale", "requested_size",
    "bot_type", "mj_version", "mj_stylize", "mj_chaos", "mj_weird", "mj_seed", "mj_no",
    "mj_tile", "mj_iw", "mj_sref_code", "mj_profile", "mj_sw", "mj_cw", "mj_ow", "mj_flags",
})

TaskStatus = Literal["pending", "running", "done", "failed", "canceled"]
ErrorKind = Literal["unavailable", "unconfirmed", "failed"]
TERMINAL: frozenset[str] = frozenset({"done", "failed", "canceled"})


class GatewayTask(BaseModel):
    task_id: str
    key_id: str
    key_name: str
    idempotency_key: str = Field(max_length=200)
    route_id: str
    prompt: str
    n: int
    size: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    references: list[str] = Field(default_factory=list)
    status: TaskStatus = "pending"
    phase: str | None = None
    member_alias: str | None = None
    member_provider: str | None = None
    member_base_url: str | None = None
    member_model_id: str | None = None
    route_tried: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    actual_size: str | None = None
    actual_cost_cny: float | None = None
    outputs: list[str] = Field(default_factory=list)
    error: str | None = None
    error_kind: ErrorKind | None = None
    cancel_requested: bool = False
    created_at: str
    updated_at: str


class GatewayRequestError(Exception):
    """接入端请求不合法或不能受理；status 直接作为 HTTP 状态码。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ---- 存储 ----

def _root() -> Path:
    return data_root.runtime_dir() / "gateway"


def _task_file(task_id: str) -> Path:
    return _root() / "tasks" / f"{task_id}.json"


def _files_dir(task_id: str) -> Path:
    return _root() / "files" / task_id


def usage_file(month: str) -> Path:
    return _root() / "usage" / f"{month}.jsonl"


def _now() -> datetime:
    return datetime.now(timezone.utc)


_lock = threading.RLock()
_running: dict[str, str] = {}  # task_id → key_id


def _save(task: GatewayTask) -> GatewayTask:
    task = task.model_copy(update={"updated_at": _now().isoformat()})
    atomic_write_json(_task_file(task.task_id), task.model_dump(mode="json"))
    return task


def _read(task_id: str) -> GatewayTask | None:
    path = _task_file(task_id)
    if not path.is_file():
        return None
    return GatewayTask.model_validate_json(path.read_text(encoding="utf-8"))


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

def images_used_today(key_id: str) -> int:
    today = datetime.now().astimezone().date()
    return sum(
        task.n for task in _all_tasks()
        if task.key_id == key_id and task.status in ("pending", "running", "done")
        and datetime.fromisoformat(task.created_at).astimezone().date() == today
    )


def _gateway_members(route: model_routes.ModelRoute) -> list[model_routes.RouteMember]:
    return [member for member in route.members if member.provider != GATEWAY_PROVIDER]


def submit(
    key: GatewayKeyRecord, *, idempotency_key: str, model: str, prompt: str, n: int,
    size: str | None, params: dict[str, Any], references: list[tuple[str, bytes]],
) -> GatewayTask:
    if not idempotency_key or len(idempotency_key) > 200:
        raise GatewayRequestError(422, "缺少 Idempotency-Key")
    unknown = sorted(set(params) - ALLOWED_PARAMS)
    if unknown:
        raise GatewayRequestError(422, f"网关不接受这些参数：{', '.join(unknown)}")
    if not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        raise GatewayRequestError(422, "提示词为空或过长")
    if not 1 <= n <= MAX_IMAGES_PER_TASK:
        raise GatewayRequestError(422, f"张数必须在 1–{MAX_IMAGES_PER_TASK} 之间")
    if len(references) > MAX_REFERENCE_IMAGES:
        raise GatewayRequestError(422, f"参考图最多 {MAX_REFERENCE_IMAGES} 张")
    if any(len(data) > MAX_REFERENCE_BYTES for _name, data in references):
        raise GatewayRequestError(422, "单张参考图不能超过 20 MB")
    try:
        route = model_routes.find_route("image", model)
    except model_routes.NoSuchRouteError as error:
        raise GatewayRequestError(404, f"网关没有模型 {model}") from error
    if not _gateway_members(route):
        raise GatewayRequestError(404, f"网关没有模型 {model}")

    with _lock:
        existing = next((task for task in _all_tasks()
                         if task.key_id == key.id and task.idempotency_key == idempotency_key), None)
        if existing:
            return existing
        if key.daily_image_limit is not None and \
                images_used_today(key.id) + n > key.daily_image_limit:
            raise GatewayRequestError(429, "今日额度已用完")
        task_id = uuid.uuid4().hex
        stored = []
        for index, (name, data) in enumerate(references):
            suffix = Path(name).suffix.lower()[:8] or ".png"
            target = _files_dir(task_id) / "refs" / f"ref-{index}{suffix}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            stored.append(target.name)
        now = _now().isoformat()
        task = _save(GatewayTask(
            task_id=task_id, key_id=key.id, key_name=key.name, idempotency_key=idempotency_key,
            route_id=model, prompt=prompt, n=n, size=size, params=params, references=stored,
            created_at=now, updated_at=now,
        ))
    pump()
    return task


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


def cancel(key_id: str, task_id: str) -> GatewayTask:
    task = get_task(key_id, task_id)
    if task.status in TERMINAL:
        return task
    with _lock:
        current = _read(task_id)
        if current and current.status == "pending":
            return _finish(current, status="canceled", error="已停止")
    return _update(task_id, cancel_requested=True)


def _is_task_id(value: str) -> bool:
    return len(value) == 32 and all(char in "0123456789abcdef" for char in value)


# ---- 调度 ----

def pump() -> None:
    """按提交顺序启动排队任务：全局最多 8 个、每把密钥最多 4 个同时执行。"""
    with _lock:
        for task in _all_tasks():
            if len(_running) >= MAX_RUNNING:
                return
            if task.status != "pending" or task.task_id in _running:
                continue
            if sum(1 for owner in _running.values() if owner == task.key_id) >= MAX_RUNNING_PER_KEY:
                continue
            _running[task.task_id] = task.key_id
            _save(task.model_copy(update={"status": "running", "phase": "queued"}))
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
    from character_workflow.lib.callers import dispatch
    from character_workflow.lib.image_size import normalize_image_size_params
    from character_workflow.lib.job_runner import JobCanceled, _friendly_error

    task_id = task.task_id
    tried: list[str] = []
    warnings: list[str] = []
    switched_from: tuple[str, model_routes.FailoverReason] | None = None
    last_error: BaseException | None = None

    def should_cancel() -> bool:
        current = _read(task_id)
        return bool(current and current.cancel_requested)

    while True:
        picked = _pick_member(task.route_id, tried)
        if picked is None:
            return _exhausted(task_id, tried, warnings, switched_from, last_error)
        key, model = picked
        params: dict[str, Any] = {**task.params, "n": task.n}
        if task.size is not None:
            params["size"] = task.size
        if task.references:
            refs = _files_dir(task_id) / "refs"
            params["reference_images"] = [str(refs / name) for name in task.references]
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
        _update(task_id, member_alias=key.alias, member_provider=key.provider,
                member_base_url=key.base_url, member_model_id=model.id, phase="sent",
                route_tried=list(tried), warnings=list(warnings))
        cost: dict[str, float] = {}
        with tempfile.TemporaryDirectory(prefix=f"gateway-{task_id[:8]}-") as tmp:
            try:
                paths = dispatch(
                    prompt=task.prompt, model=model.id, alias=key.alias, output_dir=Path(tmp),
                    n=task.n, size=params.get("size"), params=params,
                    on_phase=lambda phase: _update(task_id, phase=phase),
                    on_params_changed=lambda: None,
                    on_cost_usd=lambda usd: cost.__setitem__("usd", usd),
                    should_cancel=should_cancel,
                )
            except Exception as error:  # noqa: BLE001 — 每种失败都要落成终态
                if isinstance(error, JobCanceled) or should_cancel():
                    return _finish(_read(task_id), status="canceled", error="已停止")
                reason = model_routes.failover_reason(error)
                if reason is None:
                    message = _friendly_error(error)
                    kind: ErrorKind = "unconfirmed" if "未确认" in message else "failed"
                    return _finish(_read(task_id), status="failed", error=message, error_kind=kind)
                model_routes.cool_down("image", key.alias, reason)
                tried.append(key.alias)
                switched_from = (key.alias, reason)
                last_error = error
                continue
            return _store_outputs(task_id, [Path(path) for path in paths], cost.get("usd"))


def _pick_member(route_id: str, tried: list[str]):
    try:
        route = model_routes.find_route("image", route_id)
    except model_routes.NoSuchRouteError:
        return None
    gateways = [m.alias for m in route.members if m.provider == GATEWAY_PROVIDER]
    picked = model_routes.next_member("image", route_id, exclude=[*gateways, *tried])
    members = _gateway_members(route)
    if picked is not None or tried or not members:
        return picked
    # 第一次选择时全组都在冷却：和「自动」一样仍用第一家。
    key = keys.find_by_alias(members[0].alias)
    model = next((item for item in key.models if item.id == members[0].model_id), None) if key else None
    return (key, model) if key and model else None


def _exhausted(task_id, tried, warnings, switched_from, last_error) -> GatewayTask:
    from character_workflow.lib.job_runner import _friendly_error

    detail = _friendly_error(last_error) if last_error else "网关没有可用的供应商"
    # 只要最后一次是「确定没执行」的失败，接入端就可以换自己的 KEY。
    kind: ErrorKind = "unavailable" if switched_from else "failed"
    return _finish(_read(task_id), status="failed", error=f"网关的供应商都不可用：{detail}",
                   error_kind=kind, route_tried=list(tried), warnings=list(warnings))


def _store_outputs(task_id: str, paths: list[Path], cost_usd: float | None) -> GatewayTask:
    from character_workflow.lib.job_runner import USD_TO_CNY, image_dimensions

    task = _read(task_id)
    valid = [(path, dims) for path in paths if (dims := image_dimensions(path))][: task.n]
    if not valid:
        return _finish(task, status="failed", error=f"{task.member_alias} 没有返回有效图片",
                       error_kind="failed")
    out = _files_dir(task_id) / "out"
    out.mkdir(parents=True, exist_ok=True)
    names = []
    for index, (path, _dims) in enumerate(valid):
        name = f"{index}{path.suffix.lower() or '.png'}"
        shutil.move(str(path), out / name)
        names.append(name)
    width, height = valid[0][1]
    cost = round(cost_usd * USD_TO_CNY, 6) if cost_usd is not None else None
    return _finish(task, status="done", outputs=names, actual_size=f"{width}x{height}",
                   actual_cost_cny=cost)


def _finish(task: GatewayTask, **changes: Any) -> GatewayTask:
    with _lock:
        done = _save(task.model_copy(update={**changes, "phase": None}))
    _append_usage(done)
    return done


def _append_usage(task: GatewayTask) -> None:
    now = _now()
    row = {
        "time": now.isoformat(), "task_id": task.task_id, "key_id": task.key_id,
        "key_name": task.key_name, "route_id": task.route_id, "member_alias": task.member_alias,
        "provider": task.member_provider, "base_url": task.member_base_url,
        "model_id": task.member_model_id, "n": len(task.outputs) if task.status == "done" else 0,
        "requested_n": task.n, "size": task.actual_size or task.params.get("size") or task.size,
        "quality": task.params.get("quality"), "resolution": task.params.get("resolution"),
        "status": task.status, "actual_cost_cny": task.actual_cost_cny,
        "error_kind": task.error_kind,
    }
    path = usage_file(now.astimezone().strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_usage(month: str) -> list[dict[str, Any]]:
    path = usage_file(month)
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


# ---- 启动恢复与清理 ----

def recover_after_restart() -> None:
    """网关进程重启：没开始的任务可以放心让接入端换家；执行中的不能确认有没有出图。"""
    with _lock:
        for task in _all_tasks():
            if task.task_id in _running:
                continue
            if task.status == "pending":
                _finish(task, status="failed", error="网关重启，任务未开始",
                        error_kind="unavailable")
            elif task.status == "running":
                _finish(task, status="failed", error="网关重启，未确认是否已出图",
                        error_kind="unconfirmed")


def cleanup(now: datetime | None = None) -> int:
    """删除 24 小时前的任务与图片；返回删掉的任务数。"""
    cutoff = (now or _now()) - RETENTION
    removed = 0
    with _lock:
        for task in _all_tasks():
            if task.task_id in _running or datetime.fromisoformat(task.created_at) > cutoff:
                continue
            shutil.rmtree(_files_dir(task.task_id), ignore_errors=True)
            _task_file(task.task_id).unlink(missing_ok=True)
            removed += 1
    return removed
