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
        # watchdog 在后台线程调用此方法，必须用 call_soon_threadsafe 才能安全投递到 asyncio Queue。
        if self._loop is None or not self._loop.is_running():
            return
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self._subscribers):
            self._loop.call_soon_threadsafe(q.put_nowait, payload)


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
