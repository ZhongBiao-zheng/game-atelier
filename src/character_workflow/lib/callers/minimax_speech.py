"""MiniMax 同步语音合成（T2A v2）。

契约：官方 `POST {api}/t2a_v2`；词元跳动转发在 `/gateway/minimax/v1/t2a_v2`
（tokendance.space/docs/protocol-minimax-t2a-v2.md）。非流式请求一次返回完整音频，
`data.audio` 为 hex，`extra_info.usage_characters` 是计费字符数，`base_resp.status_code` 非 0 即失败。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import requests

from character_workflow.lib import net_env
from character_workflow.lib.audio_caps import AUDIO_CAPS, normalize_speech_params
from character_workflow.lib.callers.openai_compat import api_root

PROTOCOL = "minimax-t2a"
_RETRY_STATUS = {502, 503, 504}
_ATTEMPTS = 3
# 采样率与码率用官方默认值；显式发出，产物规格不随上游默认值漂移。
_SAMPLE_RATE = 32000
_BITRATE = 128000


class MiniMaxSpeechError(RuntimeError):
    pass


def _endpoint(base_url: str) -> str:
    parts = urlsplit(base_url)
    host = (parts.hostname or "").lower()
    if host == "tokendance.space" or host.endswith(".tokendance.space"):
        return f"{parts.scheme}://{parts.netloc}/gateway/minimax/v1/t2a_v2"
    return f"{api_root(base_url)}/t2a_v2"


def _post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout) -> requests.Response:
    """未送达（连不上）与网关 502/503/504 重试；读超时等其余失败当场报错，不重复计费。"""
    for attempt in range(_ATTEMPTS):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except requests.ConnectionError as error:
            if attempt + 1 == _ATTEMPTS:
                raise MiniMaxSpeechError(str(error)) from error
        except requests.RequestException as error:
            raise MiniMaxSpeechError(str(error)) from error
        else:
            if response.status_code not in _RETRY_STATUS or attempt + 1 == _ATTEMPTS:
                return response
        time.sleep(attempt + 1)
    raise AssertionError("unreachable")


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    timeout: float | tuple[float, float] = net_env.DEFAULT_TIMEOUT,
    params: dict[str, Any] | None = None,
    on_params_changed: Callable[[], None] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys
    from character_workflow.lib.generation_pricing import speech_cost_cny

    key = keys.find_by_alias(alias)
    if key is None:
        raise MiniMaxSpeechError(f"alias not found: {alias}")
    base_url = (key.base_url or "").strip()
    if not base_url:
        raise MiniMaxSpeechError("语音供应商缺少接口地址")
    caps = AUDIO_CAPS[PROTOCOL]
    text = prompt.strip()
    if not text:
        raise MiniMaxSpeechError("请输入要朗读的文本")
    if len(text) > caps.max_chars:
        raise MiniMaxSpeechError(f"朗读文本不能超过 {caps.max_chars} 字")
    options = params if params is not None else {}
    settings = normalize_speech_params(caps, options)
    payload = {
        "model": model,
        "text": text,
        "stream": False,
        "voice_setting": {"voice_id": settings["voice"], "speed": settings["speed"], "vol": 1, "pitch": 0},
        "audio_setting": {
            "sample_rate": _SAMPLE_RATE,
            "bitrate": _BITRATE,
            "format": settings["response_format"],
            "channel": 1,
        },
        "output_format": "hex",
        "subtitle_enable": False,
        "aigc_watermark": False,
    }
    response = _post(
        _endpoint(base_url),
        {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"},
        payload,
        timeout,
    )
    if response.status_code >= 400:
        raise MiniMaxSpeechError(f"speech api {response.status_code}: {response.text[:500]}")
    try:
        body = response.json()
    except ValueError as error:
        raise MiniMaxSpeechError(f"speech api 返回的不是 JSON：{response.text[:200]}") from error
    if not isinstance(body, dict):
        raise MiniMaxSpeechError("speech api 返回格式无法识别")
    base_resp = body.get("base_resp") or {}
    status = base_resp.get("status_code", 0)
    if status not in (0, None):
        raise MiniMaxSpeechError(f"speech api {status}: {base_resp.get('status_msg') or '合成失败'}")
    audio_hex = (body.get("data") or {}).get("audio")
    if not isinstance(audio_hex, str) or not audio_hex:
        raise MiniMaxSpeechError("speech api 没有返回音频")
    try:
        audio = bytes.fromhex(audio_hex)
    except ValueError as error:
        raise MiniMaxSpeechError("speech api 返回的音频无法解码") from error
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"speech.{settings['response_format']}"
    target.write_bytes(audio)

    characters = (body.get("extra_info") or {}).get("usage_characters")
    if isinstance(characters, int) and characters >= 0:
        cost = speech_cost_cny(provider=key.provider, model_id=model, characters=characters)
        if cost is not None:
            options["actual_cost_cny"] = cost
            if on_params_changed is not None:
                on_params_changed()
    return [str(target)]
