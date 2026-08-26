"""OpenAI-compatible text generation through chat/completions or Responses."""
from __future__ import annotations

import base64
import binascii
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
_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}
_AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/m4a",
    ".aac": "audio/aac",
}
_AUDIO_FORMAT = {
    ".mp3": "mp3",
    ".wav": "wav",
    ".m4a": "m4a",
    ".aac": "aac",
}
_MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024
_MAX_INLINE_AUDIO_BYTES = 25 * 1024 * 1024
_MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024
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


def supports_input_modality(provider: str, protocol: str | None, modality: str) -> bool:
    """Whether this caller has a wire format for one declared model input."""
    if modality == "image":
        return True
    if protocol == "openai-responses":
        return provider in {"seedream", "tokendance", "custom"}
    if modality == "video" and provider == "openai":
        return False
    return modality in {"video", "audio"}


def _media_data_url(
    reference: str,
    *,
    mime_types: dict[str, str],
    max_bytes: int,
    label: str,
) -> str:
    if reference.startswith(("https://", "http://")):
        return reference
    if reference.startswith("data:"):
        header, separator, encoded = reference.partition(",")
        mime_type = header.removeprefix("data:").split(";", 1)[0]
        if not separator or ";base64" not in header or mime_type not in mime_types.values():
            raise OpenAITextError(f"不支持的{label}输入")
        try:
            decoded_size = len(base64.b64decode(encoded, validate=True))
        except (binascii.Error, ValueError) as error:
            raise OpenAITextError(f"{label}输入 Base64 无效") from error
        if decoded_size > max_bytes:
            raise OpenAITextError(f"{label}输入文件过大")
        return reference
    path = Path(reference)
    mime_type = mime_types.get(path.suffix.lower())
    if mime_type is None or not path.is_file():
        raise OpenAITextError(f"不支持的{label}输入")
    if path.stat().st_size > max_bytes:
        raise OpenAITextError(f"{label}输入文件过大")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _image_url(reference: str) -> str:
    return _media_data_url(
        reference,
        mime_types=_IMAGE_MIME,
        max_bytes=_MAX_INLINE_IMAGE_BYTES,
        label="图片",
    )


def _video_url(reference: str) -> str:
    return _media_data_url(
        reference,
        mime_types=_VIDEO_MIME,
        max_bytes=_MAX_INLINE_VIDEO_BYTES,
        label="视频",
    )


def _audio_url(reference: str) -> str:
    return _media_data_url(
        reference,
        mime_types=_AUDIO_MIME,
        max_bytes=_MAX_INLINE_AUDIO_BYTES,
        label="音频",
    )


def _chat_audio(reference: str) -> dict[str, str]:
    if reference.startswith(("https://", "http://")):
        suffix = Path(reference.split("?", 1)[0]).suffix.lower()
        audio_format = _AUDIO_FORMAT.get(suffix)
        if audio_format is None:
            raise OpenAITextError("无法识别音频格式")
        return {"url": reference, "format": audio_format}

    data_url = _audio_url(reference)
    header, separator, encoded = data_url.partition(",")
    if not separator or ";base64" not in header:
        raise OpenAITextError("音频输入必须使用 Base64")
    mime_type = header.removeprefix("data:").split(";", 1)[0]
    audio_format = next(
        (value for suffix, value in _AUDIO_FORMAT.items() if _AUDIO_MIME[suffix] == mime_type),
        None,
    )
    if audio_format is None:
        raise OpenAITextError("无法识别音频格式")
    return {"data": encoded, "format": audio_format}


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
    image_references = [str(value) for value in options.get("reference_images") or []]
    video_references = [str(value) for value in options.get("reference_videos") or []]
    audio_references = [str(value) for value in options.get("reference_audios") or []]
    unsupported = [
        modality
        for modality, references in (
            ("image", image_references),
            ("video", video_references),
            ("audio", audio_references),
        )
        if references and not supports_input_modality(key.provider, protocol, modality)
    ]
    if unsupported:
        labels = {"image": "图片", "video": "视频", "audio": "音频"}
        raise OpenAITextError(
            f"当前模型接口不支持{'、'.join(labels[item] for item in unsupported)}输入"
        )
    has_references = bool(image_references or video_references or audio_references)
    content: str | list[dict[str, Any]] = prompt
    if has_references:
        content = [
            {"type": "text", "text": prompt},
            *[
                {"type": "image_url", "image_url": {"url": _image_url(reference)}}
                for reference in image_references
            ],
            *[
                {"type": "video_url", "video_url": {"url": _video_url(reference)}}
                for reference in video_references
            ],
            *[
                {"type": "input_audio", "input_audio": _chat_audio(reference)}
                for reference in audio_references
            ],
        ]
    if protocol == "openai-responses":
        response_input: str | list[dict[str, Any]] = prompt
        if has_references:
            response_input = [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    *[
                        {"type": "input_image", "image_url": _image_url(reference)}
                        for reference in image_references
                    ],
                    *[
                        {"type": "input_video", "video_url": _video_url(reference)}
                        for reference in video_references
                    ],
                    *[
                        {"type": "input_audio", "audio_url": _audio_url(reference)}
                        for reference in audio_references
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
