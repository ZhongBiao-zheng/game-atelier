"""首次启动引导的本机度量与 Key 探针。只存本机，不上报。

`<data_root>/.runtime/onboarding.json` 记录：首次看到首启页的时间、选完数据目录的时间、跳过引导的
时间与一串枚举事件。首次出图时间不另埋点，读取时从 `.runtime/jobs/` 推出（网关任务不写进 jobs，
天然不会把同事代跑的图算进来）。陌生人安装测试时读这份文件作基线。

事件只收枚举值：不收自由文本、URL 或密钥。
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

MAX_EVENTS = 500
_lock = threading.Lock()
# 服务进程第一次回 needs_data_root 的时间；选完目录才有地方落盘。
_first_seen_at: str | None = None

GuideSource = Literal["first_run", "model_chip", "providers"]
GuidePath = Literal["key", "chatgpt", "comfyui", "gateway", "other"]
GuideStep = Literal["signup", "topup", "key_page", "key_form"]
# 推荐厂商（web/src/lib/onboardingGuide.ts 的 presetId）；新增推荐厂商要同步加在这里。
GuideVendor = Literal["tuzi", "tokendance"]
ProbeResult = Literal["ok", "invalid", "unknown"]


class OnboardingEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: Literal[
        "guide_opened", "path_selected", "step_opened", "models_detected",
        "key_probed", "provider_saved", "skipped", "closed",
    ]
    source: GuideSource | None = None
    path: GuidePath | None = None
    step: GuideStep | None = None
    vendor: GuideVendor | None = None
    count: int | None = Field(default=None, ge=0, le=10_000)
    result: ProbeResult | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _file(root: Path | None = None) -> Path:
    return (root or data_root.resolve_data_root()) / ".runtime" / "onboarding.json"


def _read(root: Path | None = None) -> dict | None:
    try:
        payload = json.loads(_file(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _write(state: dict, root: Path | None = None) -> None:
    path = _file(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, state)


def _empty() -> dict:
    return {"first_seen_at": None, "data_root_set_at": None, "skipped_at": None, "events": []}


def note_first_seen() -> None:
    global _first_seen_at
    with _lock:
        _first_seen_at = _first_seen_at or _now()


def record_data_root_set(root: Path) -> None:
    """只在这个数据目录第一次被选中时写；复用旧目录不覆盖它原来的记录。"""
    with _lock:
        if _read(root) is not None:
            return
        now = _now()
        _write({**_empty(), "first_seen_at": _first_seen_at or now, "data_root_set_at": now}, root)


def is_skipped(root: Path | None = None) -> bool:
    state = _read(root)
    return bool(state and state.get("skipped_at"))


def append_event(event: OnboardingEvent) -> None:
    with _lock:
        state = _read() or _empty()
        events = [*state.get("events", []), {"at": _now(), **event.model_dump(exclude_none=True)}]
        next_state = {**state, "events": events[-MAX_EVENTS:]}
        if event.event == "skipped" and not state.get("skipped_at"):
            next_state["skipped_at"] = _now()
        _write(next_state)


def _first_done_job(since: str | None) -> dict | None:
    from character_workflow.lib.jobs import list_jobs
    from character_workflow.lib.schemas import JobStatus

    done = [
        job for job in list_jobs()
        if job.status == JobStatus.DONE and job.completed_at
        and (since is None or job.completed_at >= since)
    ]
    if not done:
        return None
    first = min(done, key=lambda job: job.completed_at or "")
    return {"completed_at": first.completed_at, "kind": first.kind.value, "namespace": first.namespace}


def _seconds_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds())


def _path_label(item: dict) -> str:
    return f"{item['path']}:{item['vendor']}" if item.get("vendor") else item["path"]


def metrics() -> dict:
    state = _read() or _empty()
    events = state.get("events", [])
    paths = [_path_label(item) for item in events if item.get("event") == "path_selected" and item.get("path")]
    saved = [_path_label(item) for item in events if item.get("event") == "provider_saved" and item.get("path")]
    first_done = _first_done_job(state.get("data_root_set_at"))
    first_done_at = first_done["completed_at"] if first_done else None
    return {
        "first_seen_at": state.get("first_seen_at"),
        "data_root_set_at": state.get("data_root_set_at"),
        "skipped_at": state.get("skipped_at"),
        "paths_tried": list(dict.fromkeys(paths)),
        "completed_path": saved[0] if saved else None,
        "last_event": events[-1] if events else None,
        "first_generation": first_done,
        "seconds_to_first_generation": _seconds_between(state.get("first_seen_at"), first_done_at),
        "event_count": len(events),
    }


# Key 探针：只打这几家「需要鉴权、不计费」的账户接口。URL 写死在服务端，调用方给的请求地址只用来
# 核对，决定不了密钥发往哪里。各家接口见 .scratch/key-onboarding/PLAN.md §5.4。
KEY_PROBES: dict[str, str] = {
    "tokendance": "https://tokendance.space/portal/api/v1/user/balance",
    "tuzi": "https://api.tu-zi.com/v1/dashboard/billing/subscription",
    "openai-hk": "https://api.openai-hk.com/v1/dashboard/billing/subscription",
    "openrouter": "https://openrouter.ai/api/v1/key",
    "seedream": "https://ark.cn-beijing.volces.com/api/v3/models",
}
# 各预置的默认请求地址（与 web 的 providerPresets 一致）。表单里的请求地址与它一字不差（忽略末尾
# 斜杠）才发探针：自定义地址的密钥属于那个站点，不能送到预置的固定地址。
PROBE_BASE_URLS: dict[str, str] = {
    "tokendance": "https://tokendance.space/gateway/v1",
    "tuzi": "https://api.tu-zi.com",
    "openai-hk": "https://api.openai-hk.com",
    "openrouter": "https://openrouter.ai/api/v1",
    "seedream": "https://ark.cn-beijing.volces.com/api/v3",
}


def _exact_url(value: str) -> str | None:
    """请求地址的精确写法：scheme 与主机不分大小写，忽略路径末尾斜杠；不是 http(s) 地址时为 None。"""
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"),
                       parts.query, parts.fragment))


def probe_key(preset: str, access_key: str, base_url: str) -> ProbeResult:
    """结果只用来提示，不拦保存：网络不通、上游改接口都算 unknown。"""
    import requests

    url = KEY_PROBES.get(preset)
    default = PROBE_BASE_URLS.get(preset)
    if not url or not default or not access_key.strip():
        return "unknown"
    if _exact_url(base_url) != _exact_url(default):
        return "unknown"
    try:
        # 带密钥的请求不跟随重定向：3xx 归为 unknown，密钥不会被带去别的地址。
        resp = requests.get(
            url, headers={"Authorization": f"Bearer {access_key.strip()}"}, timeout=10,
            allow_redirects=False,
        )
    except requests.RequestException:
        return "unknown"
    if resp.status_code in (401, 403):
        return "invalid"
    if resp.status_code >= 300:
        return "unknown"
    try:
        body = resp.json()
    except ValueError:
        return "unknown"
    # OpenAI-HK 对错误密钥回 200 + {"error": 113, "error_des": …}。
    if isinstance(body, dict) and body.get("error"):
        return "invalid"
    return "ok"
