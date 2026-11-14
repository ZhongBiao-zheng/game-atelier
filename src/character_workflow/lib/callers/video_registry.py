"""视频协议适配器注册表 + 启发式解析器。

每个协议 = 一个 VideoAdapter(protocol id + 友好名 + render 调用)。render 经薄
lazy wrapper 转发到现有 *_video.render_video，避免导入本模块即拉起 requests 重依赖。

resolve_protocol 是唯一启发式来源：迁移回填(keys._backfill_model_protocols)、
KeyForm guess(models-preview)、dispatch 兜底(callers.dispatch_video)三处共用。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from character_workflow.lib import keys as _keys
from character_workflow.lib.video_caps import kling_spec


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


def _klingai_render(**kw: Any) -> list[str]:
    from . import klingai_video
    return klingai_video.render_video(**kw)


def _evolink_render(**kw: Any) -> list[str]:
    from . import evolink_video
    return evolink_video.render_video(**kw)


def _dashscope_render(**kw: Any) -> list[str]:
    from . import happyhorse_video
    return happyhorse_video.render_video(**kw)


def _openrouter_render(**kw: Any) -> list[str]:
    from . import openrouter_video
    return openrouter_video.render_video(**kw)


def _declarative_render(**kw: Any) -> list[str]:
    from . import declarative
    return declarative.render_video(**kw)


VIDEO_ADAPTERS: dict[str, VideoAdapter] = {
    "declarative": VideoAdapter("declarative", "自定义接口", _declarative_render),
    "seedance": VideoAdapter("seedance", "Seedance(火山 / Ark)", _seedance_render),
    "kling": VideoAdapter("kling", "可灵 Kling（OpenAI-HK 旧版接口）", _kling_render),
    "klingai": VideoAdapter("klingai", "可灵 Kling 3.0 / 4.0（新版接口）", _klingai_render),
    "evolink": VideoAdapter("evolink", "EvoLink（可灵）", _evolink_render),
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
        if kling_spec(m) is not None:
            return "klingai"
        return None
    if provider == "evolink":
        return "evolink" if kling_spec(m) is not None else None
    if m.startswith("kling") and _keys.is_openai_hk(base_url):
        return "kling"
    # 兔子：kling-4.0 挂在统一视频入口 /v1/videos，请求体与可灵新版接口同形。
    if kling_spec(m) is not None and _is_tuzi(base_url):
        return "klingai"
    return None


def _is_tuzi(base_url: str | None) -> bool:
    host = (urlsplit(str(base_url or "")).hostname or "").lower()
    return host == "tu-zi.com" or host.endswith(".tu-zi.com")
