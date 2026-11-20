"""Anthropic Messages 协议的端到端行为（ADR-0044 第 1 批）：本机真实套接字的假上游，不发任何真实请求。

覆盖：一次性文本调用（画布文本节点、AI 帮我配置、分镜解析共用的两条路径）、供应商级「接口」的写入边界、
按 Anthropic 鉴权头列模型且不跟随重定向、前端可调用判据、局域网网关与 Agent 在接上转换之前把它挡在外面。
"""
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import (
    canvas_agent_models, gateway_keys, gateway_tasks, keys, model_routes, structured_text_call,
)
from character_workflow.lib.callers import openai_text
from character_workflow.lib.llm_protocols import SWITCH_INTERFACE
from tests.fake_http_vendor import FakeVendor, png_bytes
from tests.local_client import LocalTestClient
from viewer_server import gateway_openai
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app

SECRET = "sk-ant-test-0123456789"
REPLY = {
    "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
    "content": [{"type": "text", "text": "好的"}], "stop_reason": "end_turn", "stop_sequence": None,
    "usage": {"input_tokens": 2048, "cache_read_input_tokens": 1800,
              "cache_creation_input_tokens": 248, "output_tokens": 503},
}


@pytest.fixture(autouse=True)
def _clean(isolated_data_root):
    model_routes._cooldowns.clear()
    canvas_agent_models._cache.clear()
    yield
    model_routes._cooldowns.clear()
    canvas_agent_models._cache.clear()


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        server.on("POST", "/v1/messages", REPLY)
        yield server


def add_claude(base_url: str, alias: str = "claude", model_id: str = "claude-x", **extra):
    keys.add_key(keys.KeySpec(
        alias=alias, provider="custom", base_url=base_url, access_key=SECRET,
        models=[keys.ModelSpec(id=model_id, name=model_id, modality="text",
                               protocol="anthropic-messages", input_modalities=["text", "image"])],
        created_at="2026-11-20T00:00:00Z", **extra))


# --- 一次性文本调用 -------------------------------------------------------------

def test_generate_posts_messages_with_anthropic_auth_and_loops_for_n(vendor):
    add_claude(vendor.url)
    outputs = openai_text.generate(prompt="写一句", model="claude-x", alias="claude", n=2,
                                   params={"max_tokens": 300, "temperature": 0.5})
    assert outputs == ["好的", "好的"]
    calls = vendor.calls("POST", "/v1/messages")
    assert len(calls) == 2  # Anthropic 没有 n，按条数各发一次
    headers = {name.lower(): value for name, value in calls[0].headers.items()}
    assert headers["x-api-key"] == SECRET
    assert headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in headers
    assert calls[0].json() == {"model": "claude-x", "max_tokens": 300, "temperature": 0.5,
                               "messages": [{"role": "user",
                                             "content": [{"type": "text", "text": "写一句"}]}]}


def test_generate_sends_reference_images_as_base64_blocks(vendor, tmp_path):
    add_claude(vendor.url)
    image = tmp_path / "ref.png"
    image.write_bytes(png_bytes())
    openai_text.generate(prompt="看图", model="claude-x", alias="claude",
                         params={"reference_images": [str(image)]})
    block = vendor.calls("POST", "/v1/messages")[0].json()["messages"][0]["content"][1]
    assert block["type"] == "image" and block["source"]["media_type"] == "image/png"
    assert base64.b64decode(block["source"]["data"]) == png_bytes()


def test_generate_rejects_video_reference_before_sending(vendor, tmp_path):
    add_claude(vendor.url)
    clip = tmp_path / "a.mp4"
    clip.write_bytes(b"\x00" * 16)
    with pytest.raises(openai_text.OpenAITextError, match="不支持视频"):
        openai_text.generate(prompt="看视频", model="claude-x", alias="claude",
                             params={"reference_videos": [str(clip)]})
    assert vendor.calls("POST") == []


def test_structured_call_returns_text_and_cache_inclusive_input_tokens(vendor):
    add_claude(vendor.url)
    key, model = structured_text_call.find_text_model("claude", "claude-x")
    text, tokens_in, tokens_out = structured_text_call.call_model(
        key, model, "系统", "用户", max_output_tokens=500, timeout=(5, 10))
    assert (text, tokens_in, tokens_out) == ("好的", 4096, 503)
    sent = vendor.calls("POST", "/v1/messages")[0].json()
    assert sent["system"] == "系统" and sent["max_tokens"] == 500


def test_wrong_interface_error_tells_user_to_change_it():
    with FakeVendor() as server:
        # OpenAI 官方对不认识的路径的报文；这里模拟「接口」选成 Anthropic 却连到 OpenAI。
        server.on("POST", "/v1/messages", (404, {"error": {
            "message": "Invalid URL (POST /v1/messages)", "type": "invalid_request_error",
            "param": None, "code": None}}))
        add_claude(server.url)
        key, model = structured_text_call.find_text_model("claude", "claude-x")
        with pytest.raises(openai_text.OpenAITextError) as caught:
            structured_text_call.call_model(key, model, "s", "u", max_output_tokens=10,
                                            timeout=(5, 10))
    assert structured_text_call.failure_reason(str(caught.value), caught.value) == SWITCH_INTERFACE
    from character_workflow.lib.job_runner import _friendly_error
    assert _friendly_error(caught.value).startswith(SWITCH_INTERFACE)


# --- 供应商级「接口」：只在写入边界校验，选了就作用到这把 KEY 的文本模型 -----------------

@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


def _custom(text_protocol=None, **extra):
    body = {"alias": "relay", "provider": "custom", "base_url": "https://relay.example/v1",
            "access_key": "k", "modalities": ["image", "llm"],
            "models": [{"id": "claude-x", "name": "Claude", "modality": "text"},
                       {"id": "gpt-image-2", "name": "GPT Image", "modality": "image"}], **extra}
    if text_protocol is not None:
        body["text_protocol"] = text_protocol
    return body


def test_choosing_anthropic_stamps_text_models_only(client):
    assert client.post("/api/keys", json=_custom("anthropic-messages")).status_code == 201
    stored = keys.find_by_alias("relay")
    assert stored.text_protocol == "anthropic-messages"
    assert {m.id: m.protocol for m in stored.models} == {
        "claude-x": "anthropic-messages", "gpt-image-2": None}


def test_auto_leaves_text_protocol_out_of_the_file(client):
    assert client.post("/api/keys", json=_custom()).status_code == 201
    row = json.loads(keys.data_root.keys_file().read_text(encoding="utf-8"))["keys"][0]
    assert "text_protocol" not in row


@pytest.mark.parametrize(("body", "detail"), [
    (_custom("anthropic"), "不认识的接口"),
    ({**_custom("openai-responses"), "provider": "openai"}, "只有自定义供应商"),
])
def test_invalid_interface_is_rejected_at_write(client, body, detail):
    response = client.post("/api/keys", json=body)
    assert response.status_code == 422 and detail in response.json()["detail"]


def test_patch_switches_interface_and_null_means_auto(client):
    client.post("/api/keys", json=_custom())
    assert client.patch("/api/keys/relay", json={"text_protocol": "anthropic-messages"}).status_code == 200
    assert keys.find_by_alias("relay").models[0].protocol == "anthropic-messages"
    # 后来加的文本模型也按已选的接口走。
    models = [m.model_dump() for m in keys.find_by_alias("relay").models]
    models.append({"id": "claude-y", "name": "Y", "modality": "text"})
    client.patch("/api/keys/relay", json={"models": models})
    assert keys.find_by_alias("relay").models[-1].protocol == "anthropic-messages"
    assert client.patch("/api/keys/relay", json={"text_protocol": None}).status_code == 200
    stored = keys.find_by_alias("relay")
    assert stored.text_protocol is None
    assert stored.models[0].protocol == "anthropic-messages"  # 自动 = 各模型保持原样


def test_older_readers_ignore_the_new_fields():
    """ADR-0030：数据格式变化必须能被旧版读取。旧版的 KeySpec / ModelSpec 没有 extra=forbid，
    读到 text_protocol 会忽略；protocol 本来就是自由字符串。"""
    assert keys.KeySpec.model_config.get("extra", "ignore") == "ignore"
    assert keys.ModelSpec.model_config.get("extra", "ignore") == "ignore"
    assert keys.ModelSpec.model_fields["protocol"].annotation == str | None


# --- 前端可调用判据只有后端一份 -------------------------------------------------------

def test_text_unsupported_marker_only_on_uncallable_text_models(client):
    keys.add_key(keys.KeySpec(alias="td", provider="custom", base_url="https://td.example/v1",
                              access_key="k", created_at="t", models=[
        keys.ModelSpec(id="claude", name="c", modality="text", protocol="anthropic-messages"),
        keys.ModelSpec(id="raw", name="r", modality="text", protocol="anthropic:messages"),
        keys.ModelSpec(id="gpt", name="g", modality="text"),
        keys.ModelSpec(id="img", name="i", modality="image", protocol="ark"),
    ]))
    models = {m["id"]: m for m in client.get("/api/keys").json()["keys"][0]["models"]}
    assert models["raw"]["text_unsupported"] is True
    assert all("text_unsupported" not in models[name] for name in ("claude", "gpt", "img"))
    routes = {route["id"]: route for route in client.get("/api/models").json()["models"]}
    assert routes["raw"]["members"][0]["text_unsupported"] is True
    assert "text_unsupported" not in routes["claude"]["members"][0]


# --- 按 Anthropic 鉴权头列模型 ---------------------------------------------------------

def test_models_preview_lists_with_anthropic_headers(client):
    with FakeVendor() as server:
        server.on("GET", "/v1/models", {"data": [
            {"type": "model", "id": "claude-x", "display_name": "Claude X",
             "capabilities": {"image_input": {"supported": True}}},
            {"type": "model", "id": "claude-old", "display_name": "Old"},
        ], "has_more": False, "first_id": "claude-x", "last_id": "claude-old"})
        response = client.post("/api/keys/models-preview", json={
            "provider": "custom", "base_url": server.url, "access_key": SECRET,
            "text_protocol": "anthropic-messages"})
        [call] = server.calls("GET", "/v1/models")
    assert response.status_code == 200, response.text
    headers = {name.lower(): value for name, value in call.headers.items()}
    assert headers["x-api-key"] == SECRET and "authorization" not in headers
    assert call.query == "limit=1000"
    rows = {row["id"]: row for row in response.json()["models"]}
    assert rows["claude-x"]["protocol"] == "anthropic-messages"
    assert rows["claude-x"]["input_modalities"] == ["text", "image"]
    assert rows["claude-old"]["input_modalities"] == []


def test_models_preview_does_not_follow_redirect_to_another_host(client):
    with FakeVendor() as other, FakeVendor() as server:
        other.on("GET", "/v1/models", {"data": []})
        server.on("GET", "/v1/models", (302, {}, {"Location": f"{other.url}/v1/models"}))
        response = client.post("/api/keys/models-preview", json={
            "provider": "custom", "base_url": server.url, "access_key": SECRET,
            "text_protocol": "anthropic-messages"})
        assert other.calls() == []  # 密钥没有被带到别的主机
    assert response.status_code == 502


def test_anthropic_only_annotation_is_classified_as_callable_text():
    from viewer_server.routes import _classify_model, _text_protocol
    item = {"id": "claude-x", "supported_protocols": ["anthropic:messages"]}
    assert _classify_model(item) == "text"
    assert _text_protocol(item) == "anthropic-messages"
    both = {"id": "d", "supported_protocols": ["openai:chat-completions", "anthropic:messages"]}
    assert _text_protocol(both) == "openai-chat"


# --- 局域网网关：接上主机端转换（第 4 批）之前不碰 Anthropic 成员 -------------------------
# 临时边界（ADR-0044）：第 4 批完成后这几条改成断言转换后的行为，不要删。Agent 的边界已在第 2 批改写（见下）。

def _gateway(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"choices": [], "usage": {"prompt_tokens": 1,
                                                                   "completion_tokens": 1}})
    monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    _, token = gateway_keys.create_key("成员")
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    return client, seen


def test_gateway_skips_anthropic_members_and_hides_anthropic_only_routes(monkeypatch):
    # 同名模型：Anthropic 成员排第一；另有一个只有 Anthropic 成员的路由。
    add_claude("https://claude.example", alias="claude", model_id="shared")
    add_claude("https://claude.example", alias="claude-only", model_id="only-claude")
    keys.add_key(keys.KeySpec(alias="relay", provider="custom", base_url="https://relay.example",
                              access_key="r", created_at="t", models=[
        keys.ModelSpec(id="shared", name="shared", modality="text", protocol="openai-chat")]))
    client, seen = _gateway(monkeypatch)
    routes = {route["id"]: route for route in client.get("/gateway/v1/models").json()["models"]}
    assert "only-claude" not in routes
    assert [m["alias"] for m in routes["shared"]["members"]] == ["relay"]
    response = client.post("/gateway/v1/openai/chat/completions",
                           json={"model": "shared", "messages": [{"role": "user", "content": "x"}]})
    assert response.status_code == 200, response.text
    assert [str(request.url) for request in seen] == ["https://relay.example/v1/chat/completions"]


def test_gateway_snapshot_for_members_keeps_old_shape_and_openai_protocol(monkeypatch):
    """旧版成员端把 members[0].protocol 当成自己这条模型的协议（atelier_gateway.gateway_models）：
    混合路由里它必须拿到 OpenAI 格式的成员，成员快照不多不少还是原来那几个字段。"""
    add_claude("https://claude.example", alias="claude", model_id="shared")
    keys.add_key(keys.KeySpec(alias="relay", provider="custom", base_url="https://relay.example",
                              access_key="r", created_at="t", models=[
        keys.ModelSpec(id="shared", name="shared", modality="text", protocol="openai-chat")]))
    client, _ = _gateway(monkeypatch)
    [route] = [r for r in client.get("/gateway/v1/models").json()["models"] if r["id"] == "shared"]
    assert route["members"][0]["protocol"] == "openai-chat"
    assert set(route["members"][0]) == {"alias", "provider", "base_url", "billing_group",
                                        "model_id", "name", "protocol"}
    from character_workflow.lib.callers.atelier_gateway import gateway_models
    [model] = gateway_models([route])
    assert model.protocol == "openai-chat"


def test_agent_model_list_includes_anthropic_models_listed_with_anthropic_headers():
    """第 2 批：Agent 接上协议转换后，Anthropic 模型进列表；按 x-api-key 列模型、不显示思考档位。
    （第 1 批的临时边界用例「列表里不出现」改写而来。）"""
    with FakeVendor() as claude, FakeVendor() as relay:
        claude.on("GET", "/v1/models", {"data": [{"type": "model", "id": "claude-x",
                                                  "display_name": "Claude X"}], "has_more": False})
        relay.on("GET", "/v1/models", {"data": [{"id": "gpt-x"}]})
        add_claude(claude.url)
        keys.add_key(keys.KeySpec(alias="relay", provider="custom", base_url=f"{relay.url}/v1",
                                  access_key="r", created_at="t", models=[
            keys.ModelSpec(id="gpt-x", name="gpt-x", modality="text", protocol="openai-chat")]))
        result = canvas_agent_models.list_chat_models()
        [listed] = claude.calls("GET", "/v1/models")
    rows = {row["model"]: row for row in result["models"]}
    assert set(rows) == {"claude-x", "gpt-x"} and result["errors"] == []
    assert rows["claude-x"]["reasoning"] is False
    headers = {name.lower(): value for name, value in listed.headers.items()}
    assert headers["x-api-key"] == SECRET and "authorization" not in headers
    assert listed.query == "limit=1000"


def test_build_agent_uses_the_protocol_transport_for_anthropic(monkeypatch):
    """第 2 批：直接构造 Agent 时给 Anthropic 模型装上协议转换（第 1 批的临时边界用例「直接构造报错」改写而来）。
    客户端不读环境代理（否则请求会绕过转换），代理由内层按上游地址选。"""
    from types import SimpleNamespace

    from character_workflow.lib import canvas_agent_runtime
    from character_workflow.lib.llm_protocols.transport import ProtocolTransport

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    add_claude("https://claude.example")
    from character_workflow.lib.canvas_projects import create_canvas_project
    project = create_canvas_project("协议")
    agent = canvas_agent_runtime.build_agent(SimpleNamespace(
        project_id=project.project_id, model_alias="claude", model="claude-x", effort=None,
        creation_mode="all"))
    http_client = agent.model._client._client
    assert isinstance(http_client._transport, ProtocolTransport)
    assert http_client._trust_env is False and not http_client._mounts


def test_build_agent_still_refuses_unknown_protocols():
    from types import SimpleNamespace

    from character_workflow.lib import canvas_agent_runtime
    from character_workflow.lib.canvas_tool_common import CanvasToolError

    keys.add_key(keys.KeySpec(alias="td", provider="custom", base_url="https://td.example/v1",
                              access_key="k", created_at="t", models=[
        keys.ModelSpec(id="raw", name="r", modality="text", protocol="anthropic:messages")]))
    with pytest.raises(CanvasToolError) as caught:
        canvas_agent_runtime.build_agent(SimpleNamespace(
            project_id="p", model_alias="td", model="raw", effort=None, creation_mode="all"))
    assert caught.value.message == "该模型的接口暂不支持 Agent"


def test_build_agent_uses_responses_model_for_responses_protocol():
    from types import SimpleNamespace

    from agents import OpenAIResponsesModel

    from character_workflow.lib import canvas_agent_runtime

    keys.add_key(keys.KeySpec(alias="oa", provider="custom", base_url="https://oa.example/v1",
                              access_key="k", created_at="t", models=[
        keys.ModelSpec(id="gpt-r", name="r", modality="text", protocol="openai-responses")]))
    from character_workflow.lib.canvas_projects import create_canvas_project
    project = create_canvas_project("协议")
    agent = canvas_agent_runtime.build_agent(SimpleNamespace(
        project_id=project.project_id, model_alias="oa", model="gpt-r", effort=None,
        creation_mode="all"))
    assert isinstance(agent.model, OpenAIResponsesModel)
