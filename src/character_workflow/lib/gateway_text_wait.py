"""接入端：文本 / Agent 经局域网网关时，主机更新排空期间的等待重发（第 5 批 5-4）。

只有一种情况重发：主机回 `503` 且响应体 `code == "updating"`——请求在受理前就被挡下，没进中转、没调上游。
文本请求没有幂等键，其余失败一律不重发。看过一次 `updating` 之后，主机重启那几十秒里「连接都没建立」
的失败也继续等（请求确定没发出）。

- 能显示「等待网关」的入口（画布文本节点、Agent 面板）：等到 `UPDATE_WAIT_SECONDS`，每 `RETRY_SECONDS` 重发一次。
- 没有进度位置的入口（「AI 帮我配置」、分镜解析、画布分类）：不等，直接报 `UPDATING_MESSAGE`。
- Agent 的 SDK 自带重试已关（局域网 Atelier 供应商）：transport 只对连接建立前的失败最多再发 2 次。
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

# openai 3.x 的客户端基于 httpx2（SDK 自带的 httpx 分支）：transport 必须与客户端是同一个库，
# 用普通 httpx 的 transport 会在第一个请求就断言失败（2026-11-19 页面验证时发现）。
import httpx2 as httpx

UPDATE_WAIT_SECONDS = 660.0  # 主机排空上限 600 秒 + 重启约 1 分钟
RETRY_SECONDS = 10.0
PRE_FLIGHT_RETRIES = 2
UPDATING_MESSAGE = "网关正在更新，请稍后重试"
WAITING_PHASE = "waiting_gateway"
WAITING_LABEL = "等待网关"


class GatewayTextUpdating(RuntimeError):
    """主机正在更新、这次没有收下请求（没有等待，或等到上限仍在更新）。"""


def is_updating(status: int, body: bytes | str | None) -> bool:
    """主机更新排空时的 503：按状态码 + 结构化字段判断，不看文案。旧主机没有 code，返回 False。"""
    from character_workflow.lib.callers.atelier_gateway import HOST_UPDATING_CODE

    if status != 503 or not body:
        return False
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        return False
    return isinstance(payload, dict) and payload.get("code") == HOST_UPDATING_CODE


def updating_message(error: BaseException | None) -> str | None:
    """错误链上有「主机正在更新」时返回它的文案（按类型，沿 __cause__ 找），给只显示一句原因的入口用。"""
    seen: list[BaseException] = []
    while error is not None and error not in seen:
        if isinstance(error, GatewayTextUpdating):
            return str(error)
        seen.append(error)
        error = error.__cause__
    return None


def expired_message() -> str:
    return f"网关正在更新，已等待 {round(UPDATE_WAIT_SECONDS / 60)} 分钟，请稍后重试"


@dataclass
class Waiting:
    """同步入口的等待：on_phase 切「等待网关」，should_cancel 为真时立即结束。"""

    on_phase: Callable[[str], None] | None = None
    should_cancel: Callable[[], bool] | None = None
    resume_phase: str | None = None


def _pause(seconds: float, should_cancel: Callable[[], bool] | None) -> bool:
    """等一段时间；期间用户停止就提前返回 False。测试替换这个函数跳过等待。"""
    deadline = time.monotonic() + seconds
    event = threading.Event()
    while (left := deadline - time.monotonic()) > 0:
        if should_cancel and should_cancel():
            return False
        event.wait(min(left, 1.0))
    return not (should_cancel and should_cancel())


def send_sync(send: Callable[[], object], *, status_of: Callable[[object], int],
              body_of: Callable[[object], bytes | str | None],
              pre_flight: Callable[[BaseException], bool],
              network_errors: tuple[type[BaseException], ...],
              waiting: Waiting | None) -> object:
    """发一次；遇到 `updating` 按 waiting 等待重发。返回最终响应，交给调用方照常处理。"""
    def updating(response: object) -> bool:
        return status_of(response) == 503 and is_updating(503, body_of(response))

    response = send()
    if not updating(response):
        return response
    if waiting is None:
        raise GatewayTextUpdating(UPDATING_MESSAGE)
    if waiting.on_phase:
        waiting.on_phase(WAITING_PHASE)
    deadline = time.monotonic() + UPDATE_WAIT_SECONDS
    while True:
        if not _pause(RETRY_SECONDS, waiting.should_cancel):
            raise GatewayTextUpdating("已按请求停止")
        if time.monotonic() >= deadline:
            raise GatewayTextUpdating(expired_message())
        try:
            response = send()
        except network_errors as error:
            if pre_flight(error):
                continue  # 主机重启中，连接都没建立：请求确定没发出
            raise
        if not updating(response):
            if waiting.on_phase and waiting.resume_phase:
                waiting.on_phase(waiting.resume_phase)
            return response


_PRE_FLIGHT = (httpx.ConnectError, httpx.ConnectTimeout)


async def _async_pause(seconds: float) -> None:
    """测试替换这个函数跳过等待。协程被取消（用户停止）时立即抛出 CancelledError。"""
    await asyncio.sleep(seconds)


_BODY_HEADERS = frozenset({"content-encoding", "content-length", "transfer-encoding"})


def _rebuilt(response: httpx.Response, body: bytes, request: httpx.Request) -> httpx.Response:
    """把已读出（已解码）的响应体原样交回。去掉描述原始传输形态的三个头：`aread()` 拿到的是解码后的内容，
    留着 content-encoding 会被再解码一次，content-length / transfer-encoding 也对不上。"""
    headers = [(name, value) for name, value in response.headers.multi_items()
               if name.lower() not in _BODY_HEADERS]
    return httpx.Response(response.status_code, headers=headers, content=body, request=request)


class UpdatingAwareTransport(httpx.AsyncBaseTransport):
    """Agent 经网关的 httpx transport：SDK 自带重试已关，这里只做两件事。

    - 连接建立前的失败（请求确定没发出）：最多再发 `PRE_FLIGHT_RETRIES` 次；连接建立后的失败一律不重发。
    - 主机更新排空的 503：等待重发，最长 `UPDATE_WAIT_SECONDS`，期间调 `on_wait` 一次（面板显示「等待网关」）。
    """

    def __init__(self, inner: httpx.AsyncBaseTransport | None = None,
                 on_wait: Callable[[], None] | None = None) -> None:
        self._inner = inner or httpx.AsyncHTTPTransport()
        self._on_wait = on_wait

    async def _send_once(self, request: httpx.Request) -> httpx.Response:
        for attempt in range(PRE_FLIGHT_RETRIES + 1):
            try:
                return await self._inner.handle_async_request(request)
            except _PRE_FLIGHT:
                if attempt >= PRE_FLIGHT_RETRIES:
                    raise
        raise AssertionError("unreachable")

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._send_once(request)
        if response.status_code != 503:
            return response
        body = await response.aread()
        if not is_updating(503, body):
            return _rebuilt(response, body, request)
        if self._on_wait:
            self._on_wait()
        deadline = time.monotonic() + UPDATE_WAIT_SECONDS
        while True:
            await _async_pause(RETRY_SECONDS)
            if time.monotonic() >= deadline:
                return httpx.Response(
                    503, request=request,
                    json={"error": {"message": expired_message(), "code": "updating"}})
            try:
                response = await self._inner.handle_async_request(request)
            except _PRE_FLIGHT:
                continue  # 主机重启中：连接都没建立，请求确定没发出
            if response.status_code != 503:
                return response
            body = await response.aread()
            if not is_updating(503, body):
                return _rebuilt(response, body, request)

    async def aclose(self) -> None:
        await self._inner.aclose()
