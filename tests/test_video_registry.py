"""视频协议注册表 + 启发式解析器。"""
from __future__ import annotations

from character_workflow.lib.callers.video_registry import (
    VIDEO_ADAPTERS,
    resolve_protocol,
)


def test_registry_has_three_protocols_with_labels():
    assert set(VIDEO_ADAPTERS) == {"seedance", "kling", "dashscope"}
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
