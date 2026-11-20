"""三家用量口径归一成一个结构（计费以此为准）。

口径差异（出处见 ADR-0044）：
- OpenAI Chat：`prompt_tokens` 含缓存命中（`prompt_tokens_details.cached_tokens`）。
- OpenAI Responses：`input_tokens` 含缓存命中与缓存写入（`input_tokens_details.cached_tokens` /
  `cache_write_tokens`）。
- Anthropic：`input_tokens` **不含**缓存；总输入 = input + cache_creation + cache_read。
- Gemini：`promptTokenCount` 含缓存；工具提示 `toolUsePromptTokenCount` 另计入输入；
  思考 `thoughtsTokenCount` 不在 `candidatesTokenCount` 里，要加进输出。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Usage:
    input_total: int  # 含缓存命中与缓存写入
    cache_read: int
    cache_write: int
    output_total: int  # 含推理 / 思考
    reasoning: int = 0


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _details(usage: dict, name: str) -> dict:
    value = usage.get(name)
    return value if isinstance(value, dict) else {}


def from_openai(usage: Any) -> Usage | None:
    """Chat（prompt/completion）与 Responses（input/output）两种字段名都认；缺输入或输出返回 None。"""
    if not isinstance(usage, dict):
        return None
    chat = "prompt_tokens" in usage or "completion_tokens" in usage
    prefix_in, prefix_out = ("prompt", "completion") if chat else ("input", "output")
    total_in = _int(usage.get(f"{prefix_in}_tokens"))
    total_out = _int(usage.get(f"{prefix_out}_tokens"))
    if total_in is None or total_out is None:
        return None
    details_in = _details(usage, f"{prefix_in}_tokens_details")
    details_out = _details(usage, f"{prefix_out}_tokens_details")
    return Usage(
        input_total=total_in,
        cache_read=_int(details_in.get("cached_tokens")) or 0,
        cache_write=_int(details_in.get("cache_write_tokens")) or 0,
        output_total=total_out,
        reasoning=_int(details_out.get("reasoning_tokens")) or 0,
    )


def from_anthropic(usage: Any) -> Usage | None:
    if not isinstance(usage, dict):
        return None
    fresh = _int(usage.get("input_tokens"))
    output = _int(usage.get("output_tokens"))
    if fresh is None or output is None:
        return None
    read = _int(usage.get("cache_read_input_tokens")) or 0
    write = _int(usage.get("cache_creation_input_tokens")) or 0
    return Usage(input_total=fresh + read + write, cache_read=read, cache_write=write,
                 output_total=output)


def from_gemini(metadata: Any) -> Usage | None:
    if not isinstance(metadata, dict):
        return None
    prompt = _int(metadata.get("promptTokenCount"))
    if prompt is None:
        return None
    thoughts = _int(metadata.get("thoughtsTokenCount")) or 0
    candidates = _int(metadata.get("candidatesTokenCount")) or 0
    return Usage(
        input_total=prompt + (_int(metadata.get("toolUsePromptTokenCount")) or 0),
        cache_read=_int(metadata.get("cachedContentTokenCount")) or 0,
        cache_write=0,
        output_total=candidates + thoughts,
        reasoning=thoughts,
    )


def to_chat(usage: Usage) -> dict:
    """写回 Chat 响应的 usage。`cache_write_tokens` 与 OpenAI Responses 同名，Chat 本身没有这个字段。"""
    return {
        "prompt_tokens": usage.input_total,
        "completion_tokens": usage.output_total,
        "total_tokens": usage.input_total + usage.output_total,
        "prompt_tokens_details": {"cached_tokens": usage.cache_read,
                                  "cache_write_tokens": usage.cache_write},
        "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
    }
