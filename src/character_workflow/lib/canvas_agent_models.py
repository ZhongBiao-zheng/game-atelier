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
from character_workflow.lib.callers.openai_compat import key_api_root
from character_workflow.lib.llm_protocols import (
    ANTHROPIC_MESSAGES, GEMINI_GENERATE_CONTENT, TEXT_PROTOCOLS, speaks_openai,
)
from character_workflow.lib.llm_protocols import anthropic, gemini

logger = logging.getLogger(__name__)

CHAT_PROVIDERS = frozenset({"openai", "openrouter", "custom", "seedream", "tokendance", "atelier"})
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
    return key_api_root(key)


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


def agent_can_use(model: keys.ModelSpec | None) -> bool:
    """Agent 能接的协议与一次性调用相同（ADR-0044）：OpenAI Chat / Responses 原样，Anthropic 经协议转换。
    原样存下的未知标注（如 `anthropic:messages`）不能用。KEY 里没登记的模型按未标注处理（OpenAI 格式）。"""
    return model is None or model.protocol in TEXT_PROTOCOLS


def enabled_text_models(key: keys.KeySpec) -> list[keys.ModelSpec]:
    """用户在这把 Key 里启用的文本模型；未标模态的模型只在 Key 只开了 llm 时算文本。"""
    llm_only = set(key.modalities) == {"llm"}
    return [model for model in key.models
            if model.modality == "text" or (model.modality is None and llm_only)]


def _fetch(key: keys.KeySpec) -> dict[str, dict]:
    """上游 /models 里每个模型的能力：{id: {"agent": bool, "reasoning": bool | None}}。

    按这把 KEY 里文本模型的协议分别拉：OpenAI 格式的用 Bearer 拉 `{root}/models`；Anthropic 的按 Anthropic 的鉴权头
    拉 `{root}/v1/models`；Gemini 的按 `x-goog-api-key` 拉 `{root}/v1beta/models`（ADR-0044）。没有 OpenAI 格式
    模型的 KEY 不发 Bearer 那一次。"""
    from character_workflow.lib.callers.atelier_gateway import DIRECT_PROXIES

    models = enabled_text_models(key)
    out: dict[str, dict] = {}
    if any(speaks_openai(model.protocol) for model in models):
        response = requests.get(
            f"{chat_base_url(key)}/models",
            headers={"Authorization": f"Bearer {key.access_key}"},
            timeout=FETCH_TIMEOUT,
            **({"proxies": DIRECT_PROXIES} if key.provider == "atelier" else {}),
        )
        response.raise_for_status()
        data = response.json().get("data") or []
        out.update({
            str(item["id"]): {"agent": is_chat_model(item), "reasoning": _supports_reasoning(item)}
            for item in data if isinstance(item, dict) and item.get("id")
        })
    if key.base_url and any(model.protocol == ANTHROPIC_MESSAGES for model in models):
        # Anthropic 的对话模型都支持工具；首版不开思考（飙哥定 Q2），思考档位不显示。带密钥不跟随重定向。
        response = requests.get(f"{anthropic.models_url(key.base_url)}?limit=1000",
                                headers=anthropic.headers(key.base_url, key.access_key),
                                timeout=FETCH_TIMEOUT, allow_redirects=False)
        response.raise_for_status()
        data = response.json().get("data") or []
        out.update({str(item["id"]): {"agent": True, "reasoning": False}
                    for item in data if isinstance(item, dict) and item.get("id")})
    if key.base_url and any(model.protocol == GEMINI_GENERATE_CONTENT for model in models):
        # 首版不开思考控制；New API 的 supportedGenerationMethods 是空数组，非空时才要求 generateContent。
        response = requests.get(f"{gemini.models_url(key.base_url)}?pageSize=1000",
                                headers=gemini.headers(key.access_key),
                                timeout=FETCH_TIMEOUT, allow_redirects=False)
        response.raise_for_status()
        for item in response.json().get("models") or []:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            methods = item.get("supportedGenerationMethods") or []
            out[str(item["name"]).removeprefix("models/")] = {
                "agent": not methods or "generateContent" in methods, "reasoning": False}
    return out


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
        if not agent_can_use(model):
            continue
        info = upstream.get(model.id)
        if info is not None and not info["agent"]:
            continue
        # Anthropic、Gemini 首版不开思考：列表里没拉到也标成不支持，面板不显示思考档位。
        reasoning = (False if model.protocol in (ANTHROPIC_MESSAGES, GEMINI_GENERATE_CONTENT)
                     else (info["reasoning"] if info else None))
        rows.append({"alias": key.alias, "model": model.id, "name": model.name or model.id,
                     "reasoning": reasoning})
    return rows, error


def list_chat_models() -> dict:
    """Every configured key's enabled agent-capable text models; failures are reported per key."""
    candidates = [
        key for key in keys.read_keys_db().keys
        if key.enabled and key.provider in CHAT_PROVIDERS and (key.base_url or key.provider == "openai")
        and any(agent_can_use(model) for model in enabled_text_models(key))
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
