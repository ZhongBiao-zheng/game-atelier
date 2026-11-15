"""豆包语音合成（Seed-TTS，单向流式 SSE），经词元跳动转发。

契约：`tokendance.space/docs/protocol-ark-tts.md`，官方 `volcengine.com/docs/6561/1598757`。
- `POST /gateway/ark/v3/tts/unidirectional`，模型 id 放 `X-Api-Resource-Id` 请求头。
- 响应是 SSE，每条 `data:` 是 JSON：`code=0` 且带 `data` 是一段 base64 音频，按顺序拼接；
  `code=20000000` 是**成功结束**（不是错误码）；其余 code 是失败。
- 语速 `speech_rate` -50..100（0 原速、100 两倍、-50 半速），本机按倍速线性换算。
- 流式 wav 每段都带文件头，拼起来不是合法文件，所以只开放 mp3。
"""
from __future__ import annotations

import base64
import binascii
import json
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import requests

from character_workflow.lib import net_env
from character_workflow.lib.audio_caps import AUDIO_CAPS, normalize_speech_params

PROTOCOL = "ark-tts"
_SUCCESS = 20000000
_RETRY_STATUS = {502, 503, 504}
_ATTEMPTS = 3
_SAMPLE_RATE = 24000


class ArkSpeechError(RuntimeError):
    pass


def _endpoint(base_url: str) -> str:
    parts = urlsplit(base_url)
    host = (parts.hostname or "").lower()
    if host == "tokendance.space" or host.endswith(".tokendance.space"):
        return f"{parts.scheme}://{parts.netloc}/gateway/ark/v3/tts/unidirectional"
    # 官方直连要 X-Api-Key / App-Id 一类凭据，与本机密钥形状不同，暂不支持。
    raise ArkSpeechError("豆包语音目前只支持经词元跳动调用")


def _open(url: str, headers: dict[str, str], payload: dict[str, Any], timeout) -> requests.Response:
    """未送达与 502/503/504 重试；读超时等其余失败当场报错。"""
    for attempt in range(_ATTEMPTS):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=timeout, stream=True)
        except requests.ConnectionError as error:
            if attempt + 1 == _ATTEMPTS:
                raise ArkSpeechError(str(error)) from error
        except requests.RequestException as error:
            raise ArkSpeechError(str(error)) from error
        else:
            if response.status_code not in _RETRY_STATUS or attempt + 1 == _ATTEMPTS:
                return response
            response.close()
        time.sleep(attempt + 1)
    raise AssertionError("unreachable")


def _collect(response: requests.Response) -> tuple[bytes, int | None]:
    """读完 SSE：返回拼好的音频与（如有）上游回报的计费字数。"""
    audio = bytearray()
    words: int | None = None
    finished = False
    try:
        for raw in response.iter_lines():
            line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else str(raw).strip()
            if not line.startswith("data:"):
                continue
            try:
                frame = json.loads(line[5:].strip())
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            code = frame.get("code")
            if code == _SUCCESS:
                usage = frame.get("usage") or {}
                if isinstance(usage, dict) and isinstance(usage.get("text_words"), int):
                    words = usage["text_words"]
                finished = True
                break
            if code not in (0, None):
                raise ArkSpeechError(f"speech api {code}: {frame.get('message') or '合成失败'}")
            chunk = frame.get("data")
            if isinstance(chunk, str) and chunk:
                try:
                    audio += base64.b64decode(chunk, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ArkSpeechError("speech api 返回的音频片段无法解码") from error
    except requests.RequestException as error:
        raise ArkSpeechError(f"语音流中途断开：{error}") from error
    finally:
        response.close()
    if not finished:
        raise ArkSpeechError("语音流没有收到结束标志，音频可能不完整")
    if not audio:
        raise ArkSpeechError("speech api 没有返回音频")
    return bytes(audio), words


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
        raise ArkSpeechError(f"alias not found: {alias}")
    url = _endpoint((key.base_url or "").strip())
    caps = AUDIO_CAPS[PROTOCOL]
    text = prompt.strip()
    if not text:
        raise ArkSpeechError("请输入要朗读的文本")
    if len(text) > caps.max_chars:
        raise ArkSpeechError(f"朗读文本不能超过 {caps.max_chars} 字")
    options = params if params is not None else {}
    settings = normalize_speech_params(caps, options)
    payload = {"req_params": {
        "text": text,
        "speaker": settings["voice"],
        "audio_params": {
            "format": settings["response_format"],
            "sample_rate": _SAMPLE_RATE,
            "speech_rate": round((settings["speed"] - 1) * 100),
            "loudness_rate": 0,
        },
    }}
    headers = {
        "Authorization": f"Bearer {key.access_key}",
        "X-Api-Resource-Id": model,
        "Content-Type": "application/json",
        # 官方约定：带上它，结束帧才回 usage.text_words（计费字数）；转发方不回时按预估记账。
        "X-Control-Require-Usage-Tokens-Return": "text_words",
    }
    response = _open(url, headers, payload, timeout)
    if response.status_code >= 400:
        text_body = response.text[:500]
        response.close()
        raise ArkSpeechError(f"speech api {response.status_code}: {text_body}")
    audio, words = _collect(response)
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"speech.{settings['response_format']}"
    target.write_bytes(audio)
    if words is not None and words >= 0:
        cost = speech_cost_cny(provider=key.provider, model_id=model, characters=words)
        if cost is not None:
            options["actual_cost_cny"] = cost
            if on_params_changed is not None:
                on_params_changed()
    return [str(target)]
