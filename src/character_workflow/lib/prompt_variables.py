"""Inline prompt-variable drafts; resolve once when freezing a generation request."""
from __future__ import annotations

import json
import re
from urllib.parse import quote, unquote

from character_workflow.lib.schemas import CreationPromptSegment


_PREFIX = "@[variable:"
_INVALID_PERCENT = re.compile(r"%(?![0-9a-fA-F]{2})")


def build_prompt_variable_template(
    segments: list[CreationPromptSegment],
    values: dict[str, str] | None = None,
) -> str:
    parts: list[str] = []
    for segment in segments:
        if segment.kind == "text":
            parts.append(segment.text)
            continue
        payload = json.dumps({
            "name": segment.name,
            "example": segment.default_value,
            "value": (values or {}).get(segment.name, ""),
        }, ensure_ascii=False, separators=(",", ":"))
        encoded = quote(payload, safe="~()*!.'-")
        parts.append(f"{_PREFIX}{encoded}]")
    result = "".join(parts)
    if len(result) > 40_000:
        raise ValueError("提示词变量模板过长，请减少正文或变量示例内容")
    return result


def resolve_prompt_variables(prompt: str) -> str:
    parts: list[str] = []
    values: dict[str, str] = {}
    missing: list[str] = []
    cursor = 0
    while (start := prompt.find(_PREFIX, cursor)) != -1:
        end = prompt.find("]", start + len(_PREFIX))
        encoded = prompt[start + len(_PREFIX):end] if end != -1 else ""
        try:
            if end == -1 or _INVALID_PERCENT.search(encoded):
                raise ValueError
            payload = json.loads(unquote(encoded, errors="strict"))
            if (
                not isinstance(payload, dict)
                or set(payload) != {"name", "example", "value"}
                or not all(isinstance(value, str) for value in payload.values())
                or not payload["name"].strip()
            ):
                raise ValueError
        except (ValueError, UnicodeError) as error:
            raise ValueError("提示词变量格式无效，请重新插入提示词资产") from error
        name, value = payload["name"], payload["value"]
        if not value.strip():
            value = payload["example"]
        if name in values and values[name] != value:
            raise ValueError(f"同名提示词变量内容不一致：{name}")
        values[name] = value
        if not value.strip() and name not in missing:
            missing.append(name)
        parts.extend((prompt[cursor:start], value))
        cursor = end + 1
    if missing:
        raise ValueError(f"请填写提示词变量：{'、'.join(missing)}")
    parts.append(prompt[cursor:])
    return "".join(parts)
