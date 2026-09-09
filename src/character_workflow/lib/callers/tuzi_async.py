"""Tuzi native image tasks (the provider calls the endpoint /v1/videos).

Persist each task before polling so transport failures never cause another paid submission.
The retired generic async transport is deliberately not used, even on failure.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import requests

from . import video_poll


class TuziAsyncError(RuntimeError):
    pass


class TuziAsyncPendingError(TuziAsyncError):
    """Polling stopped without a provider terminal state; the billed task remains resumable."""


_SUCCESS = frozenset({"completed", "success", "succeeded", "done"})
_FAILURE = frozenset({"failure", "failed", "error", "expired", "cancelled", "canceled"})
_PENDING = frozenset({"queued", "not_start", "submitted", "in_progress", "processing", "pending"})
_POLL_TIMEOUT_SECONDS = 30
_POLL_WINDOW_SECONDS = 10 * 60
IMAGE_TASK_MODELS = frozenset({"gpt-image-2", "gpt-image-2-vip", "gpt-image-1.5", "gpt-image-1"})
TASK_PROTOCOL = "tuzi_images"


def _async_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "/v1/videos", "", ""))


def _poll_url(url: str, task_id: str) -> str:
    return f"{_async_url(url)}/{quote(task_id, safe='')}"


def _json(response: Any) -> dict[str, Any]:
    try:
        payload = response.json()
    except (TypeError, ValueError) as e:
        raise TuziAsyncError(
            f"Tuzi async HTTP {getattr(response, 'status_code', '?')} 返回非 JSON 响应"
        ) from e
    if not isinstance(payload, dict):
        raise TuziAsyncError(f"Tuzi async 返回格式无效: {payload!r}")
    return payload


def _message(payload: dict[str, Any], status_code: int) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        detail = error.get("message") or error.get("detail") or error.get("code")
    else:
        detail = error
    detail = detail or payload.get("message") or payload.get("detail") or payload
    return f"Tuzi async HTTP {status_code}: {detail}"


def _task_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("id") or payload.get("task_id") or payload.get("taskId")
    task_id = str(value).strip() if value is not None else ""
    if not task_id:
        return None
    if len(task_id) > 512:
        raise TuziAsyncError("Tuzi 异步提交返回的任务 ID 过长")
    return task_id


def _result_json(payload: dict[str, Any], task_id: str) -> dict[str, Any]:
    url = payload.get("video_url")
    if (not isinstance(url, str) or urlsplit(url).scheme not in {"https", "http"}
            or not urlsplit(url).hostname):
        raise TuziAsyncError(
            video_poll.with_task_ref("Tuzi 图片任务完成但没有有效图片地址", task_id)
        )
    return {"data": [{"url": url}]}


def _execute(
    *,
    url: str,
    api_key: str,
    submit: Callable[[str, dict[str, str]], Any],
    task_id: str | None,
    on_task_id: Callable[[str], None] | None,
    on_phase: Callable[[str], None] | None,
    should_cancel: Callable[[], bool] | None,
    poll_interval: float,
    max_polls: int,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    current = task_id
    if not current:
        if should_cancel and should_cancel():
            raise TuziAsyncError("生成已按请求停止，尚未提交厂商任务")
        response = submit(_async_url(url), headers)
        payload = _json(response)
        if not 200 <= int(response.status_code) < 300:
            raise TuziAsyncError(_message(payload, int(response.status_code)))
        current = _task_id(payload)
        if not current:
            raise TuziAsyncError(f"Tuzi 异步提交未返回任务 ID: {payload!r}")
        # Persist before the first poll.  From this point onward the request may already be billed.
        if on_task_id:
            on_task_id(current)
    if on_phase:
        on_phase("sent")

    status = ""
    for response in video_poll.poll_responses(
        url=_poll_url(url, current),
        headers=headers,
        timeout=_POLL_TIMEOUT_SECONDS,
        max_polls=max_polls,
        poll_interval=poll_interval,
        task_ref=current,
        error_cls=TuziAsyncPendingError,
        should_cancel=should_cancel,
        max_elapsed_seconds=_POLL_WINDOW_SECONDS,
    ):
        payload = _json(response)
        if not 200 <= int(response.status_code) < 300:
            raise TuziAsyncError(
                video_poll.with_task_ref(_message(payload, int(response.status_code)), current)
            )
        status = str(payload.get("status") or "").strip().lower()
        if status in _SUCCESS:
            if on_phase:
                on_phase("downloading")
            return _result_json(payload, current)
        if status in _FAILURE:
            raise TuziAsyncError(
                video_poll.with_task_ref(
                    f"Tuzi 异步任务失败：{payload.get('error') or payload.get('message') or status}",
                    current,
                )
            )
        if status not in _PENDING:
            raise TuziAsyncError(
                video_poll.with_task_ref(
                    f"Tuzi 异步任务返回未知状态：{status or '<empty>'}", current
                )
            )
    raise TuziAsyncPendingError(
        video_poll.with_task_ref(
            f"Tuzi 图片查询超时，厂商最后状态：{status or '未取得'}；任务可能仍在厂商侧运行",
            current,
        )
    )


def execute_json(
    *,
    url: str,
    api_key: str,
    payload: dict[str, Any],
    task_id: str | None = None,
    on_task_id: Callable[[str], None] | None = None,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    submit_timeout: float | tuple[float, float] = (30.0, 60.0),
    poll_interval: float = 2.0,
    max_polls: int = 300,
) -> dict[str, Any]:
    return execute_multipart(
        url=url, api_key=api_key, fields=payload, files=[], task_id=task_id,
        on_task_id=on_task_id, on_phase=on_phase, should_cancel=should_cancel,
        submit_timeout=submit_timeout, poll_interval=poll_interval, max_polls=max_polls,
    )


def execute_multipart(
    *,
    url: str,
    api_key: str,
    fields: dict[str, Any],
    files: list[tuple[str, tuple[str, bytes, str]]],
    task_id: str | None = None,
    on_task_id: Callable[[str], None] | None = None,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    submit_timeout: float | tuple[float, float] = (30.0, 60.0),
    poll_interval: float = 2.0,
    max_polls: int = 300,
) -> dict[str, Any]:
    if not task_id and fields.get("model") not in IMAGE_TASK_MODELS:
        raise TuziAsyncError("该模型未支持 Tuzi 图片异步任务接口")
    # Images-only fields must not silently lose their meaning on the native task API.
    if fields.get("quality") not in {None, "auto"} or fields.get("background") not in {None, "auto"}:
        raise TuziAsyncError("Tuzi 图片异步接口不支持指定质量或背景")
    if any(name not in {"image", "image[]"} for name, _ in files):
        raise TuziAsyncError("Tuzi 图片异步接口不支持蒙版")
    parts = [(name, (None, str(fields[name]))) for name in ("model", "prompt", "size")
             if fields.get(name) is not None]
    parts.extend(("input_reference", part) for _, part in files)

    def submit(async_url: str, headers: dict[str, str]):
        return requests.post(
            async_url,
            headers=headers,
            files=parts,
            timeout=submit_timeout,
            allow_redirects=False,
        )

    return _execute(
        url=url,
        api_key=api_key,
        submit=submit,
        task_id=task_id,
        on_task_id=on_task_id,
        on_phase=on_phase,
        should_cancel=should_cancel,
        poll_interval=poll_interval,
        max_polls=max_polls,
    )
