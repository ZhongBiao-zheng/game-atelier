import asyncio
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from viewer_server import sse as sse_mod
from viewer_server.sse import hub, events as events_endpoint
from viewer_server.connection_auth import ConnectionStore


def local_request():
    store = ConnectionStore("a" * 32)
    session, _ = store.local_session("http://127.0.0.1", None)
    return Request({"type": "http", "method": "GET", "path": "/events",
                    "app": SimpleNamespace(state=SimpleNamespace(connection_store=store)),
                    "state": {"connection_session": session}})


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
        return await events_endpoint(local_request())
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
        resp = await events_endpoint(local_request())
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
        resp = await events_endpoint(local_request())
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


def test_revoked_session_closes_stream_and_releases_subscription(runtime):
    async def run():
        request = local_request()
        session = request.state.connection_session
        response = await events_endpoint(request)
        stream = response.body_iterator
        await stream.__anext__()
        assert session.event_connections == 1
        request.app.state.connection_store.revoke_session(session.principal.session_id)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(stream.__anext__(), timeout=1)
        assert session.event_connections == 0
    asyncio.run(run())


def test_in_loop_broadcast_to_full_queue_logs_warning(runtime, caplog):
    async def run():
        full = await hub.subscribe()
        other = await hub.subscribe()
        try:
            for i in range(200):
                full.put_nowait(f"old {i}")
            with caplog.at_level("WARNING", logger="viewer_server.sse"):
                hub.broadcast("team-library-changed", {"asset_id": "ta"})
            assert full.qsize() == 200
            assert "team-library-changed" in other.get_nowait()
        finally:
            hub.unsubscribe(full)
            hub.unsubscribe(other)
    asyncio.run(run())
    assert any("team-library-changed" in r.getMessage() for r in caplog.records)


def test_threaded_broadcast_to_full_queue_does_not_raise_in_loop(runtime, caplog):
    """watchdog 线程广播：队满不能在事件循环回调里抛 QueueFull，其他订阅者照常收到。"""
    import threading

    async def run():
        loop = asyncio.get_running_loop()
        errors: list[dict] = []
        loop.set_exception_handler(lambda _loop, context: errors.append(context))
        hub.set_loop(loop)
        full = await hub.subscribe()
        other = await hub.subscribe()
        try:
            for i in range(200):
                full.put_nowait(f"old {i}")
            with caplog.at_level("WARNING", logger="viewer_server.sse"):
                thread = threading.Thread(
                    target=hub.broadcast, args=("team-library-changed", {"asset_id": "ta"})
                )
                thread.start()
                thread.join(5)
                message = await asyncio.wait_for(other.get(), timeout=1.0)
                await asyncio.sleep(0)
            assert "team-library-changed" in message
            assert full.qsize() == 200
            assert errors == []
        finally:
            hub.unsubscribe(full)
            hub.unsubscribe(other)
            hub.set_loop(None)
    asyncio.run(run())
    assert any("team-library-changed" in r.getMessage() for r in caplog.records)


def test_gateway_event_loop_delivers_on_main_loop(runtime):
    """Gateway uvicorn has its own asyncio loop; it must not touch the main loop's queue."""
    import threading

    async def run():
        main_loop = asyncio.get_running_loop()
        local_hub = sse_mod.SSEHub()
        local_hub.set_loop(main_loop)
        queue = await local_hub.subscribe()
        offered_on = []
        original_put = queue.put_nowait

        def checked_put(value):
            offered_on.append(asyncio.get_running_loop())
            original_put(value)

        queue.put_nowait = checked_put

        async def gateway():
            local_hub.broadcast('gateway_task', {'task_id': 'remote-loop'})

        thread = threading.Thread(target=lambda: asyncio.run(gateway()))
        thread.start()
        await asyncio.to_thread(thread.join, 2)
        message = await asyncio.wait_for(queue.get(), 1)
        assert 'remote-loop' in message
        assert offered_on == [main_loop]

    asyncio.run(run())


def test_first_subscription_rebinds_after_server_loop_closes(runtime):
    local_hub = sse_mod.SSEHub()
    previous = asyncio.new_event_loop()
    local_hub.set_loop(previous)
    previous.close()

    async def run():
        queue = await local_hub.subscribe()
        local_hub.broadcast('gateway_task', {'task_id': 'new-loop'})
        assert 'new-loop' in await asyncio.wait_for(queue.get(), 1)
        assert local_hub._loop is asyncio.get_running_loop()
        local_hub.unsubscribe(queue)

    asyncio.run(run())
