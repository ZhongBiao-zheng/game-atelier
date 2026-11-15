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
    # 语音：朗读文本上限；音乐：描述（提示词）上限。
    max_chars: int
    instructions: bool
    # 音乐：一次最多几首、歌词上限、哪些型号没有纯音乐。
    max_count: int
    max_lyrics_chars: int
    no_instrumental_models: tuple[str, ...]


def _caps(protocol: str, raw: dict[str, Any]) -> AudioCaps:
    speed = raw.get("speed") or [1, 1]
    return AudioCaps(
        protocol=protocol,
        family=raw["family"],
        voices=tuple(voice["id"] for voice in raw.get("voices") or []),
        default_voice=raw.get("default_voice", ""),
        custom_voice=bool(raw.get("custom_voice", False)),
        speed_min=float(speed[0]),
        speed_max=float(speed[1]),
        formats=tuple(raw["formats"]),
        default_format=raw["default_format"],
        max_chars=int(raw["max_chars"]),
        instructions=bool(raw.get("instructions", False)),
        max_count=int(raw.get("max_count", 1)),
        max_lyrics_chars=int(raw.get("max_lyrics_chars", 0)),
        no_instrumental_models=tuple(raw.get("no_instrumental_models") or []),
    )


AUDIO_CAPS: dict[str, AudioCaps] = {protocol: _caps(protocol, raw) for protocol, raw in _RAW.items()}
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


def supports_instrumental(caps: AudioCaps, model_id: str) -> bool:
    return caps.family == "music" and model_id not in caps.no_instrumental_models


def normalize_music_params(caps: AudioCaps, model_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """音乐参数：纯音乐（型号不支持就关）、歌词（纯音乐时不发）、数量夹到 1..上限。

    歌词超长直接报错，不截断：截掉的段落用户看不出来，生成出的歌会少一段。
    """
    instrumental = params.get("instrumental") is True and supports_instrumental(caps, model_id)
    try:
        count = int(params.get("n") or 1)
    except (TypeError, ValueError):
        count = 1
    normalized: dict[str, Any] = {
        "instrumental": instrumental,
        "n": max(1, min(caps.max_count, count)),
    }
    lyrics = str(params.get("lyrics") or "").strip()
    if lyrics and not instrumental:
        if len(lyrics) > caps.max_lyrics_chars:
            raise ValueError(f"歌词不能超过 {caps.max_lyrics_chars} 字")
        normalized["lyrics"] = lyrics
    return normalized
