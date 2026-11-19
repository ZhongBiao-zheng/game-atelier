"""异步任务提交（拿任务号再轮询）的唯一判据：哪些失败算「上游可能已受理」。

所有「提交 → 回任务号 → 轮询」的协议共用这一套，不各写一份：

- 发一次，不自动重发。发送前记 `submitting`，之后按结果改写同一条尝试记录（`on_submission`）。
- 未确认（`SubmissionUnconfirmed`）：请求可能已到上游，结局不知道。不重发、不换家，由人核对或凭任务号续查。
  - 任何网络异常（连接建立前的失败也算，与已接的 Seedance / 可灵新版 / EvoLink 一致，2026-11-19 飙哥定）；
  - HTTP ≥ 500（不论文案：网关回 503「无可用渠道」也可能是上游已建单后才超时）；
  - 2xx 但响应不是 JSON 对象；
  - 2xx 但取不到任务号（由调用方判断后调 `Submitted.unconfirmed`）。
- 拒绝：4xx，按调用方的报错类与文案抛出，上游明确没受理。

调用方的报错类各派生一个「未确认」子类（同时继承 `SubmissionUnconfirmed`），原有的 `except <报错类>`
与报错文案都不变；主机与本机的「换不换家、算不算未确认」按类型判断（`is_unconfirmed`），不看文案。
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

import requests

NETWORK_UNCONFIRMED = "{noun}提交结果未确认：网络请求未完成，未自动重新提交。请先核对厂商记录，避免重复计费。"
STATUS_UNCONFIRMED = ("{noun}提交结果未确认：厂商接口返回 HTTP {status}，未自动重新提交。"
                      "请先核对厂商记录，避免重复计费。")
UNPARSEABLE_UNCONFIRMED = "{noun}提交结果未确认：响应无法解析，未自动重新提交。请先核对厂商记录。"
MISSING_ID_UNCONFIRMED = "{noun}提交结果未确认：未返回任务 ID，请先核对厂商记录。"

_REQUEST_ID_HEADERS = ("x-request-id", "x-trace-id", "request-id", "x-tt-logid")
_SAFE_HEADER_VALUE = re.compile(r"[A-Za-z0-9._:-]{1,200}")


class SubmissionUnconfirmed(Exception):
    """提交可能已被上游受理，但没拿到明确结果：不重发、不换家。"""


def is_unconfirmed(error: BaseException | None) -> bool:
    """错误链上有没有「提交未确认」（按类型，沿 __cause__ 找）。"""
    seen: list[BaseException] = []
    while error is not None and error not in seen:
        if isinstance(error, SubmissionUnconfirmed):
            return True
        seen.append(error)
        error = error.__cause__
    return False


@dataclass
class Submitted:
    """一次已收到 2xx JSON 响应的提交。调用方取不到任务号时用 `unconfirmed` 改写记录并拿到要抛的异常。"""

    payload: dict[str, Any]
    status: int
    _diagnostic: dict[str, Any] = field(repr=False)
    _report: Callable[[dict[str, Any]], None] = field(repr=False)
    _unconfirmed_cls: type[Exception] = field(repr=False)

    def unconfirmed(self, message: str) -> Exception:
        self._diagnostic["outcome"] = "unconfirmed"
        self._report(self._diagnostic)
        return self._unconfirmed_cls(message)


def submit_task(
    *,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    attempt: int,
    on_submission: Callable[[dict[str, Any]], None] | None,
    rejected: type[Exception],
    unconfirmed: type[Exception],
    reject_message: Callable[[dict[str, Any], int], str],
    noun: str = "视频",
    timeout: float | tuple[float, float] = 600,
    **request_kwargs: Any,
) -> Submitted:
    """POST 一次 JSON 提交，按模块说明的判据分类；返回 2xx 的 JSON 对象。

    `rejected` 用于 4xx（`reject_message(payload, status)` 给文案，响应不是 JSON 时 payload 为空字典）；
    `unconfirmed` 必须同时继承 `SubmissionUnconfirmed`。诊断记录只含方法、去掉查询串的地址、时间、
    状态码与白名单里的请求 ID，不含请求体与密钥。
    """
    if not issubclass(unconfirmed, SubmissionUnconfirmed):
        raise TypeError("unconfirmed 必须继承 SubmissionUnconfirmed")
    parsed = urlsplit(url)
    host = parsed.hostname or ""  # 不带 user:password@：尝试记录里不能有凭据
    if parsed.port:
        host = f"{host}:{parsed.port}"
    diagnostic: dict[str, Any] = {
        "attempt": attempt,
        "method": "POST",
        "url": urlunsplit((parsed.scheme, host, parsed.path, "", "")),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "outcome": "submitting",
    }

    def report(current: dict[str, Any]) -> None:
        if on_submission:
            on_submission(dict(current))

    started = time.monotonic()
    report(diagnostic)
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=timeout, **request_kwargs)
    except requests.RequestException as error:
        from character_workflow.lib.callers.openai_image import _is_pre_flight_failure

        diagnostic.update(error_type=type(error).__name__,
                          elapsed_ms=round((time.monotonic() - started) * 1000))
        if _is_pre_flight_failure(error):
            # 连接都没建立：上游肯定没收到。2026-11-19 飙哥定 Q1-1=A，仍按未确认处理（不重发、不换家）。
            # 将来改判「未送达、可换家」只改这一个分支（另加一个 outcome 取值）。
            outcome = "unconfirmed"
        else:
            outcome = "unconfirmed"  # 连接建立后断开、读超时：请求可能已到上游
        diagnostic["outcome"] = outcome
        report(diagnostic)
        raise unconfirmed(NETWORK_UNCONFIRMED.format(noun=noun)) from error
    status = resp.status_code
    diagnostic.update(http_status=status, elapsed_ms=round((time.monotonic() - started) * 1000),
                      request_ids=_request_ids(resp, headers))
    if status >= 500:
        diagnostic["outcome"] = "unconfirmed"
        report(diagnostic)
        raise unconfirmed(STATUS_UNCONFIRMED.format(noun=noun, status=status))
    diagnostic["outcome"] = "response"
    report(diagnostic)
    try:
        payload = resp.json()
    except (ValueError, TypeError):
        payload = None
    if not isinstance(payload, dict):
        if not resp.ok:
            raise rejected(reject_message({}, status))
        diagnostic["outcome"] = "unconfirmed"
        report(diagnostic)
        raise unconfirmed(UNPARSEABLE_UNCONFIRMED.format(noun=noun))
    if not resp.ok:
        raise rejected(reject_message(payload, status))
    return Submitted(payload=payload, status=status, _diagnostic=diagnostic, _report=report,
                     _unconfirmed_cls=unconfirmed)


def _request_ids(resp: Any, headers: dict[str, str]) -> dict[str, str]:
    secrets = [value for value in headers.values() if value]
    found: dict[str, str] = {}
    response_headers = getattr(resp, "headers", None) or {}
    for name in _REQUEST_ID_HEADERS:
        value = response_headers.get(name, "")
        if (isinstance(value, str) and _SAFE_HEADER_VALUE.fullmatch(value)
                and not any(value in secret for secret in secrets)):
            found[name] = value
    return found
