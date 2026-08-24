"""OpenAI-compatible text-to-speech through audio/speech."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import net_env
from character_workflow.lib.callers.openai_compat import api_root


class OpenAIAudioError(RuntimeError):
    pass


AUDIO_FORMATS = {"mp3", "opus", "aac", "flac", "wav", "pcm"}
AUDIO_VOICES = {
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx",
    "sage", "shimmer", "verse", "marin", "cedar",
}


def _looks_like_speech_model(model: str) -> bool:
    normalized = model.lower()
    if any(item in normalized for item in ("asr", "speech-to-text", "speech2text", "whisper")):
        return False
    return "tts" in normalized or "text-to-speech" in normalized


def supports_model(key: Any, model: Any) -> bool:
    if model is None:
        return False
    if model.protocol in {"openai", "openai-speech", "tts", "speech"}:
        return True
    return (
        model.protocol is None
        and key.provider in {"openai", "custom"}
        and _looks_like_speech_model(model.id)
    )


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
    if not supports_model(key, spec):
        raise OpenAIAudioError(
            f"audio protocol for {model!r} is unknown; expected openai-speech"
        )
    base_url = (key.base_url or "").strip()
    if not base_url and key.provider == "openai":
        base_url = "https://api.openai.com/v1"
    if not base_url:
        raise OpenAIAudioError("audio provider requires base_url")
    if len(prompt) > 4096:
        raise OpenAIAudioError("audio/speech input must not exceed 4096 characters")

    options = params or {}
    response_format = str(options.get("response_format") or "mp3").lower()
    if response_format not in AUDIO_FORMATS:
        raise OpenAIAudioError(f"unsupported audio response format: {response_format}")
    raw_speed = options.get("speed") if options.get("speed") is not None else 1
    speed = float(raw_speed)
    if speed < 0.25 or speed > 4:
        raise OpenAIAudioError("audio speed must be between 0.25 and 4")
    voice = str(options.get("voice") or "alloy").lower()
    if voice not in AUDIO_VOICES:
        raise OpenAIAudioError(f"unsupported audio voice: {voice}")
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "voice": voice,
        "response_format": response_format,
        "speed": speed,
    }
    instructions = str(options.get("instructions") or "").strip()
    if instructions:
        payload["instructions"] = instructions
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
    content_type = str(response.headers.get("content-type") or "").lower()
    if "json" in content_type or response.content.lstrip().startswith((b"{", b"[")):
        raise OpenAIAudioError(f"audio api returned JSON instead of audio: {response.text[:500]}")
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"speech.{response_format}"
    target.write_bytes(response.content)
    return [str(target)]
