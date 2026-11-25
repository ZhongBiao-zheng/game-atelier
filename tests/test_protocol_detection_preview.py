"""对话接口自动识别接进 models-preview（ADR-0044 第 3 批）：本机套接字假上游，不发真实请求。

只发 GET；密钥只发给用户填的那个 origin；换鉴权头的探测不跟随重定向；`/api/status` 不带密钥。
"""
import pytest

from tests.fake_http_vendor import FakeVendor
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app

SECRET = "sk-detect-0123456789"


@pytest.fixture
def client(isolated_data_root, monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


def _preview(client, base_url, **extra):
    return client.post("/api/keys/models-preview", json={
        "provider": "custom", "base_url": base_url, "access_key": SECRET, **extra})


def _headers(call):
    return {name.lower(): value for name, value in call.headers.items()}


def test_new_api_listing_sets_protocols_per_model_and_shows_the_site_name(client):
    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", {"object": "list", "data": [
            {"id": "claude-x", "object": "model", "owned_by": "x", "supported_endpoint_types": ["anthropic", "openai"]},
            {"id": "claude-only", "object": "model", "supported_endpoint_types": ["anthropic"]},
            {"id": "gpt-resp", "object": "model", "supported_endpoint_types": ["openai-response"]},
            {"id": "gemini-only", "object": "model", "supported_endpoint_types": ["gemini"]},
            {"id": "gemini-both", "object": "model", "supported_endpoint_types": ["OpenAI-Chat", "gemini generateContent"]},
        ]})
        relay.on("GET", "/api/status", {"success": True, "data": {"system_name": "兔子API", "version": "v0.9"}})
        response = _preview(client, relay.url)
        [status] = relay.calls("GET", "/api/status")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["detected"] == {"protocol": "openai-chat", "family": "new-api", "label": "兔子API v0.9"}
    protocols = {row["id"]: row["protocol"] for row in body["models"]}
    assert protocols == {"claude-x": "openai-chat", "claude-only": "anthropic-messages",
                         "gpt-resp": "openai-responses", "gemini-only": "gemini-generate-content",
                         "gemini-both": "openai-chat"}
    assert "authorization" not in _headers(status)  # 公开接口不带密钥


def test_status_that_is_missing_just_leaves_the_label_out(client):
    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", {"data": [{"id": "gpt-x", "supported_endpoint_types": ["openai"]}]})
        response = _preview(client, relay.url)  # /api/status 回 404（OpenAI-HK 就是这样）
    assert response.json()["detected"] == {"protocol": "openai-chat", "family": "new-api", "label": None}


def test_bearer_refused_then_anthropic_headers_on_the_same_origin(client):
    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", (401, {"error": {"message": "invalid bearer"}}))
        response = _preview(client, relay.url)
    # Bearer 401 → 换 x-api-key 再拉同一个 /v1/models，这次还是 401，接着试 Gemini 也失败 → 报第一次的错。
    detail = response.json()["detail"]
    assert response.status_code == 502 and detail["code"] == "invalid_key" and "401" in detail["raw"]

    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", (401, {"error": {"message": "invalid bearer"}}),
                 {"data": [{"type": "model", "id": "claude-x", "display_name": "Claude X"}], "has_more": False})
        response = _preview(client, relay.url)
        bearer, anthropic_call = relay.calls("GET", "/v1/models")
    assert response.status_code == 200, response.text
    assert response.json()["detected"]["protocol"] == "anthropic-messages"
    assert [row["protocol"] for row in response.json()["models"]] == ["anthropic-messages"]
    assert _headers(bearer)["authorization"] == f"Bearer {SECRET}"
    assert _headers(anthropic_call)["x-api-key"] == SECRET and "authorization" not in _headers(anthropic_call)


def test_then_gemini_headers_when_anthropic_also_fails(client):
    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", (404, {"error": "not found"}))
        relay.on("GET", "/v1beta/models", {"models": [{"name": "models/gemini-x", "displayName": "Gemini X",
                                                       "supportedGenerationMethods": ["generateContent"]}]})
        response = _preview(client, relay.url)
        [gem] = relay.calls("GET", "/v1beta/models")
    assert response.status_code == 200, response.text
    assert response.json()["detected"]["family"] == "gemini"
    assert [(row["id"], row["protocol"]) for row in response.json()["models"]] == [
        ("gemini-x", "gemini-generate-content")]
    assert _headers(gem)["x-goog-api-key"] == SECRET and "authorization" not in _headers(gem)
    assert len(relay.calls()) == 3  # Bearer、x-api-key、x-goog-api-key 各一次，没有别的请求


def test_address_rule_lists_with_anthropic_headers_directly(client):
    with FakeVendor() as relay:
        relay.on("GET", "/anthropic/v1/models", {"data": [{"type": "model", "id": "deepseek-x",
                                                           "display_name": "D"}], "has_more": False})
        response = _preview(client, f"{relay.url}/anthropic")
        assert relay.calls("GET", "/v1/models") == []  # 地址已经定下，不先试 Bearer
    assert response.json()["detected"] == {"protocol": "anthropic-messages", "family": "address", "label": None}


def test_explicit_interface_skips_detection(client):
    with FakeVendor() as relay:
        relay.on("GET", "/v1/models", {"data": [{"id": "gpt-x", "supported_endpoint_types": ["openai"]}]})
        response = _preview(client, relay.url, text_protocol="openai-chat")
        assert relay.calls("GET", "/api/status") == []
    assert "detected" not in response.json()


def test_redirect_with_a_json_body_is_not_taken_as_a_listing(client):
    with FakeVendor() as other, FakeVendor() as relay:
        relay.on("GET", "/v1/models", (401, {"error": "bearer"}),
                 (302, {"data": [{"type": "model", "id": "fake", "display_name": "F"}]},
                  {"Location": f"{other.url}/v1/models"}))
        relay.on("GET", "/v1beta/models", (302, {"models": [{"name": "models/fake"}]},
                                           {"Location": f"{other.url}/v1beta/models"}))
        response = _preview(client, relay.url)
        assert other.calls() == []
    assert response.status_code == 502


def test_domestic_chat_presets_connect_directly(monkeypatch):
    """第 3 批的国内对话模型预置（DeepSeek、Kimi、智谱、通义、硅基流动）进直连白名单：本机坏代理不拖死它们。"""
    from requests.utils import should_bypass_proxies

    from character_workflow.lib import net_env

    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.delenv("no_proxy", raising=False)
    net_env.configure_proxy_bypass()
    for host in ("api.deepseek.com", "api.moonshot.cn", "open.bigmodel.cn", "dashscope.aliyuncs.com",
                 "api.siliconflow.cn"):
        assert should_bypass_proxies(f"https://{host}", no_proxy=None), host
