"""Zhenzhen key selection helpers."""
from __future__ import annotations

import time
from dataclasses import dataclass

from character_workflow.lib import keys


class ZhenzhenKeyError(RuntimeError):
    pass


_CATEGORY_HINTS: dict[str, tuple[str, ...]] = {
    "gpt_image": ("gpt-image", "gpt2", "gpt_image", "gptimage"),
    "nano_banana": ("nano-banana", "nano_banana", "nanobanana"),
    "mj": ("midjourney", "mj-", "mj_", "mj/", "mj"),
    "veo": ("veo",),
    "grok": ("grok",),
    "seedance": ("seedance",),
    "suno": ("suno", "chirp"),
}


@dataclass(frozen=True)
class TaskAliasRecord:
    alias: str
    expires_at: float


_TASK_ALIAS_TTL_SECONDS = 30 * 60
_TASK_ALIAS_MAP: dict[str, TaskAliasRecord] = {}


def classify_model_hint(model_hint: str) -> str | None:
    m = str(model_hint or "").lower()
    if not m:
        return None
    for category, hints in _CATEGORY_HINTS.items():
        if any(hint in m for hint in hints):
            return category
    return None


def _is_zhenzhen(k: keys.KeySpec) -> bool:
    return k.provider == "custom" and (
        "t8star" in str(k.base_url or "").lower()
        or "zhenzhen" in str(k.alias or "").lower()
        or k.routing_category is not None
        or bool(k.routing_hints)
    )


def _matches_category(k: keys.KeySpec, category: str | None, model_hint: str) -> bool:
    if not category:
        return False
    if k.routing_scope != "classified":
        return False
    if k.routing_category == category:
        return True
    m = str(model_hint or "").lower()
    return any(str(h).lower() in m for h in k.routing_hints)


def pick_key(*, model_hint: str, alias: str | None = None) -> keys.KeySpec:
    db = keys.read_keys_db()
    zhenzhen_keys = [k for k in db.keys if _is_zhenzhen(k)]
    category = classify_model_hint(model_hint)
    if alias:
        selected = next((k for k in zhenzhen_keys if k.alias == alias), None)
        if selected is None:
            raise ZhenzhenKeyError(f"alias {alias!r} 不是可用的自定义 Zhenzhen/T8star Key")
        if selected.routing_scope == "classified":
            return selected
        classified = next(
            (k for k in zhenzhen_keys if _matches_category(k, category, model_hint)),
            None,
        )
        if classified:
            return classified
        return selected

    selected = next((k for k in zhenzhen_keys if _matches_category(k, category, model_hint)), None)
    if selected:
        return selected

    if db.default_alias:
        default = next(
            (
                k
                for k in zhenzhen_keys
                if k.alias == db.default_alias and k.routing_scope == "general"
            ),
            None,
        )
        if default:
            return default

    general = next((k for k in zhenzhen_keys if k.routing_scope == "general"), None)
    if general:
        return general

    label = category or "图像"
    raise ZhenzhenKeyError(f"未配置 {label} 专属自定义 Zhenzhen/T8star Key，且通用自定义 Key 也为空")


def remember_task_alias(task_id: str, alias: str) -> None:
    if not task_id or not alias:
        return
    _TASK_ALIAS_MAP[str(task_id)] = TaskAliasRecord(
        alias=alias,
        expires_at=time.time() + _TASK_ALIAS_TTL_SECONDS,
    )


def recall_task_alias(task_id: str) -> str | None:
    record = _TASK_ALIAS_MAP.get(str(task_id))
    if record is None:
        return None
    if record.expires_at < time.time():
        _TASK_ALIAS_MAP.pop(str(task_id), None)
        return None
    return record.alias
