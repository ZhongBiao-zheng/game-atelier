"""Tuzi generic async wrapper for long-running image requests.

Tuzi's synchronous image endpoint can close its HTTP connection before a slow upstream image
finishes.  The upstream keeps running and bills the request, but the caller loses the response.
The generic async wrapper returns a durable task id first, then exposes the original JSON response
through ``GET /get-async``.  Polling transport failures therefore retry the same billed task instead
of creating another one.
"""
from __future__ import annotations

import json
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


def _async_url(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path if parts.path.startswith("/") else f"/{parts.path}"
    if not path.startswith("/async/"):
        path = f"/async{path}"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def _poll_url(url: str, task_id: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "/get-async", f"id={quote(task_id)}", ""))


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
    result: Any = payload.get("result")
    status_code = payload.get("status_code")
    if isinstance(result, dict):
        status_code = result.get("status_code", status_code)
        # Some deployments preserve the upstream body inside an HTTP result envelope.
        if "body" in result and not any(k in result for k in ("data", "choices", "error")):
            result = result["body"]
    if isinstance(status_code, int) and status_code >= 400:
        raise TuziAsyncError(
            video_poll.with_task_ref(
                f"Tuzi 异步任务的上游响应失败（HTTP {status_code}）", task_id
            )
        )
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError as e:
            raise TuziAsyncError(
                video_poll.with_task_ref("Tuzi 异步任务完成但结果不是 JSON", task_id)
            ) from e
    if not isinstance(result, dict):
        raise TuziAsyncError(
            video_poll.with_task_ref("Tuzi 异步任务完成但没有返回结果", task_id)
        )
    return result


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

    for response in video_poll.poll_responses(
        url=_poll_url(url, current),
        headers=headers,
        timeout=_POLL_TIMEOUT_SECONDS,
        max_polls=max_polls,
        poll_interval=poll_interval,
        task_ref=current,
        error_cls=TuziAsyncPendingError,
        should_cancel=should_cancel,
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
        video_poll.with_task_ref("Tuzi 异步任务轮询超时，任务可能仍在厂商侧运行", current)
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
    def submit(async_url: str, headers: dict[str, str]):
        return requests.post(
            async_url,
            headers={**headers, "Content-Type": "application/json"},
            json=payload,
            timeout=submit_timeout,
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
    def submit(async_url: str, headers: dict[str, str]):
        return requests.post(
            async_url,
            headers=headers,
            data=fields,
            files=files,
            timeout=submit_timeout,
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
