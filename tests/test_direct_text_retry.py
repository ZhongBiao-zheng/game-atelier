"""真实 SDK、真实 TCP 和产品客户端接线，按上游收到的 POST 验证重发边界。"""
import asyncio
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from openai import APIConnectionError, APIStatusError

from character_workflow.lib import canvas_agent_runtime as runtime, direct_text_retry as retry
from character_workflow.lib.callers import openai_text
from tests.fake_http_vendor import FakeVendor
from tests.test_gateway_text_updating import _RefuseFirstConnect

CHAT = {"choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}}]}
ANTHROPIC = {"id": "m", "model": "m", "role": "assistant", "type": "message",
             "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}


@pytest.fixture(autouse=True)
def local_network(monkeypatch):
    monkeypatch.setenv("no_proxy", "*")
    async def skip_pause(_seconds):
        pass

    monkeypatch.setattr(retry, "_async_pause", skip_pause)
    monkeypatch.setattr(retry, "_sync_pause", lambda _seconds: None)


def client_for(url, protocol="openai-chat", provider="custom"):
    key = SimpleNamespace(base_url=url, provider=provider, access_key="test")
    return runtime._agent_client(key, protocol, None, None)


async def chat(client, **options):
    return await client.chat.completions.create(model="m", messages=[{"role": "user", "content": "q"}],
                                                **options)


@pytest.mark.parametrize("protocol,path,success", [
    ("openai-chat", "/v1/chat/completions", CHAT),
    ("anthropic-messages", "/v1/messages", ANTHROPIC),
    ("gemini-generate-content", "/v1beta/models/m:generateContent",
     {"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]}),
    ("openai-responses", "/v1/responses", {"id": "r1", "object": "response", "output": []}),
])
@pytest.mark.parametrize("status", [429, 502, 503, 504])
async def test_retries_upstream_status(protocol, path, success, status):
    with FakeVendor() as vendor:
        vendor.on("POST", path, (status, {}), success)
        async with client_for(vendor.url, protocol) as client:
            if protocol == "openai-responses":
                assert (await client.responses.create(model="m", input="q")).id == "r1"
            else:
                assert (await chat(client)).choices[0].message.content == "ok"
        first, second = vendor.calls("POST", path)
        assert first.body == second.body


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
async def test_connection_refused_then_recovered(monkeypatch, host):
    # Windows / CI may only configure one localhost address. Exercise both real sockets.
    resolve = socket.getaddrinfo

    def dual_loopback(name, port, *args, **kwargs):
        if name in ("localhost", b"localhost"):
            return [*resolve("::1", port, *args, **kwargs),
                    *resolve("127.0.0.1", port, *args, **kwargs)]
        return resolve(name, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", dual_loopback)
    from character_workflow.lib.llm_protocols import transport
    inner = _RefuseFirstConnect()
    monkeypatch.setattr(transport, "direct_or_proxied", lambda _: inner)
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/chat/completions", CHAT)
        async with client_for(f"http://{host}:{vendor.server_port}") as client:
            assert (await chat(client)).choices[0].message.content == "ok"
        assert inner.refused == 1 and len(vendor.received) == 1


@pytest.mark.parametrize("status,count", [(400, 1), (408, 1), (409, 1), (500, 1), (503, 3)])
async def test_final_status(status, count):
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/chat/completions", (status, {}))
        async with client_for(vendor.url) as client:
            with pytest.raises(APIStatusError) as caught:
                await chat(client)
        assert caught.value.status_code == status and len(vendor.received) == count


@pytest.fixture
def broken_upstream(request):
    mode = request.param
    seen = []
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            seen.append(self.rfile.read(int(self.headers["Content-Length"])))
            if mode == "timeout":
                release.wait(5)
            elif mode == "stream":
                data = b'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
                if self.path == "/v1/messages":
                    data = (b'event: content_block_delta\ndata: {"type":"content_block_delta",'
                            b'"index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n')
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data) + 100))
                self.end_headers()
                self.wfile.write(data)
            # "disconnect": close without sending any response headers.

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", seen
        finally:
            release.set()
            server.shutdown()
            thread.join()


@pytest.mark.parametrize("broken_upstream", ["timeout", "disconnect", "stream"], indirect=True)
async def test_ambiguous_delivery_is_sent_once(broken_upstream):
    url, seen = broken_upstream
    async with client_for(url) as client:
        with pytest.raises((APIConnectionError, retry.TextInterrupted)) as caught:
            stream = await chat(client, stream=True, timeout=0.15)
            async for _ in stream:
                pass
    assert runtime.friendly_error(caught.value) == retry.INTERRUPTED
    assert len(seen) == 1


@pytest.mark.parametrize("broken_upstream", ["timeout", "disconnect"], indirect=True)
def test_sync_ambiguous_delivery(broken_upstream):
    url, seen = broken_upstream
    with pytest.raises(openai_text.OpenAITextError, match=retry.INTERRUPTED):
        openai_text._post_json(url=url, access_key="t", payload={}, timeout=0.15)
    assert len(seen) == 1


def test_sync_retries_status():
    with FakeVendor() as vendor:
        vendor.on("POST", "/text", (429, {}), (502, {}), CHAT)
        assert openai_text._post_json(url=vendor.url + "/text", access_key="test",
                                      payload={}, timeout=1) == CHAT
        assert len(vendor.received) == 3


async def test_gateway_plain_502_sent_once():
    with FakeVendor() as vendor:
        vendor.on("POST", "/gateway/v1/openai/chat/completions", (502, {}))
        async with client_for(vendor.url, provider="atelier") as client:
            with pytest.raises(APIStatusError):
                await chat(client)
        assert len(vendor.received) == 1


@pytest.mark.parametrize("kind", ["agent", "sync"])
@pytest.mark.parametrize("headers,waits", [
    ({"Retry-After": "2"}, [2]), ({"Retry-After": "60"}, []),
    ({"retry-after-ms": "10000", "Retry-After": "60"}, [10]),
    ({"retry-after-ms": "10001"}, []),
])
async def test_rate_limit_observes_server_delay(kind, headers, waits, monkeypatch):
    delays = []

    async def record_delay(delay):
        delays.append(delay)

    monkeypatch.setattr(retry, "_async_pause", record_delay)
    monkeypatch.setattr(retry, "_sync_pause", delays.append)
    path = "/v1/chat/completions"
    with FakeVendor() as vendor:
        vendor.on("POST", path, (429, {}, headers), CHAT)
        if kind == "agent":
            async with client_for(vendor.url) as client:
                if waits:
                    assert (await chat(client)).choices[0].message.content == "ok"
                else:
                    with pytest.raises(APIStatusError) as caught:
                        await chat(client)
                    assert caught.value.status_code == 429
        elif waits:
            assert openai_text._post_json(url=vendor.url + path, access_key="t",
                                          payload={}, timeout=1) == CHAT
        else:
            with pytest.raises(openai_text.OpenAITextError, match="429"):
                openai_text._post_json(url=vendor.url + path, access_key="t", payload={}, timeout=1)
        assert delays == waits
        assert len(vendor.received) == len(waits) + 1


async def test_agent_can_cancel_rate_limit_wait(monkeypatch):
    waiting = asyncio.Event()

    async def wait_for_cancel(delay):
        assert delay == 2
        waiting.set()
        await asyncio.Future()

    monkeypatch.setattr(retry, "_async_pause", wait_for_cancel)
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/chat/completions", (429, {}, {"Retry-After": "2"}))
        async with client_for(vendor.url) as client:
            task = asyncio.create_task(chat(client))
            await asyncio.wait_for(waiting.wait(), timeout=2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=1)
        assert len(vendor.received) == 1


@pytest.mark.parametrize("status", [408, 409, 500])
def test_sync_final_status_is_sent_once(status):
    with FakeVendor() as vendor:
        vendor.on("POST", "/chat", (status, {}))
        with pytest.raises(openai_text.OpenAITextError, match=str(status)):
            openai_text._post_json(url=vendor.url + "/chat", access_key="t", payload={}, timeout=1)
        assert len(vendor.received) == 1


@pytest.mark.parametrize("broken_upstream", ["stream"], indirect=True)
async def test_anthropic_interrupted_stream_is_sent_once(broken_upstream):
    url, seen = broken_upstream
    async with client_for(url, "anthropic-messages") as client:
        with pytest.raises(retry.TextInterrupted) as caught:
            stream = await chat(client, stream=True)
            async for _ in stream:
                pass
    assert runtime.friendly_error(caught.value) == "连接中断，未自动重发（可能已计费）"
    assert len(seen) == 1


@pytest.mark.parametrize("kind", ["agent", "sync"])
async def test_gateway_errors_ignore_retry_after_on_direct_text(kind, monkeypatch):
    waits = []

    async def record_pause(seconds):
        waits.append(seconds)

    monkeypatch.setattr(retry, "_async_pause", record_pause)
    monkeypatch.setattr(retry, "_sync_pause", waits.append)
    path = "/v1/chat/completions"
    with FakeVendor() as vendor:
        vendor.on("POST", path, (502, {}, {"Retry-After": "60"}), (503, {}, {"Retry-After": "8"}), CHAT)
        if kind == "agent":
            async with client_for(vendor.url) as client:
                assert (await chat(client)).choices[0].message.content == "ok"
        else:
            assert openai_text._post_json(url=vendor.url + path, access_key="t", payload={}, timeout=1) == CHAT
        assert waits == [0.5, 1.0]
        assert len(vendor.received) == 3
