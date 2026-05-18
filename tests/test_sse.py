import asyncio

import pytest

from skill.viewer_server.sse import hub, events as events_endpoint


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
