import pytest

from character_workflow.lib.image_size import (
    normalize_image_size_params,
    supports_auto_image_size,
)
from character_workflow.lib.keys import KeySpec


def _key(provider="openai", base_url=None):
    return KeySpec(alias="test", provider=provider, base_url=base_url,
                   access_key="fake", created_at="2026-09-09T00:00:00Z")


@pytest.mark.parametrize("provider,url,model,supported", [
    ("openai", None, "gpt-image-2", True),
    ("custom", "https://api.openai.com/v1", "gpt-image-2.5-flare", True),
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2", True),
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2.5-flare", False),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2", True),
    ("openai", "https://api.tu-zi.com/v1", "gpt-image-1.5", True),
    ("custom", "https://tu-zi.com/v1", "gpt-image-1", True),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2-vip", False),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2-1k", False),
    ("custom", "https://api.tu-zi.com/v1", "nano-banana-pro", False),
    ("custom", "https://tu-zi.com.example/v1", "gpt-image-2", False),
    ("openai", "https://other.example/v1", "gpt-image-2", False),
    ("custom", "https://openai-hk.com.example/v1", "gpt-image-2", False),
    ("openrouter", "https://openrouter.ai/api/v1", "openai/gpt-image-2.5-sunburst", True),
    ("openrouter", None, "openai/gpt-image-2.5-sunburst", False),
    ("openrouter", "https://openrouter.ai/api/v1", "openai/gpt-image-1", True),
    ("openrouter", "https://other.example/v1", "openai/gpt-image-2", False),
    ("openrouter", None, "unverified/image", False),
    ("openai", None, "gpt-image-future", False),
])
def test_auto_requires_verified_channel_and_model(provider, url, model, supported):
    assert supports_auto_image_size(provider, url, model) is supported


def test_auto_freeze_discards_inactive_dimensions_but_keeps_quality():
    source = {"size_mode": "auto", "size": "1360x2048", "ratio": "2:3",
              "resolution": "4K", "custom_size": "1600x2000", "quality": "high"}
    assert normalize_image_size_params(_key(), "gpt-image-2", source) == {
        "size_mode": "auto", "size": "auto", "quality": "high",
    }
    assert source["size"] == "1360x2048"


def test_custom_freeze_snaps_hk_and_drops_ratio_and_draft_cache():
    params = normalize_image_size_params(_key("custom", "https://api.openai-hk.com/v1"),
        "gpt-image-2", {"size_mode": "custom", "size": "1360x2048",
                        "ratio": "2:3", "resolution": "2K", "custom_size": "1360x2048"})
    assert params == {"size_mode": "custom", "size": "1376x2064"}


@pytest.mark.parametrize("size", [None, "", "x2048", "2048x", "0x1024", "-1x1024", "auto", "2:3"])
def test_custom_freeze_rejects_incomplete_dimensions(size):
    with pytest.raises(ValueError, match="自定义宽度和高度"):
        normalize_image_size_params(_key(), "gpt-image-2", {
            "size_mode": "custom", "size": size, "custom_size": "1024x1024",
        })


def test_legacy_auto_is_not_reinterpreted_as_explicit_mode():
    params = {"size": "auto", "ratio": "2:3"}
    assert normalize_image_size_params(_key("custom"), "unverified", params) == params


def test_explicit_auto_rejects_unknown_channel():
    with pytest.raises(ValueError, match="尚未确认支持 AUTO"):
        normalize_image_size_params(_key("custom", "https://unknown.example/v1"),
                                    "gpt-image-2", {"size_mode": "auto"})


@pytest.mark.parametrize("size,message", [
    ("1x2048", "比例不能超过"), ("4096x1024", "比例不能超过"),
    ("100001x100001", "不能超过 100000"),
])
def test_custom_gpt_dimensions_reject_out_of_bounds_before_normalizing(size, message):
    with pytest.raises(ValueError, match=message):
        normalize_image_size_params(_key(), "gpt-image-2", {"size_mode": "custom", "size": size})
