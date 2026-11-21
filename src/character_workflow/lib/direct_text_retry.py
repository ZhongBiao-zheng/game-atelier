"""直连文本请求的重发边界（ADR-0044）。"""
from __future__ import annotations

from asyncio import sleep as _async_pause
from collections.abc import AsyncIterator, Callable, Mapping
from email.utils import parsedate_to_datetime
from math import isfinite
from time import sleep as _sync_pause, time

import httpx2 as httpx
import requests

from character_workflow.lib.callers.connect_failure import never_sent

BACKOFF = (0.5, 1.0)
RETRY_STATUS = {429, 502, 503, 504}
INTERRUPTED = "连接中断，未自动重发（可能已计费）"
_INTERRUPTED_ERRORS = (httpx.ReadTimeout, httpx.ReadError, httpx.WriteError,
                       httpx.WriteTimeout, httpx.RemoteProtocolError)


def _retry_delay(status: int, headers: Mapping[str, str], attempt: int) -> float | None:
    if status not in RETRY_STATUS or attempt == len(BACKOFF):
        return None
    if status == 429:
        for header, scale in (("retry-after-ms", 0.001), ("retry-after", 1)):
            value = headers.get(header)
            if value is None:
                continue
            try:
                delay = float(value) * scale
            except ValueError:
                if header != "retry-after":
                    continue
                try:
                    delay = max(0.0, parsedate_to_datetime(value).timestamp() - time())
                except (ValueError, OverflowError, OSError, TypeError):
                    continue
            if isfinite(delay) and delay >= 0:
                return delay if delay <= 10 else None
    return BACKOFF[attempt]


class TextInterrupted(RuntimeError):
    def __init__(self) -> None:
        super().__init__(INTERRUPTED)


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream: httpx.AsyncByteStream) -> None:
        self.stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self.stream:
                yield chunk
        except _INTERRUPTED_ERRORS as error:
            raise TextInterrupted() from error

    async def aclose(self) -> None:
        await self.stream.aclose()


class DirectTextTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        for attempt in range(len(BACKOFF) + 1):
            try:
                response = await self.inner.handle_async_request(request)
            except (httpx.ConnectError, httpx.ConnectTimeout) as error:
                if attempt == len(BACKOFF) or not (
                    isinstance(error, httpx.ConnectTimeout) or never_sent(error)
                ):
                    raise
                delay = BACKOFF[attempt]
            except _INTERRUPTED_ERRORS as error:
                raise TextInterrupted() from error
            else:
                delay = _retry_delay(response.status_code, response.headers, attempt)
                if delay is None:
                    response.stream = _ResponseStream(response.stream)
                    return response
                await response.aclose()
            await _async_pause(delay)
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self.inner.aclose()


def send_sync(send: Callable[[], requests.Response]) -> requests.Response:
    for attempt in range(len(BACKOFF) + 1):
        try:
            response = send()
        except requests.RequestException as error:
            if not never_sent(error):
                if isinstance(error, (requests.ConnectionError, requests.ReadTimeout,
                                      requests.exceptions.ChunkedEncodingError)) and not isinstance(
                    error, (requests.exceptions.SSLError, requests.exceptions.ProxyError)
                ):
                    raise TextInterrupted() from error
                raise
            if attempt == len(BACKOFF):
                raise
            delay = BACKOFF[attempt]
        else:
            delay = _retry_delay(response.status_code, response.headers, attempt)
            if delay is None:
                return response
            response.close()
        _sync_pause(delay)
    raise AssertionError("unreachable")
