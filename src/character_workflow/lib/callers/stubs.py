"""Placeholder render functions for non-lovart providers.

Each stub raises NotImplementedError. They exist so dispatch() can route by
provider name today and we only need to fill in the actual subprocess wiring
when a provider is enabled.
"""
from __future__ import annotations


def openai_render(**_kwargs) -> list[str]:
    raise NotImplementedError("openai provider not yet wired")


def midjourney_render(**_kwargs) -> list[str]:
    raise NotImplementedError("midjourney provider not yet wired")


def nano_banana_render(**_kwargs) -> list[str]:
    raise NotImplementedError("nano_banana provider not yet wired")


def seedream_render(**_kwargs) -> list[str]:
    from character_workflow.lib.callers import openai_image
    return openai_image.render(**_kwargs)


def custom_render(**_kwargs) -> list[str]:
    from character_workflow.lib.callers import openai_image
    return openai_image.render(**_kwargs)
