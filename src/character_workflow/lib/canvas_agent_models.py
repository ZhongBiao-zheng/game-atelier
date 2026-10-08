"""画布 Agent 的对话模型列表：实时拉取已配置 Key 的 /models，只留能对话、能调用工具的。

聚合商的 /models 形状各不相同（new-api 的 supported_endpoint_types、OpenRouter 的
architecture + supported_parameters、词元跳动的 supported_protocols），判据按字段有无分流；
都没有时按模型 id 排除明显的出图 / 视频 / 语音 / 向量模型。
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests

from character_workflow.lib import keys
from character_workflow.lib.callers.openai_compat import api_root

logger = logging.getLogger(__name__)

CHAT_PROVIDERS = frozenset({"openai", "openrouter", "custom", "seedream", "tokendance"})
OPENAI_BASE_URL = "https://api.openai.com/v1"
CACHE_SECONDS = 600
FETCH_TIMEOUT = (5, 20)

_NON_CHAT_ID_HINTS = (
    "image", "dall-e", "dalle", "banana", "seedream", "flux", "midjourney", "mj_",
    "video", "sora", "veo", "kling", "seedance", "happyhorse", "hailuo",
    "tts", "whisper", "speech", "audio", "embedding", "rerank", "ocr", "moderation",
)
_NEW_API_CHAT_TYPES = frozenset({"openai", "openai-chat"})
_NEW_API_MEDIA_TYPES = ("image", "video", "generate", "edit", "embedding", "audio", "veo", "sora")

_cache: dict[str, tuple[float, list[dict]]] = {}
_cache_lock = threading.Lock()


def chat_base_url(key: keys.KeySpec) -> str:
    return api_root(key.base_url or OPENAI_BASE_URL)


def is_chat_model(item: dict[str, Any]) -> bool:
    model_id = str(item.get("id") or "")
    lowered = model_id.lower()
    if not model_id or lowered.endswith(":batch"):
        return False
    architecture = item.get("architecture")
    if isinstance(architecture, dict):  # OpenRouter：只输出文本，且声明支持 tools
        outputs = architecture.get("output_modalities") or []
        return outputs == ["text"] and "tools" in (item.get("supported_parameters") or [])
    protocols = item.get("supported_protocols")
    if isinstance(protocols, list):  # 词元跳动网关
        return any("chat-completions" in str(p).lower() for p in protocols)
    if any(hint in lowered for hint in _NON_CHAT_ID_HINTS):
        return False
    types = item.get("supported_endpoint_types")
    if isinstance(types, list):  # new-api（Tuzi / OpenAI-HK）
        lowered_types = [str(t).lower() for t in types]
        if any(any(m in t for m in _NEW_API_MEDIA_TYPES) for t in lowered_types):
            return False
        return any(t in _NEW_API_CHAT_TYPES for t in lowered_types)
    return True


def _supports_reasoning(item: dict[str, Any]) -> bool | None:
    params = item.get("supported_parameters")
    if isinstance(params, list):
        return "reasoning" in params
    return None


def _fetch(key: keys.KeySpec) -> list[dict]:
    response = requests.get(
        f"{chat_base_url(key)}/models",
        headers={"Authorization": f"Bearer {key.access_key}"},
        timeout=FETCH_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json().get("data") or []
    return [
        {"alias": key.alias, "model": str(item["id"]), "name": str(item.get("name") or item["id"]),
         "reasoning": _supports_reasoning(item)}
        for item in data if isinstance(item, dict) and is_chat_model(item)
    ]


def _models_for(key: keys.KeySpec, now: float) -> tuple[list[dict], str | None]:
    with _cache_lock:
        cached = _cache.get(key.alias)
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1], None
    try:
        rows = _fetch(key)
    except (requests.RequestException, ValueError) as error:
        logger.warning("chat model list failed for %s: %s", key.alias, type(error).__name__)
        return (cached[1] if cached else []), "模型列表获取失败"
    with _cache_lock:
        _cache[key.alias] = (now, rows)
    return rows, None


def list_chat_models() -> dict:
    """Every configured key's chat models, fetched in parallel; failures are reported per key."""
    candidates = [
        key for key in keys.read_keys_db().keys
        if key.provider in CHAT_PROVIDERS and (key.base_url or key.provider == "openai")
    ]
    if not candidates:
        return {"models": [], "errors": []}
    now = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        results = list(pool.map(lambda key: _models_for(key, now), candidates))
    models: list[dict] = []
    errors: list[dict] = []
    for key, (rows, error) in zip(candidates, results):
        models.extend(rows)
        if error:
            errors.append({"alias": key.alias, "message": error})
    return {"models": models, "errors": errors}
