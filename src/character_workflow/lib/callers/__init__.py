"""Caller dispatch protocol — route render requests by alias to provider impls.

dispatch(prompt, model, alias, **kwargs) looks up the key by alias, then routes
to the appropriate provider's `render()` function. OpenAI-compatible providers
(openai / seedream / custom) go through openai_image; others raise
NotImplementedError until wired up.
"""
from __future__ import annotations

from typing import Any

from character_workflow.lib import keys as _keys

from . import stubs


class NoSuchKeyError(Exception):
    """Raised when dispatch() can't find an alias in keys.json."""


class WrongProviderError(Exception):
    """Raised when a caller is invoked with an alias of the wrong provider."""


def _provider_render(key: _keys.KeySpec):
    """Resolve provider name → render function, fresh each call.

    Re-read via attribute so monkeypatch on provider `render` takes effect.
    """
    provider = key.provider
    if provider == "openai":
        return stubs.openai_render
    if provider == "midjourney":
        return stubs.midjourney_render
    if provider == "nano_banana":
        return stubs.nano_banana_render
    if provider == "seedream":
        return stubs.seedream_render
    if provider == "tokendance":
        return stubs.tokendance_render
    if provider == "custom":
        return stubs.custom_render
    return None


def dispatch(
    *,
    prompt: str,
    model: str,
    alias: str,
    **kwargs: Any,
) -> list[str]:
    """Look up `alias` in keys.json, route to that provider's render().

    Returns list[str] of generated output paths. Each provider's render is
    responsible for normalising its own response shape into list[str].

    Raises:
        NoSuchKeyError: alias not present in keys.json.
        NotImplementedError: provider stub not yet wired.
        ValueError / WrongProviderError: provider mismatch handled by render().
    """
    key = _keys.find_by_alias(alias)
    if key is None:
        raise NoSuchKeyError(alias)
    fn = _provider_render(key)
    if fn is None:
        raise WrongProviderError(f"unknown provider {key.provider!r}")
    return fn(prompt=prompt, model=model, alias=alias, **kwargs)


def _effective_protocol(key: _keys.KeySpec, model: str) -> str | None:
    """优先用模型已存 protocol（迁移回填 / 用户显式选），未注册模型回退到同一启发式。"""
    from .video_registry import resolve_protocol
    spec = next((m for m in key.models if m.id == model), None)
    if spec and spec.protocol:
        return spec.protocol
    return resolve_protocol(key.provider, key.base_url, model)


def dispatch_video(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Any,
    params: dict[str, Any] | None = None,
    **kwargs: Any,
) -> list[str]:
    """视频派发 —— 按模型协议从注册表路由到对应视频 caller。

    协议来源：模型已存 protocol（read_keys_db 读时回填，或用户在 KeyForm 显式选）
    优先；未注册到 key.models 的模型回退 resolve_protocol 计算（同一启发式）。
    无可解析协议 → 诚实报错指向修复路径，绝不再沉到 caller 才崩。

    Returns list[str] of generated .mp4 paths.
    """
    from .video_registry import VIDEO_ADAPTERS

    key = _keys.find_by_alias(alias)
    if key is None:
        raise NoSuchKeyError(alias)
    protocol = _effective_protocol(key, model)
    if not protocol:
        raise WrongProviderError(
            f"无法识别视频模型 {model!r} 的接口协议（支持 seedance / kling / dashscope 系），"
            "请确认模型 id 与供应商配置"
        )
    adapter = VIDEO_ADAPTERS.get(protocol)
    if adapter is None:
        raise WrongProviderError(f"未知视频协议 {protocol!r}（模型 {model!r}）")
    return adapter.render(
        prompt=prompt, model=model, alias=alias,
        output_dir=output_dir, params=params, **kwargs,
    )


__all__ = [
    "dispatch",
    "dispatch_video",
    "stubs",
    "NoSuchKeyError",
    "WrongProviderError",
]
