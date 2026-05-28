"""Caller dispatch protocol — route render requests by alias to provider impls.

dispatch(prompt, model, alias, **kwargs) looks up the key by alias, then routes
to the appropriate provider's `render()` function (lovart for now; others raise
NotImplementedError until wired up).

Lovart-specific symbols are re-exported here so existing call sites can write
`from character_workflow.lib.callers import lovart` and access submit_and_wait /
upload_files / LovartResult etc.
"""
from __future__ import annotations

from typing import Any

from character_workflow.lib import keys as _keys

from . import lovart, stubs, zhenzhen

# Re-export lovart public surface (compat with old lovart_caller import paths).
LovartError = lovart.LovartError
LovartTimeout = lovart.LovartTimeout
LovartResult = lovart.LovartResult
DEFAULT_LOVART_CLI = lovart.DEFAULT_LOVART_CLI
submit_and_wait = lovart.submit_and_wait
upload_files = lovart.upload_files


class NoSuchKeyError(Exception):
    """Raised when dispatch() can't find an alias in keys.json."""


class WrongProviderError(Exception):
    """Raised when a caller is invoked with an alias of the wrong provider."""


def _is_zhenzhen_custom_key(key: _keys.KeySpec) -> bool:
    return key.provider == "custom" and (
        "t8star" in str(key.base_url or "").lower()
        or "zhenzhen" in str(key.alias or "").lower()
        or key.routing_category is not None
        or bool(key.routing_hints)
    )


def _provider_render(key: _keys.KeySpec):
    """Resolve provider name → render function, fresh each call.

    Re-read via attribute so monkeypatch on `callers.lovart.render` takes effect.
    """
    provider = key.provider
    if provider == "lovart":
        return lovart.render
    if provider == "openai":
        return stubs.openai_render
    if provider == "midjourney":
        return stubs.midjourney_render
    if provider == "nano_banana":
        return stubs.nano_banana_render
    if provider == "seedream":
        return stubs.seedream_render
    if provider == "custom":
        if _is_zhenzhen_custom_key(key):
            return zhenzhen.render
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


__all__ = [
    "dispatch",
    "lovart",
    "stubs",
    "NoSuchKeyError",
    "WrongProviderError",
    # Lovart compat re-exports
    "LovartError",
    "LovartTimeout",
    "LovartResult",
    "DEFAULT_LOVART_CLI",
    "submit_and_wait",
    "upload_files",
]
