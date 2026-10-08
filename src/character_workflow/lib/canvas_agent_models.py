"""画布 Agent 的对话模型列表：各 Key 里用户启用的文本模型，再用上游 /models 去掉不能调用工具的。

候选只来自 keys.json 里启用的模型（modality=text），上游有几百个模型也不全列。
/models 只用来判「能不能当 Agent」：上游明确判为不能对话 / 不支持 tools 的去掉，
上游没列出或拉取失败的照常保留（能力未知时交给用户试，失败会有明确报错）。
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

_cache: dict[str, tuple[float, dict[str, dict]]] = {}
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


def enabled_text_models(key: keys.KeySpec) -> list[keys.ModelSpec]:
    """用户在这把 Key 里启用的文本模型；未标模态的模型只在 Key 只开了 llm 时算文本。"""
    llm_only = set(key.modalities) == {"llm"}
    return [model for model in key.models
            if model.modality == "text" or (model.modality is None and llm_only)]


def _fetch(key: keys.KeySpec) -> dict[str, dict]:
    """上游 /models 里每个模型的能力：{id: {"agent": bool, "reasoning": bool | None}}。"""
    response = requests.get(
        f"{chat_base_url(key)}/models",
        headers={"Authorization": f"Bearer {key.access_key}"},
        timeout=FETCH_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json().get("data") or []
    return {
        str(item["id"]): {"agent": is_chat_model(item), "reasoning": _supports_reasoning(item)}
        for item in data if isinstance(item, dict) and item.get("id")
    }


def _upstream_for(key: keys.KeySpec, now: float) -> tuple[dict[str, dict], str | None]:
    with _cache_lock:
        cached = _cache.get(key.alias)
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1], None
    try:
        upstream = _fetch(key)
    except (requests.RequestException, ValueError) as error:
        logger.warning("chat model list failed for %s: %s", key.alias, type(error).__name__)
        return (cached[1] if cached else {}), "模型能力获取失败"
    with _cache_lock:
        _cache[key.alias] = (now, upstream)
    return upstream, None


def _models_for(key: keys.KeySpec, now: float) -> tuple[list[dict], str | None]:
    upstream, error = _upstream_for(key, now)
    rows = []
    for model in enabled_text_models(key):
        info = upstream.get(model.id)
        if info is not None and not info["agent"]:
            continue
        rows.append({"alias": key.alias, "model": model.id, "name": model.name or model.id,
                     "reasoning": info["reasoning"] if info else None})
    return rows, error


def list_chat_models() -> dict:
    """Every configured key's enabled agent-capable text models; failures are reported per key."""
    candidates = [
        key for key in keys.read_keys_db().keys
        if key.provider in CHAT_PROVIDERS and (key.base_url or key.provider == "openai")
        and enabled_text_models(key)
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
