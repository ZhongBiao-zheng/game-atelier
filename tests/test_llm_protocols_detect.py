"""对话接口自动识别的纯函数（ADR-0044 第 3 批）。

夹具的字段名与取值来自 2026-11-20 的免费探针（RESEARCH-contracts 第 5 节、P5-points「免费探针结果」）：
OpenAI-HK 条目 `created, id, object, owned_by, supported_endpoint_types`；Tuzi 多一个 `category`，
取值含 `OpenAI-Chat`、`gemini generateContent`、`flux chat模式` 等自定义值；New API 模拟的 Gemini 列表
`name` 不带 `models/`、`supportedGenerationMethods` 为空数组。
"""
from __future__ import annotations

import pytest

from character_workflow.lib.llm_protocols import detect

CHAT, RESP, ANTH, GEM = "openai-chat", "openai-responses", "anthropic-messages", "gemini-generate-content"


@pytest.mark.parametrize(("url", "protocol"), [
    ("https://api.anthropic.com", ANTH),
    ("https://api.deepseek.com/anthropic", ANTH),
    ("https://relay.example/v1/messages", ANTH),
    ("https://generativelanguage.googleapis.com", GEM),
    ("https://generativelanguage.googleapis.com/v1beta/openai/", CHAT),
    ("https://relay.example/v1beta/models/gemini-x:generateContent", GEM),
    ("https://api.openai.com/v1", CHAT),
    ("https://openrouter.ai/api/v1", CHAT),
    ("https://relay.example/v1/chat/completions", CHAT),
    ("https://relay.example/v1/responses", RESP),
    ("https://api.tu-zi.com", None),          # New API 站点：只看地址定不下，要看列表
    ("https://api.openai-hk.com/v1", None),
])
def test_address_rules(url, protocol):
    assert detect.from_address(url) == protocol


@pytest.mark.parametrize(("types", "protocol"), [
    (["anthropic", "openai"], CHAT),                       # OpenAI-HK 的 Claude：两种都有取 Chat
    (["anthropic"], ANTH),
    (["openai-response"], RESP),
    (["openai", "openai-response"], CHAT),
    (["gemini"], GEM),                                     # 只有 gemini：经中转工具调用未验证（P5 实测）
    (["OpenAI-Chat", "gemini generateContent"], CHAT),     # Tuzi 的 gemini-3-flash-preview：大小写不敏感
    (["gemini generateContent"], GEM),
    (["image-generation"], None),
    (["flux chat模式", "veo3异步openai官方接口"], None),     # 不认识的自定义值不猜
    ([], None),
    (None, None),
])
def test_new_api_endpoint_types(types, protocol):
    assert detect.endpoint_protocol(types) == protocol


@pytest.mark.parametrize(("body", "family"), [
    ({"object": "list", "data": [{"id": "gpt-x", "object": "model", "created": 1, "owned_by": "openai",
                                  "supported_endpoint_types": ["openai"]}]}, "new-api"),
    ({"object": "list", "data": [{"id": "x", "category": "chat",
                                  "supported_endpoint_types": ["OpenAI-Chat"]}]}, "new-api"),
    ({"data": [{"type": "model", "id": "claude-x", "display_name": "Claude X"}], "has_more": False}, "anthropic"),
    ({"models": [{"name": "models/gemini-x", "supportedGenerationMethods": ["generateContent"]}]}, "gemini"),
    ({"models": [{"name": "gemini-x", "supportedGenerationMethods": []}], "nextPageToken": ""}, "gemini"),
    ({"data": [{"id": "openai/gpt-x", "architecture": {"output_modalities": ["text"]}}]}, "openrouter"),
    ({"object": "list", "data": [{"id": "deepseek-chat", "object": "model"}]}, "openai"),
    ({"object": "list", "data": []}, "openai"),
    ({"error": {"message": "invalid key"}}, None),
    ([], None),
    ("<html>", None),
])
def test_listing_family(body, family):
    assert detect.listing_family(body) == family


def test_family_default_protocols():
    assert detect.family_protocol("anthropic") == ANTH
    assert detect.family_protocol("gemini") == GEM
    assert detect.family_protocol("new-api") == CHAT
    assert detect.family_protocol(None) is None
