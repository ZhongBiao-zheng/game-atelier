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

    async def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def broadcast(self, event: str, data: dict) -> None:
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # drop event for slow consumer; full refresh on reconnect catches up


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
