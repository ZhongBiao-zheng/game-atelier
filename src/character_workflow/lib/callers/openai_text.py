"""OpenAI-compatible text generation through chat/completions or Responses."""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import net_env
from character_workflow.lib.callers.openai_compat import api_root


class OpenAITextError(RuntimeError):
    pass


_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
_MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024
_SUPPORTED_PROTOCOLS = {
    None, "openai", "openai-chat", "chat-completions", "openai-responses",
}


def supports_model(key: Any, model: Any) -> bool:
    protocol = model.protocol if model is not None else None
    declared = protocol in _SUPPORTED_PROTOCOLS - {None}
    return (
        protocol in _SUPPORTED_PROTOCOLS
        and (
            key.provider in {"openai", "openrouter", "seedream", "tokendance", "custom"}
            or declared
        )
    )


def _image_url(reference: str) -> str:
    if reference.startswith(("https://", "http://")):
        return reference
    if reference.startswith(("data:image/png;", "data:image/jpeg;", "data:image/webp;")):
        return reference
    path = Path(reference)
    mime_type = _IMAGE_MIME.get(path.suffix.lower())
    if mime_type is None or not path.is_file():
        raise OpenAITextError("multimodal text input is not a supported image")
    if path.stat().st_size > _MAX_INLINE_IMAGE_BYTES:
        raise OpenAITextError("multimodal text input exceeds 25 MiB")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


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


def _response_text(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    direct = body.get("output_text")
    if isinstance(direct, str):
        return direct.strip() or None
    output = body.get("output")
    if not isinstance(output, list):
        return None
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        parts.extend(
            str(part.get("text"))
            for part in content
            if isinstance(part, dict)
            and part.get("type") in {"output_text", "text"}
            and isinstance(part.get("text"), str)
        )
    return "".join(parts).strip() or None


def _post_json(
    *,
    url: str,
    access_key: str,
    payload: dict[str, Any],
    timeout: float | tuple[float, float],
) -> object:
    try:
        response = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {access_key}",
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
        return response.json()
    except ValueError as error:
        raise OpenAITextError(f"text api response is not JSON: {error}") from error


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
    protocol = spec.protocol if spec is not None else None
    if not supports_model(key, spec):
        raise OpenAITextError(
            f"provider {key.provider!r} / protocol {protocol!r} does not support text generation"
        )
    base_url = (key.base_url or "").strip()
    if not base_url and key.provider == "openai":
        base_url = "https://api.openai.com/v1"
    if not base_url:
        raise OpenAITextError("text provider requires base_url")
    options = params or {}
    references = [str(value) for value in options.get("reference_images") or []]
    content: str | list[dict[str, Any]] = prompt
    if references:
        content = [
            {"type": "text", "text": prompt},
            *[
                {"type": "image_url", "image_url": {"url": _image_url(reference)}}
                for reference in references
            ],
        ]
    if protocol == "openai-responses":
        response_input: str | list[dict[str, Any]] = prompt
        if references:
            response_input = [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    *[
                        {"type": "input_image", "image_url": _image_url(reference)}
                        for reference in references
                    ],
                ],
            }]
        response_payload: dict[str, Any] = {"model": model, "input": response_input}
        effort = str(options.get("reasoning_effort") or "auto")
        if effort != "auto":
            response_payload["reasoning"] = {"effort": effort}
        if options.get("max_tokens") is not None:
            response_payload["max_output_tokens"] = int(options["max_tokens"])
        generated: list[str] = []
        for _ in range(max(1, int(n))):
            body = _post_json(
                url=f"{api_root(base_url)}/responses",
                access_key=key.access_key,
                payload=response_payload,
                timeout=timeout,
            )
            text = _response_text(body)
            if not text:
                raise OpenAITextError(f"text api returned no text: {body!r}")
            generated.append(text)
        return generated

    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "n": max(1, int(n)),
        "stream": False,
    }
    if options.get("temperature") is not None:
        payload["temperature"] = float(options["temperature"])
    if options.get("max_tokens") is not None:
        payload["max_tokens"] = int(options["max_tokens"])
    body = _post_json(
        url=f"{api_root(base_url)}/chat/completions",
        access_key=key.access_key,
        payload=payload,
        timeout=timeout,
    )
    choices = body.get("choices") if isinstance(body, dict) else None
    outputs = [_content_text(choice) for choice in choices] if isinstance(choices, list) else []
    generated = [item for item in outputs if item]
    if not generated:
        raise OpenAITextError(f"text api returned no text: {body!r}")
    return generated[: max(1, int(n))]
