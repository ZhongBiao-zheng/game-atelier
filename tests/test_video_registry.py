"""视频协议注册表 + 启发式解析器。"""
from __future__ import annotations

from character_workflow.lib.callers.video_registry import (
    VIDEO_ADAPTERS,
    resolve_protocol,
)


def test_registry_has_six_protocols_with_labels():
    assert set(VIDEO_ADAPTERS) == {"seedance", "kling", "klingai", "evolink", "dashscope", "openrouter"}
    for pid, adapter in VIDEO_ADAPTERS.items():
        assert adapter.protocol == pid
        assert adapter.label  # 非空友好名
        assert callable(adapter.render)


def test_resolve_protocol_matches_existing_routing_rules():
    # seedance provider 直连
    assert resolve_protocol("seedance", "https://ark.cn-beijing.volces.com/api/v3", "x") == "seedance"
    # tokendance 网关按模型名分叉
    assert resolve_protocol("tokendance", "https://tokendance.space/gateway/v1", "doubao-seedance-2-0") == "seedance"
    assert resolve_protocol("tokendance", "https://tokendance.space/gateway/v1", "happyhorse-1.0-t2v") == "dashscope"
    assert resolve_protocol("tokendance", "https://tokendance.space/gateway/v1", "vidu-x") is None
    # kling 仅「模型前缀 kling + HK 域名」
    assert resolve_protocol("custom", "https://api.openai-hk.com/v1", "kling-v2-6") == "kling"
    assert resolve_protocol("custom", "https://api.openai-hk.com/v1", "gpt-image-2") is None
    # 任意纯自定义端点 → None（须用户显式选协议）
    assert resolve_protocol("custom", "https://api.example.com/v1", "foo-video-1") is None
    # openrouter 全模型走同一异步 job 协议
    assert resolve_protocol("openrouter", "https://openrouter.ai/api/v1", "google/veo-3.1") == "openrouter"


def test_resolve_protocol_routes_kling_3_and_4_per_channel():
    td = "https://tokendance.space/gateway/v1"
    for model in ("kling-4.0", "kling-4.0-flash", "kling-3.0", "kling-3.0-turbo", "kling-3.0-omni"):
        assert resolve_protocol("tokendance", td, model) == "klingai"
    # 词元跳动的可灵特效 / 数字人 / TTS 是别的协议，不能混进视频生成。
    for model in ("kling-effects", "kling-avatar-image2video", "kling-tts"):
        assert resolve_protocol("tokendance", td, model) is None
    assert resolve_protocol("custom", "https://api.tu-zi.com/v1", "kling-4.0") == "klingai"
    assert resolve_protocol("evolink", "https://api.evolink.ai/v1", "kling-v4-flash-text-to-video") == "evolink"
    assert resolve_protocol("evolink", "https://api.evolink.ai/v1", "mj-v8.2") is None
    # HK 旧版接口保留原协议。
    assert resolve_protocol("custom", "https://api.openai-hk.com/v1", "kling-v2-6") == "kling"
