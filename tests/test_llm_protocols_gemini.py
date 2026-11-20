"""Gemini generateContent 转换（ADR-0044 第 5 批）：地址与鉴权、请求与响应、签名规则、流式、出口去签名。

契约出处：aistudio.google.com/api-reference/generate-content.md、docs/function-calling.md、
docs/thought-signatures.md（generate-content 版）。官方文档没有带 functionCall 的 REST 响应原文，
下面的响应按 API 参考里的字段定义构造。
"""
from __future__ import annotations

import json
import logging
import re

import pytest

from character_workflow.lib.llm_protocols import ProtocolError, gemini

CALL_ID = re.compile(r"^g[snx][ur]_[A-Za-z0-9_-]{1,36}$")
OPENAI_CHAT_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


# ── 地址与鉴权 ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("base_url", "root"), [
    ("https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"),
    ("https://generativelanguage.googleapis.com/v1beta/openai/",
     "https://generativelanguage.googleapis.com/v1beta"),
    ("https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta"),
    ("https://api.tu-zi.com", "https://api.tu-zi.com/v1beta"),
    ("https://api.tu-zi.com/v1", "https://api.tu-zi.com/v1beta"),
    ("https://relay.example/proxy/v1", "https://relay.example/proxy/v1beta"),
])
def test_api_root_accepts_native_openai_compatible_and_relay_addresses(base_url, root):
    assert gemini.api_root(base_url) == root


def test_urls_put_the_model_in_the_path_and_never_the_key():
    assert gemini.generate_url("https://x.example", "models/gemini-3-flash") == \
        "https://x.example/v1beta/models/gemini-3-flash:generateContent"
    assert gemini.generate_url("https://x.example", "gemini-3-flash", stream=True) == \
        "https://x.example/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse"
    assert gemini.headers("k") == {"x-goog-api-key": "k", "Content-Type": "application/json"}


# ── 请求 ────────────────────────────────────────────────────────────────────────────

def _assistant_call(call_id: str, name: str = "get_canvas", signature: str | None = None) -> dict:
    call = {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}
    return gemini.with_signature(call, signature) if signature else call


def test_to_upstream_maps_system_roles_tools_and_config():
    body = gemini.to_upstream({
        "model": "gemini-3-flash",
        "messages": [
            {"role": "system", "content": "规则"},
            {"role": "user", "content": [
                {"type": "text", "text": "看图"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
            {"role": "assistant", "content": "好的"},
            {"role": "user", "content": "继续"},
        ],
        "tools": [{"type": "function", "function": {
            "name": "get_canvas", "description": "读画布",
            "parameters": {"type": "object", "properties": {"node_ids": {"type": "array"}},
                           "additionalProperties": False}}}],
        "tool_choice": "required", "max_tokens": 100, "temperature": 1.3, "top_p": 0.9,
        "stop": "END", "response_format": {"type": "json_object"},
    })
    assert body["systemInstruction"] == {"parts": [{"text": "规则"}]}
    assert [c["role"] for c in body["contents"]] == ["user", "model", "user"]
    assert body["contents"][0]["parts"][1] == {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}
    declaration = body["tools"][0]["functionDeclarations"][0]
    assert declaration["parametersJsonSchema"]["additionalProperties"] is False  # JSON Schema 原样
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "ANY"}}
    assert body["generationConfig"] == {"maxOutputTokens": 100, "temperature": 1.3, "topP": 0.9,
                                        "stopSequences": ["END"],
                                        "responseMimeType": "application/json"}
    assert "model" not in body


def test_image_urls_and_video_are_refused_before_sending():
    with pytest.raises(ProtocolError, match="base64"):
        gemini.to_upstream({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://x.example/a.png"}}]}]})
    with pytest.raises(ProtocolError, match="视频"):
        gemini.to_upstream({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,AA"}}]}]})


def test_parallel_results_share_one_user_content_and_carry_names_and_upstream_ids():
    body = gemini.to_upstream({"model": "gemini-3-flash", "messages": [
        {"role": "user", "content": "两件事"},
        {"role": "assistant", "content": None, "tool_calls": [
            _assistant_call("gsu_call-abc", "a", "SIG"), _assistant_call("gnr_" + "0" * 24, "b")]},
        {"role": "tool", "tool_call_id": "gsu_call-abc", "content": '{"ok": true}'},
        {"role": "tool", "tool_call_id": "gnr_" + "0" * 24, "content": "纯文本"},
    ]})
    model, results = body["contents"][1], body["contents"][2]
    assert model["parts"][0] == {"functionCall": {"name": "a", "args": {}, "id": "call-abc"},
                                 "thoughtSignature": "SIG"}
    assert "thoughtSignature" not in model["parts"][1] and "id" not in model["parts"][1]["functionCall"]
    assert results["role"] == "user" and results["parts"] == [
        {"functionResponse": {"name": "a", "response": {"ok": True}, "id": "call-abc"}},
        {"functionResponse": {"name": "b", "response": {"result": "纯文本"}}},
    ]


# ── 签名规则（P5-points「签名与 tool_call id 的设计」） ─────────────────────────────

def _first_part(model: str, call: dict, *, current_turn: bool = True) -> dict:
    messages = [{"role": "user", "content": "旧的一轮"}]
    if current_turn:
        messages += [{"role": "assistant", "content": "旧回答"}, {"role": "user", "content": "这一轮"}]
    messages += [{"role": "assistant", "content": None, "tool_calls": [call]},
                 {"role": "tool", "tool_call_id": call["id"], "content": "结果"}]
    if not current_turn:
        messages += [{"role": "assistant", "content": "好"}, {"role": "user", "content": "下一轮"}]
    body = gemini.to_upstream({"model": model, "messages": messages})
    return next(part for content in body["contents"] for part in content["parts"]
                if "functionCall" in part)


def test_signature_comes_back_on_the_first_function_call():
    part = _first_part("gemini-3-flash", _assistant_call("gsr_" + "a" * 24, signature="SIG"))
    assert part["thoughtSignature"] == "SIG"


def test_missing_signature_on_a_gemini_call_with_a_gemini_name_is_an_error():
    """openai-agents 对 gemini 名字的模型一定回放签名：缺了说明转换或会话坏了，报错不掩盖。"""
    with pytest.raises(ProtocolError, match="签名丢失"):
        _first_part("gemini-3-flash", _assistant_call("gsr_" + "a" * 24))


@pytest.mark.parametrize(("model", "call_id"), [
    ("relay-pro", "gsr_" + "a" * 24),          # 模型名不含 gemini：SDK 不回放
    ("gemini-3-flash", "gxr_" + "a" * 24),     # 签名超过上限没进会话
    ("gemini-3-flash", "call_abc123"),         # 别的模型产生的调用（等确认时换成 Gemini）
    ("gemini-3-flash", "toolu_01abc"),
])
def test_placeholder_only_for_the_three_documented_cases(model, call_id):
    part = _first_part(model, _assistant_call(call_id))
    assert part["thoughtSignature"] == gemini.PLACEHOLDER_SIGNATURE == "skip_thought_signature_validator"


def test_calls_gemini_gave_no_signature_stay_without_one():
    part = _first_part("gemini-3-flash", _assistant_call("gnr_" + "a" * 24))
    assert "thoughtSignature" not in part


@pytest.mark.parametrize("call_id", ["gsr_" + "a" * 24, "call_abc123", "gxr_" + "a" * 24])
def test_earlier_turns_are_never_filled_or_refused(call_id):
    """官方只校验当前轮：更早轮次缺签名不填占位值，也不报错。"""
    part = _first_part("gemini-3-flash", _assistant_call(call_id), current_turn=False)
    assert "thoughtSignature" not in part


# ── 响应 ────────────────────────────────────────────────────────────────────────────

USAGE = {"promptTokenCount": 1000, "cachedContentTokenCount": 400, "toolUsePromptTokenCount": 50,
         "candidatesTokenCount": 30, "thoughtsTokenCount": 70, "totalTokenCount": 1150}


def test_from_upstream_text_finish_and_usage():
    result = gemini.from_upstream({
        "candidates": [{"content": {"role": "model", "parts": [
            {"text": "想一想", "thought": True}, {"text": "答案"}]}, "finishReason": "MAX_TOKENS"}],
        "usageMetadata": USAGE, "modelVersion": "gemini-3-flash", "responseId": "r1"}, "gemini-3-flash")
    assert result["choices"][0] == {"index": 0, "message": {"role": "assistant", "content": "答案"},
                                    "finish_reason": "length"}
    usage = result["usage"]
    assert usage["prompt_tokens"] == 1050 and usage["prompt_tokens_details"]["cached_tokens"] == 400
    assert usage["completion_tokens"] == 100
    assert usage["prompt_tokens"] + usage["completion_tokens"] == USAGE["totalTokenCount"]


def test_function_calls_get_short_ids_and_only_the_first_carries_the_signature():
    result = gemini.from_upstream({"candidates": [{"content": {"parts": [
        {"functionCall": {"name": "a", "args": {"x": 1}}, "thoughtSignature": "SIG"},
        {"functionCall": {"name": "b", "args": {}, "id": "call-from-gemini"}},
    ]}, "finishReason": "STOP"}]})
    first, second = result["choices"][0]["message"]["tool_calls"]
    assert result["choices"][0]["finish_reason"] == "tool_calls"
    for call in (first, second):
        assert CALL_ID.match(call["id"]) and OPENAI_CHAT_ID.match(call["id"])
        assert "index" not in call
    assert first["id"].startswith("gsr_") and gemini.signature_of(first) == "SIG"
    assert second["id"] == "gnu_call-from-gemini" and gemini.signature_of(second) is None
    assert json.loads(first["function"]["arguments"]) == {"x": 1}


def test_signature_on_a_later_empty_text_part_belongs_to_the_first_call():
    result = gemini.from_upstream({"candidates": [{"content": {"parts": [
        {"functionCall": {"name": "a", "args": {}}}, {"text": "", "thought_signature": "LATE"},
    ]}, "finishReason": "STOP"}]})
    assert gemini.signature_of(result["choices"][0]["message"]["tool_calls"][0]) == "LATE"


def test_oversized_signature_is_not_kept_and_the_log_has_no_signature(caplog):
    huge = "S" * (gemini.MAX_SIGNATURE_CHARS + 1)
    with caplog.at_level(logging.WARNING, logger=gemini.__name__):
        result = gemini.from_upstream({"candidates": [{"content": {"parts": [
            {"functionCall": {"name": "a", "args": {}}, "thoughtSignature": huge}]},
            "finishReason": "STOP"}]})
    call = result["choices"][0]["message"]["tool_calls"][0]
    assert call["id"].startswith("gxr_") and "extra_content" not in call
    assert "over limit" in caplog.text and "SSSS" not in caplog.text


def test_blocked_prompt_is_an_error_with_the_reason():
    with pytest.raises(ProtocolError, match="SAFETY"):
        gemini.from_upstream({"promptFeedback": {"blockReason": "SAFETY"}})


# ── 流式 ────────────────────────────────────────────────────────────────────────────

def _sse(*events: dict) -> bytes:
    return b"".join(b"data: " + json.dumps(e).encode() + b"\r\n\r\n" for e in events)


def _blocks(data: bytes) -> list:
    out = []
    for line in data.decode().splitlines():
        if line.startswith("data: "):
            out.append("[DONE]" if line == "data: [DONE]" else json.loads(line[6:]))
    return out


def test_stream_text_deltas_then_usage_and_done():
    translator = gemini.StreamTranslator(model="gemini-3-flash")
    data = translator.feed(_sse(
        {"candidates": [{"content": {"parts": [{"text": "你"}]}}], "responseId": "r"},
        {"candidates": [{"content": {"parts": [{"text": "好"}]}, "finishReason": "STOP"}],
         "usageMetadata": USAGE})) + translator.finish()
    blocks = _blocks(data)
    text = "".join(b["choices"][0]["delta"].get("content") or "" for b in blocks
                   if isinstance(b, dict) and b.get("choices"))
    assert text == "你好"
    assert [b["choices"][0]["finish_reason"] for b in blocks
            if isinstance(b, dict) and b.get("choices") and b["choices"][0]["finish_reason"]] == ["stop"]
    assert blocks[-2]["usage"]["completion_tokens"] == 100 and blocks[-1] == "[DONE]"


def test_stream_holds_tool_calls_until_finish_so_a_late_signature_is_kept():
    translator = gemini.StreamTranslator(model="gemini-3-flash")
    early = translator.feed(_sse({"candidates": [{"content": {"parts": [
        {"functionCall": {"name": "get_canvas", "args": {}}}]}}]}))
    assert "tool_calls" not in early.decode()
    late = translator.feed(_sse({"candidates": [{"content": {"parts": [
        {"text": "", "thoughtSignature": "LATE"}]}, "finishReason": "STOP"}]}))
    [calls] = [b["choices"][0]["delta"]["tool_calls"] for b in _blocks(late)
               if b["choices"] and "tool_calls" in b["choices"][0]["delta"]]
    assert calls[0]["index"] == 0 and gemini.signature_of(calls[0]) == "LATE"
    assert _blocks(late)[-1]["choices"][0]["finish_reason"] == "tool_calls"


def test_stream_cut_before_finish_reason_is_an_error():
    translator = gemini.StreamTranslator(model="m")
    translator.feed(_sse({"candidates": [{"content": {"parts": [{"text": "半"}]}}]}))
    [block] = _blocks(translator.finish())
    assert block["error"]["type"] == "incomplete_stream"


def test_stream_error_chunk_becomes_an_error_block():
    translator = gemini.StreamTranslator(model="m")
    [block] = _blocks(translator.feed(_sse({"error": {
        "code": 429, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}})))
    assert block == {"error": {"message": "Resource exhausted", "type": "RESOURCE_EXHAUSTED"}}
    assert translator.finish() == b""


# ── 出口去签名 ─────────────────────────────────────────────────────────────────────

def test_drop_signatures_keeps_everything_else():
    items = [
        {"type": "function_call", "call_id": "gsr_x", "name": "a", "arguments": "{}",
         "provider_data": {"thought_signature": "SIG"}},
        {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}",
         "provider_data": {"thought_signature": "SIG", "other": 1}},
        {"type": "message", "role": "user", "content": "hi"},
    ]
    assert gemini.drop_signatures(items) == [
        {"type": "function_call", "call_id": "gsr_x", "name": "a", "arguments": "{}"},
        {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}",
         "provider_data": {"other": 1}},
        {"type": "message", "role": "user", "content": "hi"},
    ]
    assert items[0]["provider_data"] == {"thought_signature": "SIG"}  # 不改原对象


# ── 审查补的用例（2026-11-20） ─────────────────────────────────────────────────────

def test_results_are_sent_in_call_order_and_a_missing_one_is_refused():
    calls = [_assistant_call(f"gnr_{c * 24}", "run") for c in "abc"]
    messages = [{"role": "user", "content": "go"},
                {"role": "assistant", "content": None, "tool_calls": calls},
                {"role": "tool", "tool_call_id": calls[0]["id"], "content": "r1"},
                {"role": "tool", "tool_call_id": calls[2]["id"], "content": "r3"},
                {"role": "tool", "tool_call_id": calls[1]["id"], "content": "r2"}]
    body = gemini.to_upstream({"model": "gemini-3-flash", "messages": messages})
    assert [p["functionResponse"]["response"]["result"] for p in body["contents"][2]["parts"]] == [
        "r1", "r2", "r3"]
    with pytest.raises(ProtocolError, match="缺少结果"):
        gemini.to_upstream({"model": "gemini-3-flash", "messages": messages[:3]})
    with pytest.raises(ProtocolError, match="缺少结果"):
        gemini.to_upstream({"model": "gemini-3-flash",
                            "messages": [*messages[:3], {"role": "user", "content": "继续"}]})


@pytest.mark.parametrize("reason", ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER",
                                    "LANGUAGE", "MISSING_THOUGHT_SIGNATURE", "SAFETY", "MAX_TOKENS"])
def test_non_stop_finish_without_content_is_an_error_with_the_finish_message(reason):
    candidate = {"finishReason": reason, "finishMessage": "Malformed function call: print("}
    with pytest.raises(ProtocolError, match=f"{reason}.*Malformed function call"):
        gemini.from_upstream({"candidates": [candidate]})
    translator = gemini.StreamTranslator(model="m")
    [first, error] = _blocks(translator.feed(_sse({"candidates": [candidate]})))
    assert reason in error["error"]["message"] and "Malformed" in error["error"]["message"]
    assert translator.finish() == b""


def test_upstream_error_inside_http_200_keeps_the_original_text():
    with pytest.raises(ProtocolError, match="insufficient balance"):
        gemini.from_upstream({"error": {"message": "insufficient balance", "type": "quota"}})
    translator = gemini.StreamTranslator(model="m")
    assert translator.feed(b'{"error": {"message": "insufficient balance",\n "type": "quota"}}') == b""
    [block] = _blocks(translator.finish())
    assert "insufficient balance" in block["error"]["message"]


def test_last_data_line_without_a_newline_is_not_lost():
    translator = gemini.StreamTranslator(model="m")
    event = {"candidates": [{"content": {"parts": [{"text": "完"}]}, "finishReason": "STOP"}]}
    translator.feed(b"data: " + json.dumps(event).encode())  # 没有换行结尾
    blocks = _blocks(translator.finish())
    assert blocks[-1] == "[DONE]" and not any(isinstance(b, dict) and "error" in b for b in blocks)
    assert "完" in json.dumps(blocks, ensure_ascii=False)


def test_text_after_a_call_is_shown_and_keeps_its_own_signature():
    translator = gemini.StreamTranslator(model="m")
    data = translator.feed(_sse({"candidates": [{"content": {"parts": [
        {"functionCall": {"name": "a", "args": {}}},
        {"text": "我先看看", "thoughtSignature": "TEXT-SIG"}]}, "finishReason": "STOP"}]}))
    blocks = [b for b in _blocks(data) if isinstance(b, dict) and b.get("choices")]
    assert "我先看看" in "".join(b["choices"][0]["delta"].get("content") or "" for b in blocks)
    [calls] = [b["choices"][0]["delta"]["tool_calls"] for b in blocks if "tool_calls" in b["choices"][0]["delta"]]
    assert gemini.signature_of(calls[0]) is None and calls[0]["id"].startswith("gn")


def test_tool_choice_object_and_endpoint_suffixes():
    tools = [{"type": "function", "function": {"name": "a", "parameters": {"type": "object"}}}]
    body = gemini.to_upstream({"model": "m", "messages": [{"role": "user", "content": "x"}], "tools": tools,
                               "tool_choice": {"type": "function", "function": {"name": "a"}}})
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["a"]}}
    odd = gemini.to_upstream({"model": "m", "messages": [{"role": "user", "content": "x"}], "tools": tools,
                              "tool_choice": {"type": "allowed_tools"}})
    assert "toolConfig" not in odd
    assert gemini.api_root("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions") == \
        "https://generativelanguage.googleapis.com/v1beta"
    assert gemini.api_root("https://relay.example/v1/models") == "https://relay.example/v1beta"


def test_exported_ids_say_the_signature_was_not_kept_so_the_turn_uses_the_placeholder():
    session = {"history": [{"type": "function_call", "call_id": "gsr_" + "a" * 24},
                           {"type": "function_call_output", "call_id": "gsr_" + "a" * 24}],
               "pending_approvals": [{"call_id": "gsu_fc-1"}], "other": "gsr_not-a-call id"}
    marked = gemini.mark_signatures_dropped(session)
    assert marked["history"][0]["call_id"] == marked["history"][1]["call_id"] == "gxr_" + "a" * 24
    assert marked["pending_approvals"][0]["call_id"] == "gxu_fc-1"
    assert marked["other"] == "gsr_not-a-call id"  # 只改整串是 id 的
    part = _first_part("gemini-3-flash", _assistant_call(marked["history"][0]["call_id"]))
    assert part["thoughtSignature"] == gemini.PLACEHOLDER_SIGNATURE
