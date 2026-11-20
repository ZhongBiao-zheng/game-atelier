"""对话接口的自动识别（ADR-0044 第 3 批）：纯函数，不发请求。

发请求的是 models-preview（只发 GET、密钥只发给用户填的那个 host、不跟随重定向）；这里只看地址与
返回形状下结论，方便每种形状一个夹具。

- 地址规则：端点后缀、官方域名。命中就直接定结论。
- 列表形状：New API 的 `supported_endpoint_types`（逐模型定协议）、Anthropic 形状、Gemini 形状、普通 OpenAI 列表。
- New API 的取值大小写不敏感、只认已知值（Tuzi 实测有 28 种，含中文自定义值，不认识的不猜）。
  同时有 OpenAI 格式与别的格式时取 OpenAI Chat：转换最少，且 2026-11-20 实测 Tuzi 的 Gemini 格式入口
  工具调用不生效（provider-protocols-P5-points「实测取证」）。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from character_workflow.lib.llm_protocols import (
    ANTHROPIC_MESSAGES, GEMINI_GENERATE_CONTENT, OPENAI_CHAT, OPENAI_RESPONSES,
)

GOOGLE_HOST = "generativelanguage.googleapis.com"

# New API 的 supported_endpoint_types → 对话协议（小写比对）。其余取值不参与对话协议判断。
_ENDPOINT_TYPES = {
    "openai": OPENAI_CHAT, "openai-chat": OPENAI_CHAT,
    "openai-response": OPENAI_RESPONSES,
    "anthropic": ANTHROPIC_MESSAGES,
    "gemini": GEMINI_GENERATE_CONTENT, "gemini generatecontent": GEMINI_GENERATE_CONTENT,
}
# 一个模型声明了多种格式时的取舍：OpenAI Chat 优先（转换最少），其次 Anthropic（P2 实测经中转可用），
# 再次 Responses，最后 Gemini（经中转的工具调用未验证）。
_PREFERENCE = (OPENAI_CHAT, ANTHROPIC_MESSAGES, OPENAI_RESPONSES, GEMINI_GENERATE_CONTENT)


def from_address(base_url: str) -> str | None:
    """只看地址能定下的协议；定不下返回 None。"""
    parts = urlsplit((base_url or "").strip())
    host = (parts.hostname or "").lower()
    path = parts.path.rstrip("/").lower()
    if path.endswith("/chat/completions") or "/v1beta/openai" in path:
        return OPENAI_CHAT
    if path.endswith("/responses"):
        return OPENAI_RESPONSES
    if path.endswith("/messages") or "anthropic" in path.split("/"):  # 如 api.deepseek.com/anthropic
        return ANTHROPIC_MESSAGES
    if ":generatecontent" in path or ":streamgeneratecontent" in path:
        return GEMINI_GENERATE_CONTENT
    if host == "api.anthropic.com":
        return ANTHROPIC_MESSAGES
    if host == GOOGLE_HOST:
        return GEMINI_GENERATE_CONTENT
    if host in ("api.openai.com", "openrouter.ai") or host.endswith(".openrouter.ai"):
        return OPENAI_CHAT
    return None


def endpoint_protocol(types: Any) -> str | None:
    """New API 一个模型的 `supported_endpoint_types` → 对话协议；没有认识的对话格式返回 None。"""
    if not isinstance(types, list):
        return None
    found = {_ENDPOINT_TYPES[t] for t in (str(v).strip().lower() for v in types) if t in _ENDPOINT_TYPES}
    return next((protocol for protocol in _PREFERENCE if protocol in found), None)


def listing_family(body: Any) -> str | None:
    """模型列表的形状：new-api / anthropic / gemini / openrouter / openai；认不出返回 None。"""
    if not isinstance(body, dict):
        return None
    models = body.get("models")
    if isinstance(models, list) and models and all(isinstance(m, dict) for m in models):
        # 官方 name 带 models/ 前缀；New API 模拟的不带前缀，但带 supportedGenerationMethods 字段（可能是空数组）。
        if any("supportedGenerationMethods" in m or str(m.get("name", "")).startswith("models/")
               for m in models):
            return "gemini"
    data = body.get("data")
    if not isinstance(data, list):
        return None
    rows = [row for row in data if isinstance(row, dict)]
    if not rows:
        return "openai" if data == [] else None
    if any("supported_endpoint_types" in row for row in rows):
        return "new-api"
    if any(row.get("type") == "model" and "display_name" in row for row in rows):
        return "anthropic"
    if any("architecture" in row for row in rows):
        return "openrouter"
    return "openai" if all("id" in row for row in rows) else None


def family_protocol(family: str | None) -> str | None:
    """列表形状对应的默认对话协议（New API 逐模型定，这里给的是没认出时的默认）。"""
    return {"anthropic": ANTHROPIC_MESSAGES, "gemini": GEMINI_GENERATE_CONTENT, "new-api": OPENAI_CHAT,
            "openrouter": OPENAI_CHAT, "openai": OPENAI_CHAT}.get(family or "")
