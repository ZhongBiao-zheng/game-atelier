"""Gemini generateContent 协议的端到端行为（ADR-0044 第 5 批）：本机真实套接字的假上游，不发任何真实请求。

覆盖：一次性文本调用、按 x-goog-api-key 列模型（models-preview 与 Agent 列表）且不跟随重定向、
「对话接口」可以选 Gemini、局域网网关在接上主机端转换（第 4 批）之前把 Gemini 成员挡在外面。
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import (
    canvas_agent_models, gateway_keys, gateway_tasks, keys, model_routes, structured_text_call,
)
from character_workflow.lib.callers import openai_text
from tests.fake_http_vendor import FakeVendor
from tests.local_client import LocalTestClient
from viewer_server import gateway_openai
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app

SECRET = "AIza-test-0123456789"
REPLY = {
    "candidates": [{"content": {"role": "model", "parts": [{"text": "好的"}]}, "finishReason": "STOP"}],
    "usageMetadata": {"promptTokenCount": 120, "cachedContentTokenCount": 100,
                      "candidatesTokenCount": 8, "thoughtsTokenCount": 12, "totalTokenCount": 140},
}
PATH = "/v1beta/models/gemini-x:generateContent"


@pytest.fixture(autouse=True)
def _clean(isolated_data_root, monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    model_routes._cooldowns.clear()
    canvas_agent_models._cache.clear()
    yield
    model_routes._cooldowns.clear()
    canvas_agent_models._cache.clear()


def add_gemini(base_url: str, alias: str = "gem", model_id: str = "gemini-x"):
    keys.add_key(keys.KeySpec(
        alias=alias, provider="custom", base_url=base_url, access_key=SECRET,
        models=[keys.ModelSpec(id=model_id, name=model_id, modality="text",
                               protocol="gemini-generate-content", input_modalities=["text", "image"])],
        created_at="2026-11-20T00:00:00Z"))


# --- 一次性文本调用 -------------------------------------------------------------

def test_generate_posts_generate_content_with_the_goog_key_and_loops_for_n():
    with FakeVendor() as vendor:
        vendor.on("POST", PATH, REPLY)
        add_gemini(vendor.url)
        outputs = openai_text.generate(prompt="写一句", model="gemini-x", alias="gem", n=2,
                                       params={"max_tokens": 300, "temperature": 1.3})
        calls = vendor.calls("POST", PATH)
    assert outputs == ["好的", "好的"] and len(calls) == 2
    headers = {name.lower(): value for name, value in calls[0].headers.items()}
    assert headers["x-goog-api-key"] == SECRET and "authorization" not in headers
    assert calls[0].query == ""  # 密钥不进 URL
    assert calls[0].json() == {"contents": [{"role": "user", "parts": [{"text": "写一句"}]}],
                               "generationConfig": {"maxOutputTokens": 300, "temperature": 1.3}}


def test_structured_call_counts_cache_in_input_and_thoughts_in_output():
    with FakeVendor() as vendor:
        vendor.on("POST", PATH, REPLY)
        add_gemini(vendor.url)
        key, model = structured_text_call.find_text_model("gem", "gemini-x")
        text, tokens_in, tokens_out = structured_text_call.call_model(
            key, model, "系统", "用户", max_output_tokens=100, timeout=10)
    assert (text, tokens_in, tokens_out) == ("好的", 120, 20)


def test_blocked_prompt_reports_the_reason():
    with FakeVendor() as vendor:
        vendor.on("POST", PATH, {"promptFeedback": {"blockReason": "SAFETY"}})
        add_gemini(vendor.url)
        with pytest.raises(openai_text.OpenAITextError, match="SAFETY"):
            openai_text.generate(prompt="x", model="gemini-x", alias="gem")


def test_gemini_text_models_are_callable_and_take_images_only():
    assert openai_text.text_callable("custom", "gemini-generate-content")
    assert openai_text.supports_input_modality("custom", "gemini-generate-content", "image")
    assert not openai_text.supports_input_modality("custom", "gemini-generate-content", "video")


# --- 「对话接口」与列模型 ---------------------------------------------------------------

@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


def test_interface_gemini_is_accepted_and_stamped_on_text_models(client):
    response = client.post("/api/keys", json={
        "alias": "relay", "provider": "custom", "base_url": "https://relay.example/v1",
        "access_key": "k", "modalities": ["image", "llm"], "text_protocol": "gemini-generate-content",
        "models": [{"id": "gemini-x", "name": "gemini-x", "modality": "text"},
                   {"id": "img", "name": "img", "modality": "image"}]})
    assert response.status_code == 201, response.text
    stored = keys.find_by_alias("relay")
    assert stored.text_protocol == "gemini-generate-content"
    assert {m.id: m.protocol for m in stored.models}["gemini-x"] == "gemini-generate-content"


def test_models_preview_lists_with_the_goog_key_for_native_and_relay_shapes(client):
    with FakeVendor() as server:
        server.on("GET", "/v1beta/models", {"models": [
            # 官方：带 models/ 前缀，写明支持的方法。
            {"name": "models/gemini-x", "displayName": "Gemini X",
             "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/text-embedding", "supportedGenerationMethods": ["embedContent"]},
            # New API（2026-11-20 对 Tuzi、OpenAI-HK 的免费探针）：没有前缀，方法是空数组。
            {"name": "gemini-relay", "displayName": "gemini-relay", "supportedGenerationMethods": []},
        ], "nextPageToken": ""})
        response = client.post("/api/keys/models-preview", json={
            "provider": "custom", "base_url": server.url, "access_key": SECRET,
            "text_protocol": "gemini-generate-content"})
        [call] = server.calls("GET", "/v1beta/models")
    assert response.status_code == 200, response.text
    headers = {name.lower(): value for name, value in call.headers.items()}
    assert headers["x-goog-api-key"] == SECRET and "authorization" not in headers
    assert call.query == "pageSize=1000"
    rows = {row["id"]: row for row in response.json()["models"]}
    assert set(rows) == {"gemini-x", "gemini-relay"}
    assert rows["gemini-x"]["protocol"] == "gemini-generate-content"
    assert rows["gemini-x"]["name"] == "Gemini X"


def test_models_preview_does_not_follow_redirect_to_another_host(client):
    with FakeVendor() as other, FakeVendor() as server:
        other.on("GET", "/v1beta/models", {"models": []})
        server.on("GET", "/v1beta/models", (302, {}, {"Location": f"{other.url}/v1beta/models"}))
        response = client.post("/api/keys/models-preview", json={
            "provider": "custom", "base_url": server.url, "access_key": SECRET,
            "text_protocol": "gemini-generate-content"})
        assert other.calls() == []
    assert response.status_code == 502


def test_agent_model_list_includes_gemini_models_listed_with_the_goog_key():
    with FakeVendor() as server:
        server.on("GET", "/v1beta/models", {"models": [
            {"name": "gemini-x", "supportedGenerationMethods": []}]})
        add_gemini(server.url)
        result = canvas_agent_models.list_chat_models()
        [listed] = server.calls("GET", "/v1beta/models")
    [row] = result["models"]
    assert (row["model"], row["reasoning"], result["errors"]) == ("gemini-x", False, [])
    headers = {name.lower(): value for name, value in listed.headers.items()}
    assert headers["x-goog-api-key"] == SECRET and "authorization" not in headers


# --- 局域网网关：接上主机端转换（第 4 批）之前不碰 Gemini 成员 ---------------------------
# 临时边界（ADR-0044）：第 4 批完成后改成断言转换后的行为，不要删。

def test_gateway_skips_gemini_members(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"choices": [], "usage": {"prompt_tokens": 1,
                                                                   "completion_tokens": 1}})
    monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    add_gemini("https://gem.example", alias="gem", model_id="shared")
    add_gemini("https://gem.example", alias="gem-only", model_id="only-gemini")
    keys.add_key(keys.KeySpec(alias="relay", provider="custom", base_url="https://relay.example",
                              access_key="r", created_at="t", models=[
        keys.ModelSpec(id="shared", name="shared", modality="text", protocol="openai-chat")]))
    _, token = gateway_keys.create_key("成员")
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    routes = {route["id"]: route for route in client.get("/gateway/v1/models").json()["models"]}
    assert "only-gemini" not in routes
    assert [m["alias"] for m in routes["shared"]["members"]] == ["relay"]
    response = client.post("/gateway/v1/openai/chat/completions",
                           json={"model": "shared", "messages": [{"role": "user", "content": "x"}]})
    assert response.status_code == 200, response.text
    assert [str(request.url) for request in seen] == ["https://relay.example/v1/chat/completions"]


# --- 带自定义鉴权头的一次性调用不跟随跳转（审查第 2 条） ------------------------------------

@pytest.mark.parametrize(("protocol", "path", "model_id"), [
    ("gemini-generate-content", "/v1beta/models/m:generateContent", "m"),
    ("anthropic-messages", "/v1/messages", "m"),
])
def test_one_shot_call_does_not_follow_a_redirect_with_the_key(protocol, path, model_id):
    with FakeVendor() as other, FakeVendor() as server:
        other.on("POST", path, REPLY)
        server.on("POST", path, (307, {}, {"Location": f"{other.url}{path}"}))
        keys.add_key(keys.KeySpec(alias="k", provider="custom", base_url=server.url, access_key=SECRET,
                                  created_at="t", models=[keys.ModelSpec(
                                      id=model_id, name=model_id, modality="text", protocol=protocol)]))
        with pytest.raises(openai_text.OpenAITextError, match="307"):
            openai_text.generate(prompt="x", model=model_id, alias="k")
        assert other.calls() == []  # 第二跳收不到密钥，也收不到请求体
