"""Anthropic Messages ↔ Chat Completions 转换（ADR-0044），纯函数部分。"""
import json

import pytest

from character_workflow.lib.llm_protocols import ProtocolError, mismatch_hint
from character_workflow.lib.llm_protocols import SWITCH_INTERFACE, SWITCH_TO_RESPONSES
from character_workflow.lib.llm_protocols import anthropic


@pytest.mark.parametrize(("base_url", "expected"), [
    ("https://api.anthropic.com", "https://api.anthropic.com/v1/messages"),
    ("https://api.anthropic.com/", "https://api.anthropic.com/v1/messages"),
    ("https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"),
    ("https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/messages"),
    ("https://api.tu-zi.com/v1/chat/completions", "https://api.tu-zi.com/v1/messages"),
    ("https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1/messages"),
    ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/messages"),
])
def test_messages_url(base_url, expected):
    assert anthropic.messages_url(base_url) == expected


def test_headers_use_x_api_key_except_openrouter():
    official = anthropic.headers("https://api.anthropic.com", "k")
    assert official["x-api-key"] == "k" and "Authorization" not in official
    assert official["anthropic-version"] == "2023-06-01"
    openrouter = anthropic.headers("https://openrouter.ai/api/v1", "k")
    assert openrouter["Authorization"] == "Bearer k" and "x-api-key" not in openrouter


def test_to_upstream_moves_system_and_requires_max_tokens():
    body = anthropic.to_upstream({"model": "claude-x", "messages": [
        {"role": "system", "content": "规则一"},
        {"role": "developer", "content": [{"type": "text", "text": "规则二"}]},
        {"role": "user", "content": "你好"},
    ]})
    assert body == {"model": "claude-x", "max_tokens": anthropic.DEFAULT_MAX_TOKENS,
                    "system": "规则一\n\n规则二",
                    "messages": [{"role": "user", "content": [{"type": "text", "text": "你好"}]}]}


def test_to_upstream_keeps_caller_max_tokens_and_sampling():
    body = anthropic.to_upstream({"model": "m", "max_tokens": 300, "temperature": 0.2,
                                  "stop": "END", "messages": [{"role": "user", "content": "x"}]})
    assert body["max_tokens"] == 300 and body["temperature"] == 0.2
    assert body["stop_sequences"] == ["END"]


def test_temperature_above_anthropic_range_is_capped():
    """Anthropic 只收 0–1；画布「发散」档是 1.3（OpenAI 的 0–2 刻度）。"""
    body = anthropic.to_upstream({"model": "m", "temperature": 1.3,
                                  "messages": [{"role": "user", "content": "x"}]})
    assert body["temperature"] == 1.0


def test_images_become_base64_or_url_sources():
    body = anthropic.to_upstream({"model": "m", "messages": [{"role": "user", "content": [
        {"type": "text", "text": "看图"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
        {"type": "image_url", "image_url": {"url": "https://example.com/a.jpg"}},
    ]}]})
    assert body["messages"][0]["content"][1:] == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}},
        {"type": "image", "source": {"type": "url", "url": "https://example.com/a.jpg"}},
    ]


@pytest.mark.parametrize("part", [
    {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,AA=="}},
    {"type": "input_audio", "input_audio": {"data": "AA==", "format": "mp3"}},
])
def test_video_and_audio_inputs_are_rejected(part):
    with pytest.raises(ProtocolError):
        anthropic.to_upstream({"model": "m", "messages": [{"role": "user", "content": [part]}]})


def test_tool_calls_and_results_map_and_consecutive_results_merge():
    body = anthropic.to_upstream({"model": "m", "messages": [
        {"role": "user", "content": "查两个"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "a", "arguments": '{"x": 1}'}},
            {"id": "call_2", "type": "function", "function": {"name": "b", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": "一"},
        {"role": "tool", "tool_call_id": "call_2", "content": "二"},
    ], "tools": [{"type": "function", "function": {
        "name": "a", "description": "工具 a", "parameters": {"type": "object", "properties": {}},
    }}], "tool_choice": "auto", "parallel_tool_calls": False})
    assert body["messages"][1] == {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_1", "name": "a", "input": {"x": 1}},
        {"type": "tool_use", "id": "call_2", "name": "b", "input": {}},
    ]}
    assert body["messages"][2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_1", "content": "一"},
        {"type": "tool_result", "tool_use_id": "call_2", "content": "二"},
    ]}
    assert body["tools"] == [{"name": "a", "description": "工具 a",
                              "input_schema": {"type": "object", "properties": {}}}]
    assert body["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}


def test_required_tool_choice_is_not_forwarded():
    """最新 Claude 模型对 tool_choice any / tool 回 400，OpenAI 的 required 不往下传。"""
    body = anthropic.to_upstream({"model": "m", "messages": [{"role": "user", "content": "x"}],
                                  "tools": [], "tool_choice": "required"})
    assert "tool_choice" not in body


def test_from_upstream_text_tool_use_finish_reason_and_usage():
    # 结构按 https://platform.claude.com/docs/en/api/messages 的响应字段；tool_use 块取自文档样例。
    chat = anthropic.from_upstream({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
        "content": [
            {"type": "text", "text": "我来查"},
            {"type": "tool_use", "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV", "name": "get_stock_price",
             "input": {"ticker": "^GSPC"}},
        ],
        "stop_reason": "tool_use", "stop_sequence": None,
        "usage": {"input_tokens": 2048, "cache_read_input_tokens": 1800,
                  "cache_creation_input_tokens": 248, "output_tokens": 503},
    })
    choice = chat["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    assert choice["message"]["content"] == "我来查"
    call = choice["message"]["tool_calls"][0]
    assert call["id"] == "toolu_01D7FLrfh4GYq7yT1ULFeyMV"
    assert json.loads(call["function"]["arguments"]) == {"ticker": "^GSPC"}
    assert chat["usage"]["prompt_tokens"] == 4096
    assert chat["usage"]["prompt_tokens_details"] == {"cached_tokens": 1800, "cache_write_tokens": 248}
    assert chat["usage"]["completion_tokens"] == 503


@pytest.mark.parametrize(("stop", "finish"), [
    ("end_turn", "stop"), ("max_tokens", "length"), ("refusal", "content_filter"), (None, "stop"),
])
def test_finish_reason_mapping(stop, finish):
    chat = anthropic.from_upstream({"content": [{"type": "text", "text": "x"}], "stop_reason": stop})
    assert chat["choices"][0]["finish_reason"] == finish


# 「接口选错了」的典型报文 → 让用户去改「接口」（不自动换协议重试，ADR-0044）。
@pytest.mark.parametrize(("raw", "hint"), [
    # OpenAI 官方：按 Anthropic 发到 /v1/messages
    ('text api 404: {"error":{"message":"Invalid URL (POST /v1/messages)",'
     '"type":"invalid_request_error","param":null,"code":null}}', SWITCH_INTERFACE),
    # One API 等 Gin 服务：没有 /v1/responses 或 /v1/messages 路由
    ("text api 404: 404 page not found", SWITCH_INTERFACE),
    # New API：这条渠道转不了这种格式
    ('text api 500: {"error":{"message":"convert_request_failed","type":"new_api_error"}}',
     SWITCH_INTERFACE),
    # 只能用 Responses 的模型被按 Chat 调
    ('text api 404: {"error":{"message":"This model is only supported in v1/responses and not in '
     'v1/chat/completions.","type":"invalid_request_error"}}', SWITCH_TO_RESPONSES),
])
def test_mismatch_hint_for_wrong_interface(raw, hint):
    assert mismatch_hint(raw) == hint


@pytest.mark.parametrize("raw", [
    'text api 401: {"error":{"message":"Incorrect API key provided"}}',
    'text api 404: {"error":{"message":"The model `gpt-x` does not exist","code":"model_not_found"}}',
    "text api 429: rate limit",
])
def test_mismatch_hint_ignores_other_errors(raw):
    assert mismatch_hint(raw) is None
