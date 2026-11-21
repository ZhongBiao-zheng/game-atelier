"""Gateway protocol selection, provider translation and member-visible settlement."""
import pytest
from pydantic import BaseModel

from character_workflow.lib import gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers.atelier_gateway import gateway_models
from character_workflow.lib.llm_protocols import detect
from viewer_server import gateway_openai
from viewer_server.gateway_app import _route_view


def member(alias, protocol, url="http://127.0.0.1:1", *, manual=None, model_id="shared"):
    key = keys.KeySpec(alias=alias, provider="custom", access_key="fixture-key", base_url=url,
                       text_protocol=manual, created_at="test", modalities=["llm"], models=[
                           keys.ModelSpec(id=model_id, name=model_id, modality="text", protocol=protocol)])
    keys.add_key(key)
    return key


@pytest.mark.parametrize("endpoint", ["chat/completions", "responses"])
@pytest.mark.parametrize("protocol", ["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate-content"])
def test_protocol_and_scope_filter(endpoint, protocol):
    member("denied", "openai-responses" if endpoint == "responses" else "openai-chat")
    member("allowed", protocol)
    owner, _ = gateway_keys.create_key("member", scope=[{"alias": "allowed"}])
    if (protocol == "openai-responses") == (endpoint == "responses"):
        assert gateway_openai._pick(owner, "shared", [], endpoint=endpoint)[0].alias == "allowed"
    else:
        with pytest.raises(gateway_tasks.GatewayRequestError):
            gateway_openai._pick(owner, "shared", [], endpoint=endpoint)


def test_snapshot_supports_old_members_old_hosts_and_agent_restriction():
    class OldMember(BaseModel):
        protocol: str

    member("resp", "openai-responses")
    member("gem", "gemini-generate-content")
    owner, _ = gateway_keys.create_key("member")
    route = model_routes.find_route("text", "shared")
    view = _route_view(route, owner)
    assert [OldMember(**m).protocol for m in view["members"]] == ["openai-chat"] * 2
    assert {m["upstream_protocol"] for m in view["members"]} == {"openai-responses", "gemini-generate-content"}
    [model] = gateway_models([view])
    hub = keys.KeySpec(alias="Hub", provider="atelier", access_key="fixture-key", created_at="test")
    assert detect.agent_tools_unverified(hub, model)
    owner = gateway_keys.update_key(owner.id, scope=[{"alias": "resp"}])
    only = _route_view(route, owner)
    assert only["members"][0]["protocol"] == "openai-responses"
    only["members"][0].pop("upstream_protocol")
    [old] = gateway_models([only])
    assert old.protocol == "openai-responses" and old.via[0].upstream_protocol is None
    assert not detect.agent_tools_unverified(hub, old)


@pytest.fixture
def gateway(monkeypatch):
    from fastapi.testclient import TestClient
    from tests.fake_http_vendor import FakeVendor
    from viewer_server.gateway_app import create_gateway_app

    monkeypatch.setenv("no_proxy", "*")
    _, token = gateway_keys.create_key("member")
    with FakeVendor() as vendor:
        with TestClient(create_gateway_app(), headers={"Authorization": "Bearer " + token}) as client:
            yield vendor, client


CHAT = "/gateway/v1/openai/chat/completions"
NATIVES = ["anthropic-messages", "gemini-generate-content"]


@pytest.mark.parametrize("protocol", NATIVES)
def test_native_json_tools_image_and_errors(protocol, gateway):
    from tests.test_anthropic_protocol_calls import REPLY
    vendor, client = gateway
    member("native", protocol, vendor.url)
    req = {"model": "shared", "messages": [{"role": "user", "content": [
        {"type": "text", "text": "see"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,YQ=="}}]}]}
    if protocol == "anthropic-messages":
        path = "/v1/messages"
        reply = {**REPLY, "stop_reason": "tool_use", "content": [{"type": "text", "text": "yes"}, *[
            {"type": "tool_use", "id": "tool-" + n, "name": n, "input": {}} for n in ("one", "two")]]}
    else:
        path = "/v1beta/models/shared:generateContent"
        reply = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "yes"}, *[
            {"functionCall": {"name": n, "args": {}}} for n in ("one", "two")]]}}]}
    vendor.on("POST", path, reply, (400, {"error": {"message": "native detail"}}),
              (503, {"code": "updating", "error": {"message": "temporary upstream failure"}}))
    result = client.post(CHAT, json=req)
    assert result.status_code == 200, result.text
    msg = result.json()["choices"][0]["message"]
    assert msg["content"] == "yes" and [t["function"]["name"] for t in msg["tool_calls"]] == ["one", "two"]
    assert b'YQ==' in vendor.received[0].body and b'image_url' not in vendor.received[0].body
    for status, detail in [(400, "native detail"), (503, "temporary upstream failure")]:
        failure = client.post(CHAT, json=req)
        assert failure.status_code == status and detail in failure.json()["error"]["message"]
        assert "code" not in failure.json()
    assert len(vendor.received) == 3


def sse_events(response):
    import json
    return [json.loads(line[5:]) for line in response.text.splitlines()
            if line.startswith("data:") and line[5:].strip() != "[DONE]"]


def as_sse(*events):
    import json
    return b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events)


def latest_usage():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))[-1]


@pytest.mark.parametrize("protocol", NATIVES)
def test_translated_stream_terminal_and_usage(gateway, protocol, monkeypatch):
    from pathlib import Path
    from character_workflow.lib import generation_pricing
    monkeypatch.setitem(generation_pricing._PRICES["text_yuan_per_million_tokens"], "shared",
                        {"input": 5, "output": 10})
    vendor, client = gateway
    member("native", protocol, vendor.url)
    payload = {"model": "shared", "stream": True, "messages": [{"role": "user", "content": "q"}]}
    if protocol == "anthropic-messages":
        path = "/v1/messages"
        wire = (Path(__file__).parent / "fixtures/anthropic_stream/tool_use.sse").read_bytes()
        wire = wire.replace(b'"input_tokens":472', b'"input_tokens":472,"cache_read_input_tokens":30,"cache_creation_input_tokens":10')
        expected = (512, 30, 10, 89)
        error = as_sse({"type": "error", "error": {"type": "overloaded_error", "message": "interrupted"}})
    else:
        path = "/v1beta/models/shared:streamGenerateContent"
        wire = as_sse({"candidates": [{"content": {"parts": [{"text": "one"}, {"functionCall": {"name": "tool", "args": {}}}]},
                                      "finishReason": "STOP"}], "usageMetadata": {
                           "promptTokenCount": 80, "cachedContentTokenCount": 20,
                           "candidatesTokenCount": 5, "thoughtsTokenCount": 4}})
        expected = (80, 20, 0, 9)
        error = as_sse({"error": {"message": "interrupted"}})
    vendor.on("POST", path, wire, error)
    response = client.post(CHAT, json=payload)
    events = sse_events(response)
    choices = [choice for event in events for choice in event["choices"]]
    assert any(c["delta"].get("content") for c in choices)
    assert any(c["delta"].get("tool_calls") for c in choices)
    assert choices[-1]["finish_reason"] == "tool_calls"
    row = latest_usage()
    assert tuple(row[field] for field in ("input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens")) == expected
    assert row["charged_cny"] == (expected[0] * 5 + expected[3] * 10) / 1_000_000
    assert row["status"] == "done"
    assert sse_events(client.post(CHAT, json=payload))[-1]["error"]["message"] == "interrupted"
    assert latest_usage()["status"] == "failed" and latest_usage()["charged_cny"] == 0


async def test_member_sdk_streams_real_gateway_and_anthropic(monkeypatch):
    from pathlib import Path
    from character_workflow.lib.canvas_agent_runtime import _agent_client
    from tests.fake_http_vendor import FakeVendor
    from tests.test_gateway_client import _free_port
    from viewer_server.gateway_app import GatewayServer

    monkeypatch.setenv("no_proxy", "*")
    _, token = gateway_keys.create_key("member")
    with FakeVendor() as vendor:
        member("native", "anthropic-messages", vendor.url)
        wire = (Path(__file__).parent / "fixtures/anthropic_stream/tool_use.sse").read_bytes()
        vendor.on("POST", "/v1/messages", wire)
        server = GatewayServer(host="127.0.0.1")
        port = _free_port()
        server.start(port)
        try:
            hub = keys.KeySpec(alias="Hub", provider="atelier", base_url=f"http://127.0.0.1:{port}",
                               access_key=token, created_at="test")
            async with _agent_client(hub, "openai-chat", None, None) as client:
                stream = await client.chat.completions.create(model="shared", stream=True,
                    messages=[{"role": "user", "content": "weather?"}])
                chunks = [chunk async for chunk in stream]
            deltas = [c.delta for chunk in chunks for c in chunk.choices]
            assert any(d.content for d in deltas) and any(d.tool_calls for d in deltas)
            assert len(vendor.received) == 1
        finally:
            server.stop()

def test_cache_write_priced_and_recorded_locally(monkeypatch):
    from character_workflow.lib import agent_usage, generation_pricing
    key = member("chat", "anthropic-messages")
    rates = {"input": 5, "output": 10, "cache_write": 8}
    monkeypatch.setitem(generation_pricing._PRICES["text_yuan_per_million_tokens"], "shared", rates)
    row = agent_usage.record_request(project_id="p", session_id="s", key=key, alias="chat", model="shared",
                                     input_tokens=100, output_tokens=10, cached_tokens=0, cache_write_tokens=20)
    assert row["cache_write_tokens"] == 20 and row["cost_cny"] == (80 * 5 + 20 * 8 + 10 * 10) / 1_000_000


@pytest.mark.parametrize("protocol,path,header,body,can_use", [
    ("openai-chat", "/v1/models", "Authorization", {"data": [{"id": "shared", "supported_parameters": ["tools"]}]}, True),
    ("anthropic-messages", "/v1/models", "x-api-key", {"data": [{"id": "shared", "type": "model"}]}, True),
    ("gemini-generate-content", "/v1beta/models", "x-goog-api-key", {"models": [
        {"name": "models/shared", "supportedGenerationMethods": ["embedContent"]}]}, False),
])
def test_models_use_native_catalog(gateway, protocol, path, header, body, can_use):
    from character_workflow.lib.canvas_agent_models import is_chat_model
    vendor, client = gateway
    member("native", protocol, vendor.url, manual=protocol)
    vendor.on("GET", path, body, (503, {}))
    [model] = client.get("/gateway/v1/openai/models").json()["data"]
    assert is_chat_model(model) == can_use
    headers = {name.lower(): value for name, value in vendor.received[0].headers.items()}
    assert headers[header.lower()].endswith("fixture-key")
    if header != "Authorization":
        assert "authorization" not in headers
    [fallback] = client.get("/gateway/v1/openai/models").json()["data"]
    assert fallback["supported_parameters"] == ["tools"]


@pytest.mark.parametrize("stream", [False, True])
def test_gemini_signed_parallel_calls_round_trip(gateway, stream):
    vendor, client = gateway
    member("gem", "gemini-generate-content", vendor.url)
    path = "/v1beta/models/shared:" + ("streamGenerateContent" if stream else "generateContent")
    parts = [{"functionCall": {"name": "first", "args": {}}, "thoughtSignature": "original-signature"},
             {"functionCall": {"name": "second", "args": {}}}]
    tool = {"candidates": [{"content": {"parts": parts}, "finishReason": "STOP"}]}
    text = {"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]}
    vendor.on("POST", path, *(as_sse(item) if stream else item for item in (tool, text)))
    messages = [{"role": "user", "content": "question"}]
    def send():
        return client.post(CHAT, json={"model": "shared", "stream": stream, "messages": messages})
    initial = send()
    if stream:
        calls = [call for event in sse_events(initial) for choice in event["choices"]
                 for call in choice["delta"].get("tool_calls", [])]
        for call in calls:
            call.pop("index", None)
    else:
        calls = initial.json()["choices"][0]["message"]["tool_calls"]
    assert [call["function"]["name"] for call in calls] == ["first", "second"]
    assert calls[0]["extra_content"]["google"]["thought_signature"] == "original-signature"
    messages.append({"role": "assistant", "tool_calls": calls})
    messages.extend({"role": "tool", "tool_call_id": c["id"], "content": "ok"} for c in calls)
    assert send().status_code == 200
    returned = next(c["parts"] for c in vendor.received[1].json()["contents"] if c["role"] == "model")
    assert returned[0]["thoughtSignature"] == "original-signature" and "thoughtSignature" not in returned[1]
    assert len(vendor.received) == 2


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("reason,expected", [("MAX_TOKENS", "length"), ("FUTURE_REASON", "stop")])
def test_gemini_finish_reason_with_text(gateway, stream, reason, expected):
    vendor, client = gateway
    member("gem", "gemini-generate-content", vendor.url)
    path = "/v1beta/models/shared:" + ("streamGenerateContent" if stream else "generateContent")
    result = {"candidates": [{"content": {"parts": [{"text": "partial"}]}, "finishReason": reason}]}
    vendor.on("POST", path, as_sse(result) if stream else result)
    response = client.post(CHAT, json={"model": "shared", "stream": stream, "messages": [{"role": "user", "content": "q"}]})
    events = sse_events(response) if stream else [response.json()]
    assert [c["finish_reason"] for e in events for c in e["choices"] if c["finish_reason"]] == [expected]


def test_native_refusal_can_switch_member_but_ambiguous_failure_stops(gateway):
    from tests.fake_http_vendor import FakeVendor
    from tests.test_anthropic_protocol_calls import REPLY
    first, client = gateway
    with FakeVendor() as second:
        member("a", "anthropic-messages", first.url)
        member("b", "anthropic-messages", second.url)
        first.on("POST", "/v1/messages", (503, {"error": {"message": "quota exceeded"}}),
                 (401, {"error": {"message": "refused"}}))
        second.on("POST", "/v1/messages", REPLY)
        body = {"model": "shared", "messages": [{"role": "user", "content": "q"}]}
        assert client.post(CHAT, json=body).status_code == 503 and not second.received
        assert client.post(CHAT, json=body).status_code == 200
        assert len(first.received) == 2 and len(second.received) == 1


def test_anthropic_stream_parallel_tools_and_image(gateway):
    from pathlib import Path
    first, client = gateway
    member("native", "anthropic-messages", first.url)
    wire = (Path(__file__).parent / "fixtures/anthropic_stream/tool_use.sse").read_bytes()
    before, finish = wire.split(b"event: message_delta", 1)
    _, tool = before.rsplit(b"event: content_block_start", 1)
    second = tool.replace(b'"index":1', b'"index":2').replace(b'"get_weather"', b'"get_temperature"').replace(
        b'toolu_01T1x1fJ34qAmk2tNTrN7Up6', b'toolu_second')
    first.on("POST", "/v1/messages", before + b"event: content_block_start" + second + b"event: message_delta" + finish)
    result = client.post(CHAT, json={"model": "shared", "stream": True, "messages": [
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,YQ=="}}]}]})
    calls = [t for e in sse_events(result) for c in e["choices"] for t in c["delta"].get("tool_calls", [])]
    assert [(t["index"], t["function"]["name"]) for t in calls if t["function"].get("name")] == [
        (0, "get_weather"), (1, "get_temperature")]
    assert first.received[0].json()["messages"][0]["content"][0]["source"]["data"] == "YQ=="


def test_mixed_chat_route_advertises_and_dispatches_tools_only_to_verified_members(gateway, monkeypatch):
    from character_workflow.lib import canvas_agent_models
    from tests.fake_http_vendor import FakeVendor

    gemini, client = gateway
    with FakeVendor() as chat:
        member("a-gem", "gemini-generate-content", gemini.url)
        member("b-chat", "openai-chat", chat.url)
        chat.on("GET", "/v1/models", {"data": [{"id": "shared", "supported_parameters": ["tools"]}]})
        snapshot = client.get("/gateway/v1/models").json()["models"]
        [model] = gateway_models(snapshot)
        hub = keys.KeySpec(alias="Hub", provider="atelier", access_key="fixture-key",
                           models=[model], created_at="test")
        assert [item.alias for item in model.via] == ["a-gem", "b-chat"]
        [catalog] = client.get("/gateway/v1/openai/models").json()["data"]
        assert catalog["supported_parameters"] == ["tools"] and not gemini.received
        monkeypatch.setattr(canvas_agent_models, "_upstream_for", lambda *_: (
            {"shared": {"agent": canvas_agent_models.is_chat_model(catalog), "reasoning": False}}, None))
        assert [row["model"] for row in canvas_agent_models._models_for(hub, 0)[0]] == ["shared"]
        body = {"model": "shared", "messages": [{"role": "user", "content": "q"}]}
        tools = [{"type": "function", "function": {"name": "weather", "parameters": {"type": "object"}}}]
        chat.on("POST", "/v1/chat/completions", {"choices": [{"message": {"content": "chat"}}]})
        assert client.post(CHAT, json={**body, "tools": tools}).json()["choices"][0]["message"]["content"] == "chat"
        assert chat.received[-1].json()["tools"] == tools and not gemini.received
        model_routes.cool_down("text", "b-chat", "rate_limited")
        gemini.on("POST", "/v1beta/models/shared:generateContent",
                  {"candidates": [{"content": {"parts": [{"text": "gemini"}]}}]})
        assert client.post(CHAT, json=body).json()["choices"][0]["message"]["content"] == "gemini"

        scoped, _ = gateway_keys.create_key("gem-only", scope=[{"alias": "a-gem"}])
        [limited] = gateway_models([_route_view(model_routes.find_route("text", "shared"), scoped)])
        assert canvas_agent_models._models_for(hub.model_copy(update={"models": [limited]}), 0)[0] == []
        with pytest.raises(gateway_tasks.GatewayRequestError):
            gateway_openai._pick(scoped, "shared", [], params={**body, "tools": tools})


@pytest.mark.parametrize("status", [401, 429])
def test_native_refusal_exhaustion_is_not_member_auth_or_quota(status, monkeypatch):
    import json
    from character_workflow.lib import structured_text_call
    from character_workflow.lib.callers.openai_text import OpenAITextError
    from tests.fake_http_vendor import FakeVendor
    from tests.test_gateway_client import _free_port
    from viewer_server.gateway_app import GatewayServer

    monkeypatch.setenv("no_proxy", "*")
    _, token = gateway_keys.create_key("member")
    with FakeVendor() as vendor:
        member("native", "anthropic-messages", vendor.url)
        vendor.on("POST", "/v1/messages", (status, {"error": {"message": "upstream rejected fixture-key"}}))
        server = GatewayServer(host="127.0.0.1")
        port = _free_port()
        server.start(port)
        try:
            hub = keys.KeySpec(alias="Hub", provider="atelier", base_url=f"http://127.0.0.1:{port}",
                               access_key=token, created_at="test")
            spec = keys.ModelSpec(id="shared", name="shared", modality="text", protocol="openai-chat")
            with pytest.raises(OpenAITextError, match="^text api 503: ") as caught:
                structured_text_call.call_model(hub, spec, "test", "q", max_output_tokens=10, timeout=(2, 5))
            detail = json.loads(str(caught.value).removeprefix("text api 503: "))["error"]
            assert (detail["type"], detail["code"], detail["upstream_status"]) == ("gateway_unavailable", 503, status)
            assert "upstream rejected <redacted>" in detail["message"] and "fixture-key" not in detail["message"]
            assert not model_routes._cooling("text", "Hub")
            assert model_routes._cooling("text", "native") and len(vendor.received) == 1
        finally:
            server.stop()


def test_native_balance_refusal_with_http_400_switches_to_next_member(gateway):
    from tests.fake_http_vendor import FakeVendor
    from tests.test_anthropic_protocol_calls import REPLY

    first, client = gateway
    with FakeVendor() as second:
        member("a-balance", "anthropic-messages", first.url)
        member("b-balance", "anthropic-messages", second.url)
        first.on("POST", "/v1/messages", (400, {"error": {"message": "余额不足"}}))
        second.on("POST", "/v1/messages", REPLY)
        result = client.post(CHAT, json={"model": "shared", "messages": [{"role": "user", "content": "q"}]})
        assert result.status_code == 200, result.text
        assert len(first.received) == len(second.received) == 1
