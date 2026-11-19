"""第 5 批 5-4：文本与 Agent 经网关时，主机更新排空期间等待重发。

只认「503 + code=updating」（主机受理前挡下，没调上游）。画布文本节点与 Agent 面板等待（最长 11 分钟），
没有进度位置的入口直接报「网关正在更新，请稍后重试」。主机是真实回环网关，上游是 httpx MockTransport。
跳过等待只替换被测模块自己的等待入口（gateway_text_wait._pause / _async_pause），不碰 time.sleep。
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import httpx2
import pytest
import requests

from character_workflow.lib import gateway_text_wait, keys
from character_workflow.lib.callers import openai_text
from tests import test_gateway_client as _client_harness
from tests import test_gateway_not_accepted as _drain
from viewer_server import gateway_openai

_fast = _client_harness._fast
gateway = _client_harness.gateway
upstream = _client_harness.upstream
TEXT = "gpt-4.1-nano"


@pytest.fixture
def text_gateway(gateway, monkeypatch):
    keys.add_key(keys.KeySpec(alias="TextUp", provider="custom", access_key="fake-test-secret",
                              base_url="https://text.example/v1", created_at="test",
                              models=[keys.ModelSpec(id=TEXT, name=TEXT, modality="text")]))
    calls: list[httpx.Request] = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": "好"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1}})

    monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handle)))
    yield {**gateway, "calls": calls}
    _drain._set_updating(False)


def _chat(gateway, waiting=None):
    return openai_text._post_json(
        url=f"{gateway['base']}/gateway/v1/openai/chat/completions", access_key=gateway["token"],
        payload={"model": TEXT, "messages": [{"role": "user", "content": "hi"}]}, timeout=10,
        gateway_alias="Hub", gateway_wait=waiting)


def _end_update_on_first_pause(monkeypatch):
    pauses: list[float] = []

    def pause(seconds, _should_cancel):
        pauses.append(seconds)
        _drain._set_updating(False)  # 主机更新结束
        return True

    monkeypatch.setattr(gateway_text_wait, "_pause", pause)
    return pauses


def test_waiting_entry_resends_after_the_update_and_calls_upstream_once(text_gateway, monkeypatch):
    pauses = _end_update_on_first_pause(monkeypatch)
    phases: list[str] = []
    _drain._set_updating(True)
    body = _chat(text_gateway, gateway_text_wait.Waiting(on_phase=phases.append,
                                                         resume_phase="sent"))
    assert body["usage"]["completion_tokens"] == 1
    assert pauses == [gateway_text_wait.RETRY_SECONDS]
    assert phases == ["waiting_gateway", "sent"]
    assert len(text_gateway["calls"]) == 1


def test_entry_without_progress_fails_right_away_with_a_plain_message(text_gateway, monkeypatch):
    monkeypatch.setattr(gateway_text_wait, "_pause", lambda *_a: pytest.fail("不应等待"))
    _drain._set_updating(True)
    with pytest.raises(openai_text.OpenAITextError) as error:
        _chat(text_gateway)
    assert str(error.value) == "网关正在更新，请稍后重试"
    assert text_gateway["calls"] == []


def _scripted(monkeypatch, answers):
    sent: list[int] = []

    def post(*_a, **_k):
        sent.append(1)
        answer = answers[len(sent) - 1]
        if isinstance(answer, BaseException):
            raise answer
        status, payload = answer
        raw = json.dumps(payload).encode()
        return SimpleNamespace(status_code=status, text=raw.decode(), content=raw,
                               json=lambda: payload)

    monkeypatch.setattr(openai_text.requests, "post", post)
    monkeypatch.setattr(gateway_text_wait, "_pause", lambda *_a: True)
    return sent


UPDATING = (503, {"detail": "正在更新，请稍后", "code": "updating"})
REFUSED = requests.ConnectionError("Failed to establish a new connection: [Errno 61]")


def _scripted_chat(waiting):
    return openai_text._post_json(url="http://hub/gateway/v1/openai/chat/completions",
                                  access_key="t", payload={}, timeout=1, gateway_alias="Hub",
                                  gateway_wait=waiting)


def test_old_host_503_without_code_still_fails(monkeypatch):
    sent = _scripted(monkeypatch, [(503, {"detail": "正在更新，请稍后"})])
    with pytest.raises(openai_text.OpenAITextError, match="text api 503"):
        _scripted_chat(gateway_text_wait.Waiting())
    assert len(sent) == 1


def test_host_restart_after_the_drain_keeps_waiting(monkeypatch):
    sent = _scripted(monkeypatch, [UPDATING, REFUSED, REFUSED, (200, {"ok": True})])
    assert _scripted_chat(gateway_text_wait.Waiting()) == {"ok": True}
    assert len(sent) == 4


def test_refused_connection_without_an_update_fails_right_away(monkeypatch):
    sent = _scripted(monkeypatch, [REFUSED])
    with pytest.raises(openai_text.OpenAITextError):
        _scripted_chat(gateway_text_wait.Waiting())
    assert len(sent) == 1


def test_failure_after_the_connection_was_made_is_never_resent(monkeypatch):
    sent = _scripted(monkeypatch, [UPDATING, requests.ReadTimeout("read timed out")])
    with pytest.raises(openai_text.OpenAITextError):
        _scripted_chat(gateway_text_wait.Waiting())
    assert len(sent) == 2


def test_wait_ends_at_the_limit_and_on_stop(monkeypatch):
    sent = _scripted(monkeypatch, [UPDATING, UPDATING, UPDATING])
    monkeypatch.setattr(gateway_text_wait, "UPDATE_WAIT_SECONDS", 0.0)
    with pytest.raises(openai_text.OpenAITextError) as error:
        _scripted_chat(gateway_text_wait.Waiting())
    assert str(error.value) == "网关正在更新，已等待 0 分钟，请稍后重试"
    assert len(sent) == 1

    sent.clear()
    monkeypatch.setattr(gateway_text_wait, "UPDATE_WAIT_SECONDS", 660.0)
    monkeypatch.setattr(gateway_text_wait, "_pause", lambda _s, should_cancel: not should_cancel())
    with pytest.raises(openai_text.OpenAITextError, match="已按请求停止"):
        _scripted_chat(gateway_text_wait.Waiting(should_cancel=lambda: True))
    assert len(sent) == 1


def test_real_pause_returns_early_when_stopped():
    assert gateway_text_wait._pause(30, lambda: True) is False


# ---------------------------------------------------------------- Agent transport


class _Inner(httpx2.AsyncBaseTransport):
    def __init__(self, answers):
        self.answers = list(answers)
        self.sent = 0

    async def handle_async_request(self, request):
        self.sent += 1
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        status, payload = answer
        return httpx2.Response(status, json=payload, request=request)


def _transport(monkeypatch, answers):
    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(gateway_text_wait, "_async_pause", no_wait)
    waits: list[int] = []
    inner = _Inner(answers)
    return inner, waits, gateway_text_wait.UpdatingAwareTransport(
        inner, on_wait=lambda: waits.append(1))


def _send(transport):
    async def go():
        async with httpx2.AsyncClient(transport=transport) as client:
            return await client.post("http://hub/gateway/v1/openai/chat/completions", json={})
    return asyncio.run(go())


CONNECT = httpx2.ConnectError("connection refused")


def test_agent_transport_waits_through_the_update_and_restart(monkeypatch):
    inner, waits, transport = _transport(monkeypatch, [UPDATING, CONNECT, UPDATING, (200, {})])
    assert _send(transport).status_code == 200
    assert inner.sent == 4 and waits == [1]


def test_agent_transport_retries_a_refused_connection_at_most_twice(monkeypatch):
    inner, _waits, transport = _transport(monkeypatch, [CONNECT, CONNECT, (200, {})])
    assert _send(transport).status_code == 200 and inner.sent == 3
    inner, _waits, transport = _transport(monkeypatch, [CONNECT, CONNECT, CONNECT, (200, {})])
    with pytest.raises(httpx2.ConnectError):
        _send(transport)
    assert inner.sent == 3


def test_agent_transport_never_resends_after_the_connection_was_made(monkeypatch):
    inner, _waits, transport = _transport(monkeypatch, [httpx2.ReadError("reset"), (200, {})])
    with pytest.raises(httpx2.ReadError):
        _send(transport)
    assert inner.sent == 1


def test_agent_transport_passes_other_503_through(monkeypatch):
    inner, waits, transport = _transport(monkeypatch, [(503, {"error": "no channel"})])
    response = _send(transport)
    assert response.status_code == 503 and response.json() == {"error": "no channel"}
    assert inner.sent == 1 and waits == []


def test_agent_on_the_gateway_has_no_sdk_retries_and_uses_the_waiting_transport(
        isolated_data_root):
    from character_workflow.lib import canvas_agent_runtime
    from character_workflow.lib.canvas_projects import create_canvas_project

    project_id = create_canvas_project("Agent 等待网关").project_id
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key="t",
                              base_url="http://127.0.0.1:9", created_at="test", models=[]))
    session = SimpleNamespace(model_alias="Hub", model="gpt-test", effort=None,
                              creation_mode=next(iter(canvas_agent_runtime.CREATION_MODE_PROMPTS)),
                              project_id=project_id)
    agent = canvas_agent_runtime.build_agent(session, on_gateway_wait=lambda: None)
    client = agent.model._client
    assert client.max_retries == 0
    assert isinstance(client._client._transport, gateway_text_wait.UpdatingAwareTransport)


def _canvas_text_project() -> str:
    from datetime import datetime, timezone

    from character_workflow.lib.canvas_projects import (
        create_canvas_project, read_canvas_document, save_canvas_document,
    )
    from character_workflow.lib.schemas import CanvasDocument

    now = datetime.now(timezone.utc).isoformat()
    pid = create_canvas_project("文本等网关").project_id
    current = read_canvas_document(pid)
    payload = current.model_dump(mode="json")
    payload["nodes"] = [{
        "id": "t1", "title": "文本", "type": "text", "position": {"x": 0, "y": 0}, "z_index": 0,
        "data": {"current_version_id": None, "active_run_id": None, "generation_draft": {
            "mode": "text", "prompt": "写一句话", "input_policy": "all_connected", "model": TEXT,
            "alias": "Hub", "params": {}, "updated_at": now}}}]
    save_canvas_document(pid, CanvasDocument.model_validate(payload), current.revision)
    return pid


def test_canvas_text_node_shows_waiting_and_finishes_after_the_update(text_gateway, monkeypatch):
    """真实入口：画布文本节点经 submit_canvas_run → run_canvas_job 走网关；主机排空期间阶段为「等待网关」。"""
    from character_workflow.lib import job_runner, jobs
    from character_workflow.lib.callers import atelier_gateway
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run
    from character_workflow.lib.schemas import JobStatus

    routes = atelier_gateway.check_gateway(text_gateway["base"], text_gateway["token"])["models"]
    keys.patch_key("Hub", {"models": atelier_gateway.gateway_models(routes)})
    phases: list[str] = []
    original = jobs.update_job_phase

    def record(job_id, phase):
        phases.append(phase)
        return original(job_id, phase)

    monkeypatch.setattr(job_runner, "update_job_phase", record)
    _end_update_on_first_pause(monkeypatch)
    pid = _canvas_text_project()
    job, _doc = submit_canvas_run(pid, "t1", read_canvas_document(pid).revision)
    _drain._set_updating(True)
    done = run_canvas_job(job.job_id)
    assert done.status == JobStatus.DONE, done.error
    assert "waiting_gateway" in phases and phases[phases.index("waiting_gateway") + 1] == "sent"
    assert len(text_gateway["calls"]) == 1


def test_studio_text_job_does_not_wait(text_gateway, monkeypatch):
    """没有「等待网关」显示位置的入口（非画布）直接失败，文案平实。"""
    from character_workflow.lib import job_runner, jobs
    from character_workflow.lib.callers import atelier_gateway
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    routes = atelier_gateway.check_gateway(text_gateway["base"], text_gateway["token"])["models"]
    keys.patch_key("Hub", {"models": atelier_gateway.gateway_models(routes)})
    monkeypatch.setattr(gateway_text_wait, "_pause", lambda *_a: pytest.fail("不应等待"))
    jobs.save_job(Job(job_id="studio-text-1", character_id="Hub", prompt="写一句话",
                      submitted_at="2026-11-19T00:00:00+00:00", model=TEXT,
                      params=JobParams(n=1), output_paths=[], status=JobStatus.PENDING,
                      error=None, kind=JobKind.TEXT, namespace="studio", alias="Hub",
                      provider="atelier"))
    _drain._set_updating(True)
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job("studio-text-1")
    failed = jobs.read_job("studio-text-1")
    assert failed.status == JobStatus.FAILED and "网关正在更新，请稍后重试" in failed.error
    assert text_gateway["calls"] == []


def _sse_chunks(text):
    chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "m",
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": text},
                          "finish_reason": None}]}
    done = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    return (b"data: " + json.dumps(chunk).encode() + b"\n\n"
            + b"data: " + json.dumps(done).encode() + b"\n\ndata: [DONE]\n\n")


class _FakeGateway:
    """本机真实套接字的假网关：前 updating_first 次回 503 updating，之后回流式补全。"""

    def __init__(self, updating_first=0):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.seen: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.seen.append(self.path)
                if len(outer.seen) <= updating_first:
                    body = json.dumps({"detail": "正在更新，请稍后", "code": "updating"}).encode()
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                else:
                    body = _sse_chunks("海边的灯塔")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/gateway/v1/openai"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class _RefuseFirstConnect(httpx2.AsyncBaseTransport):
    """第一次真的去连一个关着的端口（拿到真实的 httpx2.ConnectError），之后正常发。"""

    def __init__(self):
        import socket

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.closed_port = sock.getsockname()[1]
        sock.close()
        self.real = httpx2.AsyncHTTPTransport()
        self.refused = 0

    async def handle_async_request(self, request):
        if not self.refused:
            self.refused += 1
            probe = httpx2.Request("POST", request.url.copy_with(port=self.closed_port), content=b"{}")
            await self.real.handle_async_request(probe)
        return await self.real.handle_async_request(request)

    async def aclose(self):
        await self.real.aclose()


@pytest.mark.parametrize("case", ["normal", "updating_then_recovers", "refused_then_resent"])
def test_real_sdk_streaming_client_over_a_socket(monkeypatch, case):
    """真实 AsyncOpenAI 流式客户端（Agent 走 run_streamed）+ 本机真实套接字假网关，读到内容为止。
    transport 必须与 SDK 实际用的 HTTP 库（httpx2）一致，否则第一个请求就断言失败。"""
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(gateway_text_wait, "_async_pause", no_wait)
    gateway = _FakeGateway(updating_first=1 if case == "updating_then_recovers" else 0)
    inner = _RefuseFirstConnect() if case == "refused_then_resent" else None
    waits: list[int] = []

    async def go():
        client = AsyncOpenAI(base_url=gateway.base, api_key="t", max_retries=0,
                             http_client=DefaultAsyncHttpxClient(
                                 trust_env=False, transport=gateway_text_wait.UpdatingAwareTransport(
                                     inner, on_wait=lambda: waits.append(1))))
        try:
            stream = await client.chat.completions.create(
                model="m", messages=[{"role": "user", "content": "hi"}], stream=True)
            return "".join([chunk.choices[0].delta.content or "" async for chunk in stream
                            if chunk.choices])
        finally:
            await client.close()

    try:
        text = asyncio.run(go())
    finally:
        gateway.close()
    assert text == "海边的灯塔"
    expected_posts, expected_waits = {"normal": (1, []), "updating_then_recovers": (2, [1]),
                                      "refused_then_resent": (1, [])}[case]
    assert len(gateway.seen) == expected_posts and waits == expected_waits
    if inner is not None:
        assert inner.refused == 1


def test_real_sdk_client_reads_a_compressed_plain_503(monkeypatch):
    """网关加了压缩、回一个普通（非 updating）503：SDK 拿到可读的 503，不是解码异常。"""
    import gzip
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from openai import APIStatusError, AsyncOpenAI, DefaultAsyncHttpxClient

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            body = gzip.compress(json.dumps({"error": {"message": "no channel"}}).encode())
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    async def go():
        client = AsyncOpenAI(
            base_url=f"http://127.0.0.1:{server.server_port}/gateway/v1/openai", api_key="t",
            max_retries=0, http_client=DefaultAsyncHttpxClient(
                trust_env=False, transport=gateway_text_wait.UpdatingAwareTransport()))
        try:
            return await client.chat.completions.create(
                model="m", messages=[{"role": "user", "content": "hi"}])
        finally:
            await client.close()

    try:
        with pytest.raises(APIStatusError) as error:
            asyncio.run(go())
    finally:
        server.shutdown()
        server.server_close()
    assert error.value.status_code == 503
    assert error.value.body == {"error": {"message": "no channel"}} or "no channel" in str(error.value)


def test_agent_on_other_providers_keeps_the_sdk_defaults(isolated_data_root):
    """不经局域网 Atelier 的 Agent 不受 5-4 影响：SDK 自带重试仍是 2 次，客户端是 SDK 默认的。"""
    from character_workflow.lib import canvas_agent_runtime
    from character_workflow.lib.canvas_projects import create_canvas_project

    project_id = create_canvas_project("Agent 其他供应商").project_id
    keys.add_key(keys.KeySpec(alias="Direct", provider="openrouter", access_key="t",
                              base_url="https://openrouter.ai/api/v1", created_at="test", models=[]))
    session = SimpleNamespace(model_alias="Direct", model="gpt-test", effort=None,
                              creation_mode=next(iter(canvas_agent_runtime.CREATION_MODE_PROMPTS)),
                              project_id=project_id)
    client = canvas_agent_runtime.build_agent(session, on_gateway_wait=lambda: None).model._client
    assert client.max_retries == 2
    assert not isinstance(client._client._transport, gateway_text_wait.UpdatingAwareTransport)


def test_ai_configure_reports_the_update_as_its_headline(text_gateway, monkeypatch):
    """「AI 帮我配置」没有进度位置：不等待，标题就是「网关正在更新，请稍后重试」（按类型，不靠文案猜）。"""
    from character_workflow.lib import http_protocol_assist
    from character_workflow.lib.callers import atelier_gateway

    routes = atelier_gateway.check_gateway(text_gateway["base"], text_gateway["token"])["models"]
    keys.patch_key("Hub", {"models": atelier_gateway.gateway_models(routes)})
    monkeypatch.setattr(gateway_text_wait, "_pause", lambda *_a: pytest.fail("不应等待"))
    _drain._set_updating(True)
    with pytest.raises(http_protocol_assist.AssistError) as error:
        http_protocol_assist.draft(kind="image", alias="Hub", model_id=TEXT,
                                   text="POST /v1/images/generations 返回 data[].url", urls=[])
    assert str(error.value) == "网关正在更新，请稍后重试"
    assert text_gateway["calls"] == []
