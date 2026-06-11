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


def dispatch_video(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Any,
    params: dict[str, Any] | None = None,
    **kwargs: Any,
) -> list[str]:
    """视频派发 —— 按 provider 路由到对应视频 caller。

    seedance = 火山 Ark 直连；tokendance = 词元跳动网关（seedance 系模型复用
    volcengine_video，仅任务 URL 不同）；kling* 模型挂在 OpenAI-HK 聚合 key
    （provider=custom）下，按「模型前缀 + HK base_url」路由到 kling 异步任务通道。
    veo/pixverse 等留作后续家族。不复用 dispatch() 的图片 provider 分支（那套是同步图片通道）。

    Returns list[str] of generated .mp4 paths.
    """
    key = _keys.find_by_alias(alias)
    if key is None:
        raise NoSuchKeyError(alias)
    if key.provider == "seedance":
        from . import volcengine_video
        return volcengine_video.render_video(
            prompt=prompt, model=model, alias=alias,
            output_dir=output_dir, params=params, **kwargs,
        )
    if key.provider == "tokendance":
        # 词元跳动网关的 Seedance 协议与 Ark 直连同构（content[] + role），仅 URL 不同
        # （volcengine_video._tasks_url 按 base 判别）；happyhorse 走 DashScope 协议转发
        # （happyhorse_video._api_root 同样按 base 判别）；vidu 等其余视频协议未接通。
        if "seedance" in (model or "").lower():
            from . import volcengine_video
            return volcengine_video.render_video(
                prompt=prompt, model=model, alias=alias,
                output_dir=output_dir, params=params, **kwargs,
            )
        if "happyhorse" in (model or "").lower():
            from . import happyhorse_video
            return happyhorse_video.render_video(
                prompt=prompt, model=model, alias=alias,
                output_dir=output_dir, params=params, **kwargs,
            )
        raise WrongProviderError(
            f"词元跳动视频暂只支持 seedance / happyhorse 系模型，收到 {model!r}"
        )
    if (model or "").lower().startswith("kling") and _keys.is_openai_hk(key.base_url):
        from . import kling_video
        return kling_video.render_video(
            prompt=prompt, model=model, alias=alias,
            output_dir=output_dir, params=params, **kwargs,
        )
    raise WrongProviderError(f"video provider not wired: {key.provider!r}")


__all__ = [
    "dispatch",
    "dispatch_video",
    "stubs",
    "NoSuchKeyError",
    "WrongProviderError",
]
