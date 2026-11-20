"""内置 Agent 走 Gemini generateContent（ADR-0044 第 5 批）：真实 openai-agents Runner + 本机套接字假上游。

钉住三件事：
1. openai-agents 0.23.1 的签名通道：tool_call 上的 `extra_content.google.thought_signature` 存进会话条目的
   `provider_data`，模型名含 gemini 时原样放回（用例名带 openai_agents）。升级 openai-agents 后先跑这些。
2. 会话中途换模型：Gemini 产生的 id 发给 OpenAI Chat、Responses、Anthropic 都合法，调用与结果一一对应，
   签名不往别家发；换回 Gemini 时老签名带回，别家的调用不填占位值。
3. 占位值只在三种情况出现：模型名不含 gemini、等确认时换成 Gemini、签名超过上限。
"""
from __future__ import annotations

import asyncio
import json
import re

import pytest

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import keys
from character_workflow.lib.canvas_agent_sessions import (
    create_canvas_agent_session, mutate_canvas_agent_session, read_canvas_agent_session,
)
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.llm_protocols import gemini
from tests.fake_http_vendor import FakeVendor

GEMINI = "gemini-test"
SIG = "SIG-A-" + "x" * 64


@pytest.fixture(autouse=True)
def _no_proxy(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)


def _gem_path(model: str = GEMINI) -> str:
    return f"/v1beta/models/{model}:streamGenerateContent"


def _gem(*events: dict) -> bytes:
    return b"".join(b"data: " + json.dumps(e).encode() + b"\r\n\r\n" for e in events)


USAGE = {"promptTokenCount": 100, "candidatesTokenCount": 5, "totalTokenCount": 105}


def _gem_tool(signature: str | None = SIG, name: str = "get_canvas") -> bytes:
    part: dict = {"functionCall": {"name": name, "args": {}}}
    if signature:
        part["thoughtSignature"] = signature
    return _gem({"candidates": [{"content": {"role": "model", "parts": [part]},
                                 "finishReason": "STOP"}], "usageMetadata": USAGE})


def _gem_text(text: str = "完成") -> bytes:
    return _gem({"candidates": [{"content": {"role": "model", "parts": [{"text": text}]},
                                 "finishReason": "STOP"}], "usageMetadata": USAGE})


def _chat(*chunks: dict) -> bytes:
    body = b"".join(b"data: " + json.dumps(c).encode() + b"\n\n" for c in chunks)
    return body + b"data: [DONE]\n\n"


def _chat_tool(name: str, arguments: dict) -> bytes:
    return _chat(
        {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "gpt-test",
         "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{
             "index": 0, "id": "call_chat1", "type": "function",
             "function": {"name": name, "arguments": json.dumps(arguments)}}]},
             "finish_reason": None}]},
        {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "gpt-test",
         "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})


def _chat_text(text: str = "好") -> bytes:
    return _chat({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "gpt-test",
                  "choices": [{"index": 0, "delta": {"role": "assistant", "content": text},
                               "finish_reason": "stop"}]})


REFUSED = (400, {"error": {"message": "fake upstream: shape only"}})


def _setup(vendor: FakeVendor) -> tuple[str, str]:
    models = [("gemini-test", "gemini-generate-content"), ("relay-pro", "gemini-generate-content"),
              ("gpt-test", "openai-chat"), ("gpt-resp", "openai-responses"),
              ("claude-test", "anthropic-messages")]
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="v", provider="custom", base_url=vendor.url, access_key="secret-key", modalities=["llm"],
        models=[keys.ModelSpec(id=mid, name=mid, modality="text", protocol=protocol)
                for mid, protocol in models],
        created_at="2026-11-20T00:00:00Z")]))
    project = create_canvas_project("协议")
    session = create_canvas_agent_session(project.project_id, "s")
    return project.project_id, session.session_id


def _use(pid: str, sid: str, model: str, mode: str = "auto") -> None:
    mutate_canvas_agent_session(pid, sid, lambda _s, _n: {
        "model": model, "model_alias": "v", "permission_mode": mode})


def _turn(pid: str, sid: str, model: str, text: str = "读一下画布", mode: str = "auto"):
    _use(pid, sid, model, mode)
    runtime.begin_user_turn(pid, sid, text, [], None)
    asyncio.run(runtime.run_turn(pid, sid, lambda *_a, **_k: None))
    return read_canvas_agent_session(pid, sid)


def _bodies(vendor: FakeVendor, path: str) -> list[dict]:
    return [json.loads(call.body) for call in vendor.calls("POST", path)]


def _function_calls(body: dict) -> list[dict]:
    return [part for content in body["contents"] for part in content["parts"] if "functionCall" in part]


def _gemini_tool_turn(vendor: FakeVendor, pid: str, sid: str):
    session = _turn(pid, sid, GEMINI)
    assert session.status == "idle", session.error
    return session


# ── 1. openai-agents 的签名通道 ─────────────────────────────────────────────────────

def test_openai_agents_stores_the_signature_in_provider_data_and_replays_it_for_gemini_names():
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem_tool(), _gem_text())
        pid, sid = _setup(vendor)
        session = _gemini_tool_turn(vendor, pid, sid)
        first, second = _bodies(vendor, _gem_path())
        headers = {k.lower(): v for k, v in vendor.calls("POST", _gem_path())[0].headers.items()}
    # 同一轮第二次请求：第一个 functionCall 带回原签名；鉴权只有 x-goog-api-key。
    [part] = _function_calls(second)
    assert part["thoughtSignature"] == SIG
    assert headers["x-goog-api-key"] == "secret-key" and "authorization" not in headers
    # 会话文件里签名在 provider_data；id 是短 id。
    [call] = [item for item in session.history if item.get("type") == "function_call"]
    assert call["provider_data"]["thought_signature"] == SIG
    assert re.fullmatch(r"gsr_[0-9a-f]{24}", call["call_id"])
    assert "contents" in first and "tools" in first


# ── 2. 换模型 ───────────────────────────────────────────────────────────────────────

def _pairs_ok(call_ids: list[str], result_ids: list[str]) -> None:
    assert call_ids and sorted(call_ids) == sorted(result_ids)


@pytest.mark.parametrize("target", ["gpt-test", "gpt-resp", "claude-test"])
def test_after_a_gemini_tool_turn_other_interfaces_get_valid_ids_and_no_signature(target):
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem_tool(), _gem_text())
        for path in ("/v1/chat/completions", "/v1/responses", "/v1/messages"):
            vendor.on("POST", path, REFUSED)
        pid, sid = _setup(vendor)
        _gemini_tool_turn(vendor, pid, sid)
        _turn(pid, sid, target, "再说一遍")
        path = {"gpt-test": "/v1/chat/completions", "gpt-resp": "/v1/responses",
                "claude-test": "/v1/messages"}[target]
        [body] = _bodies(vendor, path)
    text = json.dumps(body)
    assert SIG not in text and "extra_content" not in text and "provider_data" not in text
    if target == "gpt-test":
        calls = [c["id"] for m in body["messages"] if m["role"] == "assistant"
                 for c in m.get("tool_calls") or []]
        results = [m["tool_call_id"] for m in body["messages"] if m["role"] == "tool"]
        assert all(re.fullmatch(r"[A-Za-z0-9_-]{1,40}", c) for c in calls)
    elif target == "gpt-resp":
        calls = [i["call_id"] for i in body["input"] if i.get("type") == "function_call"]
        results = [i["call_id"] for i in body["input"] if i.get("type") == "function_call_output"]
        assert all(re.fullmatch(r"[A-Za-z0-9_-]{1,40}", c) for c in calls)
    else:
        blocks = [b for m in body["messages"] if isinstance(m["content"], list) for b in m["content"]]
        calls = [b["id"] for b in blocks if b["type"] == "tool_use"]
        results = [b["tool_use_id"] for b in blocks if b["type"] == "tool_result"]
        assert all(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", c) for c in calls)
    _pairs_ok(calls, results)


def test_switching_away_and_back_replays_old_signatures_and_leaves_other_calls_alone():
    """Gemini → OpenAI Chat → Gemini：第一轮的签名带回；第二轮 OpenAI 的调用属于更早的轮次，
    官方只校验当前轮，所以不带签名也不填占位值。"""
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem_tool(), _gem_text(), _gem_text())
        vendor.on("POST", "/v1/chat/completions", _chat_tool("get_canvas", {}), _chat_text())
        pid, sid = _setup(vendor)
        _gemini_tool_turn(vendor, pid, sid)
        assert _turn(pid, sid, "gpt-test", "换个模型").status == "idle"
        assert _turn(pid, sid, GEMINI, "换回来").status == "idle"
        third_turn = _bodies(vendor, _gem_path())[-1]
    gemini_call, chat_call = _function_calls(third_turn)
    assert gemini_call["thoughtSignature"] == SIG
    assert "thoughtSignature" not in chat_call


# ── 3. 占位值的三种情况 ─────────────────────────────────────────────────────────────

def test_model_name_without_gemini_gets_the_placeholder_within_the_turn():
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path("relay-pro"), _gem_tool(), _gem_text())
        pid, sid = _setup(vendor)
        assert _turn(pid, sid, "relay-pro").status == "idle"
        second = _bodies(vendor, _gem_path("relay-pro"))[1]
    [part] = _function_calls(second)
    assert part["thoughtSignature"] == gemini.PLACEHOLDER_SIGNATURE


def test_switching_to_gemini_while_awaiting_approval_fills_the_placeholder():
    changes = {"changes": [{"op": "add_surface", "kind": "image", "title": "猫", "node_id": "cat-1",
                            "position": {"x": 0, "y": 0}}]}
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/chat/completions", _chat_tool("apply_changes", changes))
        vendor.on("POST", _gem_path(), _gem_text())
        pid, sid = _setup(vendor)
        paused = _turn(pid, sid, "gpt-test", "加一个节点", mode="review")
        assert paused.status == "awaiting_approval", paused.error
        _use(pid, sid, GEMINI, "review")
        runtime.resolve_approvals(pid, sid, {a.call_id: True for a in paused.pending_approvals})
        asyncio.run(runtime.run_turn(pid, sid, lambda *_a, **_k: None))
        assert read_canvas_agent_session(pid, sid).status == "idle"
        [body] = _bodies(vendor, _gem_path())
    [part] = _function_calls(body)
    assert part["functionCall"]["name"] == "apply_changes"
    assert part["thoughtSignature"] == gemini.PLACEHOLDER_SIGNATURE


def test_oversized_signature_stays_out_of_the_session_and_the_turn_uses_the_placeholder():
    huge = "H" * (gemini.MAX_SIGNATURE_CHARS + 1)
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem_tool(huge), _gem_text())
        pid, sid = _setup(vendor)
        session = _gemini_tool_turn(vendor, pid, sid)
        second = _bodies(vendor, _gem_path())[1]
    [part] = _function_calls(second)
    assert part["thoughtSignature"] == gemini.PLACEHOLDER_SIGNATURE
    assert "HHHH" not in json.dumps(session.model_dump(mode="json"))


# ── 出口去签名 ─────────────────────────────────────────────────────────────────────

def test_session_api_and_export_package_leave_the_signature_out(tmp_path):
    import zipfile

    from character_workflow.lib.canvas_packages import export_canvas_projects
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem_tool(), _gem_text())
        pid, sid = _setup(vendor)
        _gemini_tool_turn(vendor, pid, sid)
    assert SIG in json.dumps(read_canvas_agent_session(pid, sid).model_dump(mode="json"))  # 落盘保留
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    response = client.get(f"/api/canvas/projects/{pid}/agent/sessions/{sid}")
    assert response.status_code == 200 and SIG not in response.text
    archive, _ = export_canvas_projects([pid])
    with zipfile.ZipFile(archive) as package:
        sessions = [name for name in package.namelist() if "/agent/sessions/" in name]
        assert sessions and all(SIG.encode() not in package.read(name) for name in sessions)
        # 签名去掉了，id 的签名状态也改成「没保留」：导入后续跑填占位值，不报「签名丢失」。
        exported = b"".join(package.read(name) for name in sessions)
        assert b'"gsr_' not in exported and b'"gxr_' in exported


# ── 审查补的四种场景：并行调用、上游 id、看图、非 STOP 结束（直接用 Runner + 进程内上游） ──────

class _Upstream:
    """进程内假上游：记下发给 Gemini 的请求体，按顺序回放响应。"""

    def __init__(self, *replies: bytes) -> None:
        import httpx2

        self.replies = list(replies)
        self.requests: list[dict] = []
        outer = self

        class Transport(httpx2.AsyncBaseTransport):
            async def handle_async_request(self, request):
                outer.requests.append(json.loads(await request.aread()))
                reply = outer.replies.pop(0) if len(outer.replies) > 1 else outer.replies[0]
                return httpx2.Response(200, content=reply, request=request,
                                       headers={"Content-Type": "text/event-stream"})

        self.transport = Transport()


def _agent(upstream: _Upstream, tools: list, model: str = "gemini-2.5-pro"):
    from agents import Agent, OpenAIChatCompletionsModel, set_tracing_disabled
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    from character_workflow.lib.llm_protocols.transport import ProtocolTransport

    set_tracing_disabled(True)
    client = AsyncOpenAI(base_url="https://gem.example/v1", api_key="k", max_retries=0,
                         http_client=DefaultAsyncHttpxClient(trust_env=False, transport=ProtocolTransport(
                             protocol="gemini-generate-content", base_url="https://gem.example",
                             access_key="k", inner=upstream.transport)))
    return Agent(name="a", instructions="sys", tools=tools,
                 model=OpenAIChatCompletionsModel(model=model, openai_client=client))


async def _drain(result):
    async for _ in result.stream_events():
        pass
    return result


def _gem_calls(*calls: dict, signature: str | None = SIG) -> bytes:
    parts = [{"functionCall": call} for call in calls]
    if signature:
        parts[0]["thoughtSignature"] = signature
    return _gem({"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
                 "usageMetadata": USAGE})


def test_parallel_results_reach_gemini_in_call_order_even_when_one_waited_for_approval():
    """审查模式下并行三个同名调用、第二个要确认：结果到达顺序是 1、3、2，发给 Gemini 时要按 1、2、3。"""
    from agents import Runner, function_tool

    async def needs(_ctx, args, _call_id):
        return args.get("n") == 2

    @function_tool(needs_approval=needs)
    def run_generation(n: int) -> str:
        """gen"""
        return f"result-{n}"

    async def go():
        upstream = _Upstream(_gem_calls(*({"name": "run_generation", "args": {"n": n}} for n in (1, 2, 3))),
                             _gem_text())
        agent = _agent(upstream, [run_generation])
        first = await _drain(Runner.run_streamed(agent, "go", max_turns=4))
        [pending] = first.interruptions
        history = json.loads(json.dumps(first.to_input_list(), default=str))
        history.append({"type": "function_call_output", "call_id": pending.raw_item.call_id,
                        "output": "result-2"})
        await _drain(Runner.run_streamed(agent, history, max_turns=4))
        return upstream.requests[-1]

    body = asyncio.run(go())
    responses = [part["functionResponse"] for content in body["contents"] for part in content["parts"]
                 if "functionResponse" in part]
    assert [r["response"]["result"] for r in responses] == ["result-1", "result-2", "result-3"]
    calls = _function_calls(body)
    assert [c["functionCall"]["args"]["n"] for c in calls] == [1, 2, 3]
    assert [("thoughtSignature" in c) for c in calls] == [True, False, False]


def test_gemini_call_ids_come_back_on_the_function_response():
    from agents import Runner, function_tool

    @function_tool
    def get_canvas() -> str:
        """read"""
        return "{}"

    async def go():
        upstream = _Upstream(_gem_calls({"name": "get_canvas", "args": {}, "id": "fc-1"},
                                        {"name": "get_canvas", "args": {}, "id": "fc-2"}), _gem_text())
        await _drain(Runner.run_streamed(_agent(upstream, [get_canvas]), "go", max_turns=4))
        return upstream.requests[1]

    body = asyncio.run(go())
    assert [c["functionCall"]["id"] for c in _function_calls(body)] == ["fc-1", "fc-2"]
    assert [part["functionResponse"]["id"] for content in body["contents"] for part in content["parts"]
            if "functionResponse" in part] == ["fc-1", "fc-2"]


def test_attached_images_follow_the_function_responses_as_inline_data():
    """看图主流程（工具结果带 attach_images，调模型前插一条 user 图片消息）：发给 Gemini 的是
    [functionResponse, text, inlineData]。真实 Gemini 是否接受这个形状要计费实测确认（P5-points 场景 A）。"""
    from agents import RunConfig, Runner, function_tool
    from agents.run_config import ModelInputData

    from character_workflow.lib import canvas_agent_vision as vision

    @function_tool
    def read_media() -> str:
        """read"""
        return json.dumps({"ok": True, vision.ATTACH_KEY: ["ver-1"]})

    async def attach(data):
        return ModelInputData(input=vision.with_attached_images(
            list(data.model_data.input), lambda _v: "data:image/png;base64,AAAA"),
            instructions=data.model_data.instructions)

    async def go():
        upstream = _Upstream(_gem_calls({"name": "read_media", "args": {}}), _gem_text())
        await _drain(Runner.run_streamed(_agent(upstream, [read_media]), "看图", max_turns=4,
                                         run_config=RunConfig(call_model_input_filter=attach)))
        return upstream.requests[1]

    body = asyncio.run(go())
    last_user = [c for c in body["contents"] if c["role"] == "user"][-1]
    kinds = [next(iter(part)) for part in last_user["parts"]]
    assert kinds[0] == "functionResponse" and "inlineData" in kinds
    assert {"inlineData": {"mimeType": "image/png", "data": "AAAA"}} in last_user["parts"]


@pytest.mark.parametrize("reason", ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER",
                                    "LANGUAGE", "MISSING_THOUGHT_SIGNATURE", "SAFETY", "MAX_TOKENS"])
def test_non_stop_finish_without_content_fails_the_turn_with_the_upstream_reason(reason):
    with FakeVendor() as vendor:
        vendor.on("POST", _gem_path(), _gem({"candidates": [{
            "finishReason": reason, "finishMessage": "Malformed function call: print(default_api.x("}],
            "usageMetadata": USAGE}))
        pid, sid = _setup(vendor)
        session = _turn(pid, sid, GEMINI)
    assert session.status == "failed"
    assert reason in (session.error or "") and "Malformed function call" in (session.error or "")
