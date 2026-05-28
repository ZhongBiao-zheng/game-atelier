"""SSE 连接池 + retry header（T6 配合：前端断连后 3s 重连）。"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse


class SSEHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def broadcast(self, event: str, data: dict) -> None:
        """投递事件到所有订阅者队列。

        - 从事件循环线程内调用（async 上下文 / 测试）：直接 put_nowait，同步可见，队满静默丢弃。
        - 从后台线程调用（watchdog）：用 call_soon_threadsafe 跨线程安全投递，需先 set_loop()。
        """
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        # 检测是否在事件循环线程内（get_running_loop 成功则在循环线程）
        try:
            asyncio.get_running_loop()
            # 在事件循环线程：直接调用，结果立即可见；队满则静默丢弃
            for q in list(self._subscribers):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass  # slow consumer — drop this event
            return
        except RuntimeError:
            pass  # 不在事件循环线程，走下面的 threadsafe 路径

        # 后台线程路径（watchdog 等）：必须用 call_soon_threadsafe
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        for q in list(self._subscribers):
            loop.call_soon_threadsafe(q.put_nowait, payload)


hub = SSEHub()

sse_router = APIRouter()


@sse_router.get("/events")
async def events() -> StreamingResponse:
    async def stream() -> AsyncIterator[str]:
        q = await hub.subscribe()
        try:
            yield "retry: 3000\n\n"  # browser reconnect interval
            while True:
                msg = await q.get()
                yield msg
        finally:
            hub.unsubscribe(q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
