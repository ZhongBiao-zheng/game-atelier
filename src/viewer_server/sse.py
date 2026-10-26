"""SSE 连接池 + retry header（T6 配合：前端断连后 3s 重连）。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)


def _offer(q: asyncio.Queue[str], event: str, payload: str) -> None:
    """慢消费者队满：丢这个订阅者的这条事件并记一笔，不在事件循环回调里抛 QueueFull。"""
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        logger.warning("SSE subscriber queue full, dropped event: %s", event)


class SSEHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        self._loop = loop

    async def subscribe(self) -> asyncio.Queue[str]:
        if not self._subscribers:
            self._loop = asyncio.get_running_loop()
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def broadcast(self, event: str, data: dict) -> None:
        """投递事件到所有订阅者队列；某个订阅者队满只丢它的这条（见 _offer）。

        - 从主服务事件循环调用：直接投递，同步可见。
        - 从其他线程或网关事件循环调用：用 call_soon_threadsafe 投递到主服务循环。
        """
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        # 网关有独立的事件循环，不能把「存在循环」当成「当前是主服务循环」。
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is not None and (self._loop is None or current_loop is self._loop):
            for q in list(self._subscribers):
                _offer(q, event, payload)
            return

        # 后台线程路径（watchdog 等）：必须用 call_soon_threadsafe
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        for q in list(self._subscribers):
            loop.call_soon_threadsafe(_offer, q, event, payload)


hub = SSEHub()

# 空闲心跳间隔：出图/出视频常空闲 1-2.5min，期间流零字节。缺心跳时中间层（代理把
# 127.0.0.1 长连接缓冲/半开、系统 TCP 回收、休眠）会静默掐成半开——浏览器不触发
# onerror 就不重连、不跑 onopen 全量刷新，卡转圈直到手动刷新。发注释行保活 + 让真掉线
# 变成写失败快速触发重连。
HEARTBEAT_SECONDS = 15.0

sse_router = APIRouter()


@sse_router.get("/events")
async def events(request: Request) -> StreamingResponse:
    from viewer_server.connection_auth import ConnectionError

    session = request.state.connection_session
    store = request.app.state.connection_store
    with store.lock:
        if session.event_connections >= 4:
            raise ConnectionError("CONNECTION_RATE_LIMITED", "事件连接过多，请关闭旧页面", 429)
        session.event_connections += 1

    async def stream() -> AsyncIterator[str]:
        q = await hub.subscribe()
        try:
            yield "retry: 3000\n\n"  # browser reconnect interval
            heartbeat_at = time.monotonic()
            while True:
                with store.lock:
                    store._refresh()
                if session.revoked.is_set() or session.expires_at <= time.time():
                    return
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=min(0.5, HEARTBEAT_SECONDS))
                except asyncio.TimeoutError:
                    if time.monotonic() - heartbeat_at >= HEARTBEAT_SECONDS:
                        yield ": ping\n\n"
                        heartbeat_at = time.monotonic()
                    continue
                if msg.startswith("event: gateway_task\n") and session.principal.kind != "local":
                    continue
                yield msg
        finally:
            hub.unsubscribe(q)
            with store.lock:
                session.event_connections -= 1

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
