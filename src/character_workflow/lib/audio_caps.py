"""音频模型能力：协议 → 族（语音 / 音乐）与参数范围。

能力表在 `data/audio_caps.json`，前端 `web/src/lib/audioCaps.ts` 读同一份文件；
协议解析与参数归一两端各写一份，用 `tests/fixtures/audio_caps_cases.json` 钉住同义。
判据挂模型的 protocol，不挂 provider：同一协议走直连和走聚合商能力一样。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from importlib.resources import files
from types import SimpleNamespace
from typing import Any, Literal

_RAW: dict[str, dict[str, Any]] = json.loads(
    files("character_workflow").joinpath("data/audio_caps.json").read_text(encoding="utf-8")
)

# 旧数据与上游目录里出现过的 OpenAI 兼容语音协议写法。
_OPENAI_SPEECH_ALIASES = {"openai", "openai-speech", "tts", "speech"}
_NON_SPEECH_ID_HINTS = ("asr", "speech-to-text", "speech2text", "whisper")
CUSTOM_VOICE_MAX_LENGTH = 200


@dataclass(frozen=True)
class AudioCaps:
    protocol: str
    family: Literal["speech", "music"]
    voices: tuple[str, ...]
    default_voice: str
    custom_voice: bool
    speed_min: float
    speed_max: float
    formats: tuple[str, ...]
    default_format: str
    max_chars: int
    instructions: bool


AUDIO_CAPS: dict[str, AudioCaps] = {
    protocol: AudioCaps(
        protocol=protocol,
        family=raw["family"],
        voices=tuple(voice["id"] for voice in raw["voices"]),
        default_voice=raw["default_voice"],
        custom_voice=bool(raw["custom_voice"]),
        speed_min=float(raw["speed"][0]),
        speed_max=float(raw["speed"][1]),
        formats=tuple(raw["formats"]),
        default_format=raw["default_format"],
        max_chars=int(raw["max_chars"]),
        instructions=bool(raw["instructions"]),
    )
    for protocol, raw in _RAW.items()
}
# 任何协议的内置音色：换协议时它们不能被当成「自定义音色 ID」带过去。
_BUILTIN_VOICES = frozenset(voice for caps in AUDIO_CAPS.values() for voice in caps.voices)


def _looks_like_speech_model(model_id: str) -> bool:
    normalized = model_id.lower()
    if any(item in normalized for item in _NON_SPEECH_ID_HINTS):
        return False
    return "tts" in normalized or "text-to-speech" in normalized


def audio_protocol(key: Any, model: Any) -> str | None:
    """模型实际可执行的音频协议；None 表示当前版本跑不了它。"""
    if model is None:
        return None
    if key.provider == "atelier":
        # 局域网网关的模型：每个成员都要能跑，而且协议一致，界面参数才只有一套。
        members = model.via or []
        protocols = {
            audio_protocol(SimpleNamespace(provider=member.provider),
                           SimpleNamespace(id=member.model_id, protocol=member.protocol, via=None))
            for member in members
        }
        return protocols.pop() if len(protocols) == 1 and None not in protocols else None
    protocol = model.protocol
    if protocol in _OPENAI_SPEECH_ALIASES:
        return "openai-speech"
    if protocol in AUDIO_CAPS:
        return protocol
    if protocol is None and key.provider in {"openai", "custom"} and _looks_like_speech_model(model.id):
        return "openai-speech"
    return None


def audio_caps(key: Any, model: Any) -> AudioCaps | None:
    protocol = audio_protocol(key, model)
    return AUDIO_CAPS.get(protocol) if protocol else None


def _valid_custom_voice(value: str) -> bool:
    return (
        0 < len(value) <= CUSTOM_VOICE_MAX_LENGTH
        and value not in _BUILTIN_VOICES
        and all(ch.isprintable() for ch in value)
    )


def normalize_speech_params(caps: AudioCaps, params: dict[str, Any]) -> dict[str, Any]:
    """按协议能力收拢语音参数：内置音色或合法自定义 ID，语速夹到范围内，格式不认识回默认。"""
    raw_voice = str(params.get("voice") or "").strip()
    if raw_voice in caps.voices or (caps.custom_voice and _valid_custom_voice(raw_voice)):
        voice = raw_voice
    else:
        voice = caps.default_voice
    response_format = str(params.get("response_format") or "").lower()
    if response_format not in caps.formats:
        response_format = caps.default_format
    try:
        speed = float(params.get("speed") if params.get("speed") is not None else 1)
    except (TypeError, ValueError):
        speed = 1.0
    if not math.isfinite(speed):
        speed = 1.0
    speed = round(max(caps.speed_min, min(caps.speed_max, speed)), 2)
    normalized: dict[str, Any] = {"voice": voice, "response_format": response_format, "speed": speed}
    instructions = str(params.get("instructions") or "").strip()
    if caps.instructions and instructions:
        normalized["instructions"] = instructions
    return normalized
