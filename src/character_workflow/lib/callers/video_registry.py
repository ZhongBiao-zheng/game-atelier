"""视频协议适配器注册表 + 启发式解析器。

每个协议 = 一个 VideoAdapter(protocol id + 友好名 + render 调用)。render 经薄
lazy wrapper 转发到现有 *_video.render_video，避免导入本模块即拉起 requests 重依赖。

resolve_protocol 是唯一启发式来源：迁移回填(keys._backfill_model_protocols)、
KeyForm guess(models-preview)、dispatch 兜底(callers.dispatch_video)三处共用。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from character_workflow.lib import keys as _keys


@dataclass(frozen=True)
class VideoAdapter:
    protocol: str
    label: str
    render: Callable[..., list[str]]


def _seedance_render(**kw: Any) -> list[str]:
    from . import volcengine_video
    return volcengine_video.render_video(**kw)


def _kling_render(**kw: Any) -> list[str]:
    from . import kling_video
    return kling_video.render_video(**kw)


def _dashscope_render(**kw: Any) -> list[str]:
    from . import happyhorse_video
    return happyhorse_video.render_video(**kw)


def _openrouter_render(**kw: Any) -> list[str]:
    from . import openrouter_video
    return openrouter_video.render_video(**kw)


VIDEO_ADAPTERS: dict[str, VideoAdapter] = {
    "seedance": VideoAdapter("seedance", "Seedance(火山 / Ark)", _seedance_render),
    "kling": VideoAdapter("kling", "可灵 Kling", _kling_render),
    "dashscope": VideoAdapter("dashscope", "DashScope(happyhorse / 阿里百炼)", _dashscope_render),
    "openrouter": VideoAdapter("openrouter", "OpenRouter", _openrouter_render),
}


def resolve_protocol(provider: str, base_url: str | None, model: str) -> str | None:
    """旧 dispatch_video 路由规则的等价收敛——返回视频协议 id 或 None（不可路由）。

    规则与历史一一对应，故回填后命名 provider 行为逐字节不变。
    """
    m = (model or "").lower()
    if provider == "seedance":
        return "seedance"
    # OpenRouter 全部视频模型走同一异步 job API，与模型无关。
    if provider == "openrouter":
        return "openrouter"
    if provider == "tokendance":
        if "seedance" in m:
            return "seedance"
        if "happyhorse" in m:
            return "dashscope"
        return None
    if m.startswith("kling") and _keys.is_openai_hk(base_url):
        return "kling"
    return None
