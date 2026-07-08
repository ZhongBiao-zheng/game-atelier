import asyncio

import pytest

from viewer_server import sse as sse_mod
from viewer_server.sse import hub, events as events_endpoint


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    monkeypatch.chdir(tmp_path)
    return runtime


def test_events_endpoint_returns_sse_streaming_response(runtime):
    """Unit-test the endpoint factory directly to avoid hanging on the open SSE stream."""
    async def run():
        return await events_endpoint()
    resp = asyncio.run(run())
    assert resp.media_type == "text/event-stream"
    assert resp.headers["cache-control"] == "no-cache"


def test_hub_broadcasts_to_subscribers(runtime):
    async def run() -> str:
        q = await hub.subscribe()
        hub.broadcast("job-changed", {"job_id": "j1", "status": "done"})
        try:
            return await asyncio.wait_for(q.get(), timeout=1.0)
        finally:
            hub.unsubscribe(q)
    msg = asyncio.run(run())
    assert "job-changed" in msg
    assert "j1" in msg


def test_stream_emits_heartbeat_when_idle(runtime, monkeypatch):
    """空闲流必须发心跳（保活 + 探测半开连接），否则出图长空闲期连接被静默掐掉不重连。"""
    monkeypatch.setattr(sse_mod, "HEARTBEAT_SECONDS", 0.05)

    async def run() -> list[str]:
        resp = await events_endpoint()
        it = resp.body_iterator
        first = await asyncio.wait_for(it.__anext__(), timeout=1.0)   # retry header
        ping = await asyncio.wait_for(it.__anext__(), timeout=1.0)    # idle → heartbeat
        await it.aclose()
        return [first, ping]

    first, ping = asyncio.run(run())
    assert first.startswith("retry:")
    assert ping == ": ping\n\n"


def test_stream_still_delivers_events_over_heartbeat(runtime, monkeypatch):
    """心跳不能吞真事件：广播的 job-changed 必须照常到达。"""
    monkeypatch.setattr(sse_mod, "HEARTBEAT_SECONDS", 5.0)

    async def run() -> str:
        resp = await events_endpoint()
        it = resp.body_iterator
        await asyncio.wait_for(it.__anext__(), timeout=1.0)  # drain retry header
        await asyncio.sleep(0)  # let stream() reach q.get()
        hub.broadcast("job-changed", {"job_id": "j9", "status": "done"})
        msg = await asyncio.wait_for(it.__anext__(), timeout=1.0)
        await it.aclose()
        return msg

    msg = asyncio.run(run())
    assert "job-changed" in msg and "j9" in msg


def test_hub_drops_on_full_queue(runtime):
    """Slow consumer doesn't block hub; events are dropped."""
    async def run():
        q = await hub.subscribe()
        try:
            # Fill the queue to capacity (maxsize=200), then broadcast one more
            for i in range(201):
                hub.broadcast("test", {"i": i})
            # First 200 should be queued; 201st was dropped
            assert q.qsize() == 200
        finally:
            hub.unsubscribe(q)
    asyncio.run(run())
