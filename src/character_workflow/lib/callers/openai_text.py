"""OpenAI-compatible text generation through chat/completions."""
from __future__ import annotations

from typing import Any

import requests

from character_workflow.lib import net_env
from character_workflow.lib.callers.openai_compat import api_root


class OpenAITextError(RuntimeError):
    pass


def _content_text(choice: object) -> str | None:
    if not isinstance(choice, dict):
        return None
    message = choice.get("message")
    content = message.get("content") if isinstance(message, dict) else choice.get("text")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            str(item.get("text"))
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        return "".join(parts).strip() or None
    return None


def generate(
    *,
    prompt: str,
    model: str,
    alias: str,
    n: int = 1,
    timeout: float | tuple[float, float] = net_env.DEFAULT_TIMEOUT,
    params: dict[str, Any] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys

    key = keys.find_by_alias(alias)
    if key is None:
        raise OpenAITextError(f"alias not found: {alias}")
    spec = next((item for item in key.models if item.id == model), None)
    declared_openai_chat = spec is not None and spec.protocol in {
        "openai", "openai-chat", "chat-completions"
    }
    if (
        key.provider not in {"openai", "openrouter", "tokendance", "custom"}
        and not declared_openai_chat
    ):
        raise OpenAITextError(f"provider {key.provider!r} does not support openai-chat")
    base_url = (key.base_url or "").strip()
    if not base_url and key.provider == "openai":
        base_url = "https://api.openai.com/v1"
    if not base_url:
        raise OpenAITextError("text provider requires base_url")
    if spec and spec.protocol not in {None, "openai", "openai-chat", "chat-completions"}:
        raise OpenAITextError(
            f"text protocol {spec.protocol!r} is not supported; expected openai-chat"
        )

    options = params or {}
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "n": max(1, int(n)),
        "stream": False,
    }
    if options.get("temperature") is not None:
        payload["temperature"] = float(options["temperature"])
    if options.get("max_tokens") is not None:
        payload["max_tokens"] = int(options["max_tokens"])
    try:
        response = requests.post(
            f"{api_root(base_url)}/chat/completions",
            headers={
                "Authorization": f"Bearer {key.access_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as error:
        raise OpenAITextError(str(error)) from error
    if response.status_code >= 400:
        raise OpenAITextError(f"text api {response.status_code}: {response.text[:500]}")
    try:
        body = response.json()
    except ValueError as error:
        raise OpenAITextError(f"text api response is not JSON: {error}") from error
    choices = body.get("choices") if isinstance(body, dict) else None
    outputs = [_content_text(choice) for choice in choices] if isinstance(choices, list) else []
    generated = [item for item in outputs if item]
    if not generated:
        raise OpenAITextError(f"text api returned no text: {body!r}")
    return generated[: max(1, int(n))]
