"""Anthropic 流式转换与 ProtocolTransport（ADR-0044 第 2 批）。

夹具 `tests/fixtures/anthropic_stream/*.sse` 原样取自官方流式文档。端到端用例用真实 `AsyncOpenAI` 客户端
（openai 3.x 的 httpx2）+ 本机真实套接字的假上游，读到内容与工具调用为止；Agent 一轮工具往返用真实的
openai-agents Runner。不发任何真实请求。
"""
import asyncio
import json
from pathlib import Path

import httpx2
import pytest

from character_workflow.lib import gateway_text_wait
from character_workflow.lib.llm_protocols import anthropic
from character_workflow.lib.llm_protocols.transport import ProtocolTransport
from tests.fake_http_vendor import FakeVendor

FIXTURES = Path(__file__).parent / "fixtures" / "anthropic_stream"
TEXT = (FIXTURES / "text.sse").read_bytes()
TOOL = (FIXTURES / "tool_use.sse").read_bytes()
SECRET = "sk-ant-test-0123456789"


def chunks(raw: bytes) -> list:
    """把 Chat SSE 拆回数据块；[DONE] 原样保留成字符串。"""
    out = []
    for line in raw.decode("utf-8").split("\n"):
        if line.startswith("data: "):
            data = line[6:]
            out.append(data if data == "[DONE]" else json.loads(data))
    return out


def translate(raw: bytes, *, step: int | None = None) -> list:
    translator = anthropic.StreamTranslator(model="claude-x")
    pieces = [raw] if step is None else [raw[i:i + step] for i in range(0, len(raw), step)]
    out = b"".join(translator.feed(piece) for piece in pieces) + translator.finish()
    return chunks(out)


def text_of(blocks: list) -> str:
    return "".join(block["choices"][0]["delta"].get("content") or "" for block in blocks
                   if isinstance(block, dict) and block.get("choices"))


def finish_of(blocks: list) -> list:
    return [block["choices"][0]["finish_reason"] for block in blocks
            if isinstance(block, dict) and block.get("choices")
            and block["choices"][0]["finish_reason"]]


def usage_of(blocks: list) -> dict:
    [usage] = [block["usage"] for block in blocks if isinstance(block, dict) and "usage" in block]
    return usage


# --- 转换器：官方样例逐事件 ------------------------------------------------------------

def test_text_stream_from_official_sample():
    blocks = translate(TEXT)
    assert blocks[0]["choices"][0]["delta"] == {"role": "assistant", "content": ""}
    assert blocks[0]["id"] == "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY"
    assert text_of(blocks) == "Hello!"
    assert finish_of(blocks) == ["stop"]
    assert usage_of(blocks)["prompt_tokens"] == 25 and usage_of(blocks)["completion_tokens"] == 15
    assert blocks[-1] == "[DONE]"


@pytest.mark.parametrize("step", [1, 7, 64])
def test_bytes_split_anywhere_give_the_same_result(step):
    whole, split = translate(TOOL), translate(TOOL, step=step)
    for block in (*whole, *split):
        if isinstance(block, dict):
            block.pop("created", None)
    assert split == whole


def test_tool_use_stream_from_official_sample():
    blocks = translate(TOOL)
    assert text_of(blocks) == "Okay, let's check the weather for San Francisco, CA:"
    calls = [call for block in blocks if isinstance(block, dict) and block.get("choices")
             for call in block["choices"][0]["delta"].get("tool_calls") or []]
    assert calls[0] == {"index": 0, "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "type": "function",
                        "function": {"name": "get_weather", "arguments": ""}}
    arguments = "".join(call["function"].get("arguments") or "" for call in calls)
    assert json.loads(arguments) == {"location": "San Francisco, CA"}
    assert {call["index"] for call in calls} == {0}
    assert finish_of(blocks) == ["tool_calls"]
    assert usage_of(blocks)["prompt_tokens"] == 472 and usage_of(blocks)["completion_tokens"] == 89


def _events(*events: dict) -> bytes:
    return b"".join(b"event: " + e["type"].encode() + b"\ndata: " + json.dumps(e).encode() + b"\n\n"
                    for e in events)


def test_message_delta_usage_is_cumulative_not_added():
    """文档：message_delta 的 usage 是累计值。两次 message_delta 取最后一次，不相加。"""
    raw = _events(
        {"type": "message_start", "message": {"id": "m", "usage": {
            "input_tokens": 10, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 5,
            "output_tokens": 1}}},
        {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 5}},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 12}},
        {"type": "message_stop"},
    )
    usage = usage_of(translate(raw))
    assert usage["completion_tokens"] == 12
    assert usage["prompt_tokens"] == 45  # 10 + 30 + 5：Anthropic 的输入不含缓存
    assert usage["prompt_tokens_details"] == {"cached_tokens": 30, "cache_write_tokens": 5}


def test_error_event_becomes_an_error_chunk_without_done():
    raw = _events({"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 1}}},
                  {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
    blocks = translate(raw)
    assert blocks[-1] == {"error": {"message": "Overloaded", "type": "overloaded_error"}}
    assert "[DONE]" not in blocks


def test_stream_cut_before_message_stop_is_an_error():
    blocks = translate(TEXT.split(b"event: message_stop")[0])
    assert blocks[-1]["error"]["type"] == "incomplete_stream"
    assert "[DONE]" not in blocks


# --- 真实 AsyncOpenAI + 本机套接字假上游 ---------------------------------------------------

def _client(base_url: str, inner=None):
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    return AsyncOpenAI(
        base_url=f"{base_url}/v1", api_key="placeholder", max_retries=0,
        http_client=DefaultAsyncHttpxClient(trust_env=False, transport=ProtocolTransport(
            base_url=base_url, access_key=SECRET, inner=inner)))


def _run(coroutine_factory):
    return asyncio.run(coroutine_factory())


def test_real_client_non_streaming_call():
    reply = {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
             "content": [{"type": "text", "text": "好的"}], "stop_reason": "end_turn",
             "usage": {"input_tokens": 2048, "cache_read_input_tokens": 1800,
                       "cache_creation_input_tokens": 248, "output_tokens": 503}}
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", reply)

        async def go():
            client = _client(vendor.url)
            try:
                return await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "system", "content": "规则"},
                                                {"role": "user", "content": "你好"}])
            finally:
                await client.close()

        completion = _run(go)
        [sent] = vendor.calls("POST", "/v1/messages")
    assert completion.choices[0].message.content == "好的"
    assert completion.usage.prompt_tokens == 4096
    assert completion.usage.prompt_tokens_details.cached_tokens == 1800
    headers = {name.lower(): value for name, value in sent.headers.items()}
    assert headers["x-api-key"] == SECRET and "authorization" not in headers
    assert sent.json()["system"] == "规则" and sent.json()["max_tokens"] == anthropic.DEFAULT_MAX_TOKENS


def test_real_client_streams_text_and_usage():
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", TEXT)

        async def go():
            client = _client(vendor.url)
            try:
                stream = await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "user", "content": "hi"}], stream=True,
                    stream_options={"include_usage": True})
                return [chunk async for chunk in stream]
            finally:
                await client.close()

        received = _run(go)
        [sent] = vendor.calls("POST", "/v1/messages")
    assert "".join(c.choices[0].delta.content or "" for c in received if c.choices) == "Hello!"
    assert received[-1].usage.completion_tokens == 15
    assert sent.json()["stream"] is True


def test_real_client_streams_tool_calls():
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", TOOL)

        async def go():
            client = _client(vendor.url)
            try:
                stream = await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "user", "content": "天气"}], stream=True,
                    tools=[{"type": "function", "function": {
                        "name": "get_weather", "parameters": {
                            "type": "object", "properties": {"location": {"type": "string"}}}}}])
                return [chunk async for chunk in stream]
            finally:
                await client.close()

        received = _run(go)
    calls = [call for c in received if c.choices for call in c.choices[0].delta.tool_calls or []]
    assert calls[0].id == "toolu_01T1x1fJ34qAmk2tNTrN7Up6" and calls[0].function.name == "get_weather"
    assert json.loads("".join(c.function.arguments or "" for c in calls)) == {
        "location": "San Francisco, CA"}


def test_real_client_surfaces_upstream_errors():
    from openai import AuthenticationError

    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", (401, {"type": "error", "error": {
            "type": "authentication_error", "message": "invalid x-api-key"}}))

        async def go():
            client = _client(vendor.url)
            try:
                await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "user", "content": "hi"}])
            finally:
                await client.close()

        with pytest.raises(AuthenticationError, match="invalid x-api-key"):
            _run(go)


def test_agent_tool_round_trip_through_the_sdk():
    """真实 openai-agents Runner：第一轮 Claude 调工具，SDK 执行后第二轮把 tool_result 带回去。"""
    from agents import Agent, OpenAIChatCompletionsModel, Runner, function_tool, set_tracing_disabled

    set_tracing_disabled(True)

    @function_tool
    def get_weather(location: str) -> str:
        """查天气。"""
        return f"{location} 晴"

    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", TOOL, TEXT)

        async def go():
            client = _client(vendor.url)
            try:
                agent = Agent(name="t", instructions="你是助手", tools=[get_weather],
                              model=OpenAIChatCompletionsModel(model="claude-x", openai_client=client))
                result = Runner.run_streamed(agent, "旧金山天气")
                async for _event in result.stream_events():
                    pass
                return result
            finally:
                await client.close()

        result = _run(go)
        first, second = [call.json() for call in vendor.calls("POST", "/v1/messages")]
    assert result.final_output == "Hello!"
    assert first["system"] == "你是助手"
    assert first["tools"][0]["name"] == "get_weather"
    assistant, tool_turn = second["messages"][-2:]
    assert assistant["role"] == "assistant"
    assert {"type": "tool_use", "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "name": "get_weather",
            "input": {"location": "San Francisco, CA"}} in assistant["content"]
    assert tool_turn == {"role": "user", "content": [{
        "type": "tool_result", "tool_use_id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
        "content": "San Francisco, CA 晴"}]}
    assert result.context_wrapper.usage.output_tokens == 89 + 15


# --- 两层 transport 叠加：转换在外、等待重发在内 ----------------------------------------------

def test_stacked_with_gateway_wait_converts_then_resends_the_converted_request(monkeypatch):
    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(gateway_text_wait, "_async_pause", no_wait)
    waits: list[int] = []
    with FakeVendor() as vendor:
        vendor.on("POST", "/v1/messages", (503, {"code": "updating"}), TEXT)

        async def go():
            inner = gateway_text_wait.UpdatingAwareTransport(on_wait=lambda: waits.append(1))
            client = _client(vendor.url, inner=inner)
            try:
                stream = await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "user", "content": "hi"}], stream=True)
                return "".join([c.choices[0].delta.content or "" async for c in stream if c.choices])
            finally:
                await client.close()

        text = _run(go)
        posts = vendor.calls("POST", "/v1/messages")
    assert text == "Hello!" and waits == [1]
    assert len(posts) == 2 and posts[0].json() == posts[1].json()  # 重发的是转换后的同一个请求


def test_other_paths_pass_through_untouched():
    with FakeVendor() as vendor:
        vendor.on("GET", "/v1/models", {"data": []})

        async def go():
            transport = ProtocolTransport(base_url=vendor.url, access_key=SECRET)
            async with httpx2.AsyncClient(transport=transport) as client:
                return await client.get(f"{vendor.url}/v1/models")

        response = _run(go)
    assert response.status_code == 200 and response.json() == {"data": []}


def test_environment_proxy_is_used_after_conversion(monkeypatch):
    """客户端 trust_env=False 时，代理由内层按上游地址选：请求先转换、再经代理发出（不会原样绕过转换）。"""
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    for name in ("NO_PROXY", "no_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    with FakeVendor() as proxy:
        proxy.on("POST", "/v1/messages", TEXT)
        monkeypatch.setenv("HTTP_PROXY", proxy.url)

        async def go():
            client = AsyncOpenAI(
                base_url="http://claude.invalid/v1", api_key="placeholder", max_retries=0,
                http_client=DefaultAsyncHttpxClient(trust_env=False, transport=ProtocolTransport(
                    base_url="http://claude.invalid", access_key=SECRET)))
            try:
                stream = await client.chat.completions.create(
                    model="claude-x", messages=[{"role": "user", "content": "hi"}], stream=True)
                return "".join([c.choices[0].delta.content or "" async for c in stream if c.choices])
            finally:
                await client.close()

        text = _run(go)
        [sent] = proxy.calls("POST", "/v1/messages")
    assert text == "Hello!"
    assert {k.lower(): v for k, v in sent.headers.items()}["x-api-key"] == SECRET
