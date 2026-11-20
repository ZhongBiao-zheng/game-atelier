"""Anthropic Messages ↔ Chat Completions 转换（非流式；流式随 Agent 一起做，见 ADR-0044）。

契约出处：https://platform.claude.com/docs/en/api/messages
- 路径 `{root}/v1/messages`；`max_tokens` 必填；系统提示放顶层 `system`。
- 工具：定义 `{name, description, input_schema}`；调用是 assistant 的 `tool_use` 块，结果是 user 消息里的
  `tool_result` 块（多个结果合进同一条 user 消息）。
- 图片：`{"type": "image", "source": {"type": "base64", ...} | {"type": "url", "url": ...}}`。
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from character_workflow.lib.llm_protocols import ProtocolError
from character_workflow.lib.llm_protocols.usage import from_anthropic, to_chat

ANTHROPIC_VERSION = "2023-06-01"
# 调用方没给上限时的默认值；Anthropic 没有「不限」这个选项。
DEFAULT_MAX_TOKENS = 8192
MAX_TEMPERATURE = 1.0
_SUFFIXES = ("/v1/messages", "/messages", "/v1/models", "/models", "/chat/completions",
             "/responses")
_FINISH = {
    "end_turn": "stop", "stop_sequence": "stop", "pause_turn": "stop",
    "max_tokens": "length", "model_context_window_exceeded": "length",
    "tool_use": "tool_calls", "refusal": "content_filter",
}


def api_root(base_url: str) -> str:
    """以 `/v1` 结尾的根地址：`https://api.anthropic.com` → `…/v1`；
    `https://api.deepseek.com/anthropic` → `…/anthropic/v1`；已带 `/v1` 或端点后缀的照常归一。"""
    parts = urlsplit(base_url.strip())
    path = parts.path.rstrip("/")
    for suffix in _SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)].rstrip("/")
            break
    if not path.endswith("/v1"):
        path += "/v1"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def messages_url(base_url: str) -> str:
    return f"{api_root(base_url)}/messages"


def models_url(base_url: str) -> str:
    return f"{api_root(base_url)}/models"


def headers(base_url: str, access_key: str) -> dict[str, str]:
    """官方与 New API 都认 `x-api-key`；OpenRouter 的 Anthropic 入口文档只写 Bearer。"""
    host = (urlsplit(base_url).hostname or "").lower()
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        auth = {"Authorization": f"Bearer {access_key}"}
    else:
        auth = {"x-api-key": access_key}
    return {**auth, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json"}


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") for part in content
                       if isinstance(part, dict) and part.get("type") in ("text", None))
    return ""


def _image_block(part: dict) -> dict:
    value = part.get("image_url")
    url = value.get("url") if isinstance(value, dict) else value
    if not isinstance(url, str) or not url:
        raise ProtocolError("图片缺少地址")
    if url.startswith("data:"):
        header, _, data = url.partition(",")
        media_type = header[5:].split(";", 1)[0]
        if ";base64" not in header or not media_type or not data:
            raise ProtocolError("图片的 data URL 不是 base64 格式")
        return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
    return {"type": "image", "source": {"type": "url", "url": url}}


def _blocks(content: Any) -> list[dict]:
    if content is None:
        return []
    if isinstance(content, str):
        # Anthropic 拒收空文本块。
        return [{"type": "text", "text": content}] if content else []
    blocks: list[dict] = []
    for part in content:
        kind = part.get("type") if isinstance(part, dict) else None
        if kind == "text":
            if part.get("text"):
                blocks.append({"type": "text", "text": part["text"]})
        elif kind == "image_url":
            blocks.append(_image_block(part))
        elif kind in ("input_audio", "audio_url"):
            raise ProtocolError("Anthropic 接口不支持音频输入")
        elif kind == "video_url":
            raise ProtocolError("Anthropic 接口不支持视频输入")
        else:
            raise ProtocolError(f"Anthropic 接口不支持这种输入：{kind}")
    return blocks


def _append(messages: list[dict], role: str, blocks: list[dict]) -> None:
    """相邻同角色合并：多条 tool 结果必须落在同一条 user 消息里。"""
    if not blocks:
        return
    if messages and messages[-1]["role"] == role:
        messages[-1]["content"].extend(blocks)
    else:
        messages.append({"role": role, "content": list(blocks)})


def _tool_use(call: dict) -> dict:
    function = call.get("function") or {}
    raw = function.get("arguments") or "{}"
    try:
        arguments = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError as error:
        raise ProtocolError("工具调用的参数不是 JSON") from error
    return {"type": "tool_use", "id": call.get("id"), "name": function.get("name"),
            "input": arguments if isinstance(arguments, dict) else {}}


def to_upstream(payload: dict) -> dict:
    """Chat Completions 请求 → Anthropic Messages 请求。"""
    system: list[str] = []
    messages: list[dict] = []
    for message in payload.get("messages") or []:
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "developer"):
            if text := _text_of(content):
                system.append(text)
        elif role == "user":
            _append(messages, "user", _blocks(content))
        elif role == "assistant":
            blocks = _blocks(content)
            blocks.extend(_tool_use(call) for call in message.get("tool_calls") or [])
            _append(messages, "assistant", blocks)
        elif role == "tool":
            _append(messages, "user", [{"type": "tool_result",
                                        "tool_use_id": message.get("tool_call_id"),
                                        "content": _text_of(content)}])
        else:
            raise ProtocolError(f"Anthropic 接口不认识这种消息角色：{role}")
    body: dict[str, Any] = {
        "model": payload["model"],
        "max_tokens": payload.get("max_tokens") or payload.get("max_completion_tokens")
        or DEFAULT_MAX_TOKENS,
        "messages": messages,
    }
    if system:
        body["system"] = "\n\n".join(system)
    # Anthropic 的 temperature 范围是 0–1（OpenAI 是 0–2）：画布「发散」档 1.3 按 Anthropic 的上限 1 发。
    if payload.get("temperature") is not None:
        body["temperature"] = min(float(payload["temperature"]), MAX_TEMPERATURE)
    if payload.get("top_p") is not None:
        body["top_p"] = payload["top_p"]
    if stop := payload.get("stop"):
        body["stop_sequences"] = [stop] if isinstance(stop, str) else list(stop)
    if tools := payload.get("tools"):
        body["tools"] = [{
            "name": tool["function"]["name"],
            "description": tool["function"].get("description") or "",
            "input_schema": tool["function"].get("parameters") or {"type": "object", "properties": {}},
        } for tool in tools if tool.get("type") == "function"]
    # 只映射 auto / none：最新模型对 any / tool 回 400，OpenAI 的 required 与指定函数都不往下传。
    choice = payload.get("tool_choice")
    if choice in ("auto", "none"):
        body["tool_choice"] = {"type": choice}
    if payload.get("parallel_tool_calls") is False and body.get("tools"):
        body.setdefault("tool_choice", {"type": "auto"})["disable_parallel_tool_use"] = True
    if payload.get("stream"):
        body["stream"] = True
    return body


def from_upstream(body: Any) -> dict:
    """Anthropic Messages 非流式响应 → Chat Completions 响应（用量已按含缓存的总输入归一）。"""
    if not isinstance(body, dict):
        raise ProtocolError("Anthropic 接口返回的不是 JSON 对象")
    content = body.get("content") if isinstance(body.get("content"), list) else []
    text = "".join(str(block.get("text") or "") for block in content
                   if isinstance(block, dict) and block.get("type") == "text")
    calls = [{
        "id": block.get("id"), "type": "function",
        "function": {"name": block.get("name"),
                     "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False)},
    } for block in content if isinstance(block, dict) and block.get("type") == "tool_use"]
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        message["tool_calls"] = calls
    result: dict[str, Any] = {
        "id": body.get("id"), "object": "chat.completion", "model": body.get("model"),
        "choices": [{"index": 0, "message": message,
                     "finish_reason": _FINISH.get(body.get("stop_reason"), "stop")}],
    }
    if (usage := from_anthropic(body.get("usage"))) is not None:
        result["usage"] = to_chat(usage)
    return result
