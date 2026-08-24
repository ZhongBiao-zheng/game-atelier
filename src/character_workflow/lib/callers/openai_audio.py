"""OpenAI-compatible text-to-speech through audio/speech."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import net_env
from character_workflow.lib.callers.openai_compat import api_root


class OpenAIAudioError(RuntimeError):
    pass


_FORMATS = {"mp3", "opus", "aac", "flac", "wav"}


def _looks_like_speech_model(model: str) -> bool:
    normalized = model.lower()
    if any(item in normalized for item in ("asr", "speech-to-text", "speech2text", "whisper")):
        return False
    return "tts" in normalized or "text-to-speech" in normalized


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    timeout: float | tuple[float, float] = net_env.DEFAULT_TIMEOUT,
    params: dict[str, Any] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys

    key = keys.find_by_alias(alias)
    if key is None:
        raise OpenAIAudioError(f"alias not found: {alias}")
    spec = next((item for item in key.models if item.id == model), None)
    declared_openai_speech = spec is not None and spec.protocol in {
        "openai", "openai-speech", "tts", "speech"
    }
    inferred_openai_speech = (
        spec is not None
        and spec.protocol is None
        and key.provider in {"openai", "custom"}
        and _looks_like_speech_model(model)
    )
    if not declared_openai_speech and not inferred_openai_speech:
        raise OpenAIAudioError(
            f"audio protocol for {model!r} is unknown; expected openai-speech"
        )
    base_url = (key.base_url or "").strip()
    if not base_url and key.provider == "openai":
        base_url = "https://api.openai.com/v1"
    if not base_url:
        raise OpenAIAudioError("audio provider requires base_url")
    if spec and spec.protocol not in {None, "openai", "openai-speech", "tts", "speech"}:
        raise OpenAIAudioError(
            f"audio protocol {spec.protocol!r} is not supported; expected openai-speech"
        )
    if len(prompt) > 4096:
        raise OpenAIAudioError("audio/speech input must not exceed 4096 characters")

    options = params or {}
    response_format = str(options.get("response_format") or "mp3").lower()
    if response_format not in _FORMATS:
        raise OpenAIAudioError(f"unsupported audio response format: {response_format}")
    speed = float(options.get("speed") or 1)
    if speed < 0.25 or speed > 4:
        raise OpenAIAudioError("audio speed must be between 0.25 and 4")
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "voice": str(options.get("voice") or "alloy"),
        "response_format": response_format,
        "speed": speed,
    }
    if options.get("instructions"):
        payload["instructions"] = str(options["instructions"])
    try:
        response = requests.post(
            f"{api_root(base_url)}/audio/speech",
            headers={
                "Authorization": f"Bearer {key.access_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as error:
        raise OpenAIAudioError(str(error)) from error
    if response.status_code >= 400:
        raise OpenAIAudioError(f"audio api {response.status_code}: {response.text[:500]}")
    if not response.content:
        raise OpenAIAudioError("audio api returned an empty file")
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"speech.{response_format}"
    target.write_bytes(response.content)
    return [str(target)]
