import pytest

from character_workflow.lib.image_size import (
    normalize_image_size_params,
    supports_auto_image_size,
)
from character_workflow.lib.keys import KeySpec


def _key(provider="openai", base_url=None):
    return KeySpec(alias="test", provider=provider, base_url=base_url,
                   access_key="fake", created_at="2026-09-09T00:00:00Z")


@pytest.mark.parametrize("model", ["gpt-image-2.5", "gpt-image-2.5-flare",
                                  "gpt-image-2.5-sunburst", "gpt-image-2.5-vip"])
@pytest.mark.parametrize("quality", ["low", "medium", "high", "xhigh", "max"])
@pytest.mark.parametrize("mode", ["ratio", "custom"])
def test_tuzi_gpt25_preserves_quality_without_resolution_tiers(model, quality, mode):
    key = _key("custom", "https://api.tu-zi.com").model_copy(update={"billing_group": "default"})
    result = normalize_image_size_params(key, model, {
        "size_mode": mode, "size": "2048x2048", "ratio": "1:1",
        "resolution": "2K", "quality": quality,
    })
    assert result["quality"] == quality
    assert "resolution" not in result
    assert result["size"] == "2048x2048"
    assert normalize_image_size_params(key, model, result) == result


def test_tuzi_default_auto_ignores_inactive_tiers_and_other_groups_unchanged():
    key = _key("custom", "https://api.tu-zi.com").model_copy(update={"billing_group": "default"})
    params = {"size_mode": "auto", "size": "auto", "resolution": "4K", "quality": "high"}
    assert normalize_image_size_params(key, "gpt-image-2.5-flare", params) == {
        "size_mode": "auto", "size": "auto", "quality": "high",
    }
    key.billing_group = "image"
    assert normalize_image_size_params(key, "gpt-image-2.5-flare", params)["quality"] == "high"


@pytest.mark.parametrize("provider,url,model,supported", [
    ("openai", None, "gpt-image-2", True),
    ("custom", "https://api.openai.com/v1", "gpt-image-2.5-flare", True),
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2", True),
    # 2026-09-17 对两家网关实打 size=auto 都正常出图，从「未验证」改为放行。
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2.5-flare", True),
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2.5-sunburst", True),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2", True),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2.5", True),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2.5-flare", True),
    ("custom", "https://api.tu-zi.com/v1", "gpt-image-2.5-sunburst", True),
    # HK 侧没验过裸 gpt-image-2.5，名单里就不该有它。
    ("custom", "https://api.openai-hk.com/v1", "gpt-image-2.5", False),
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


@pytest.mark.parametrize(("key", "model", "params", "expected"), [
    # Agent 写的草稿只有比例：缺像素时按浏览器同一换算补齐，不能把 size=null 发给厂商。
    (_key("custom", "https://api.tu-zi.com"), "gpt-image-2.5-sunburst",
     {"size_mode": "ratio", "ratio": "16:9"}, "2048x1152"),
    (_key("custom", "https://api.tu-zi.com"), "gpt-image-2.5-sunburst",
     {"size_mode": "ratio", "ratio": "9:16"}, "1152x2048"),
    (_key("custom", "https://api.tu-zi.com"), "gpt-image-2",
     {"size_mode": "ratio", "ratio": "3:2", "resolution": "1K"}, "1024x688"),
    (_key("custom", "https://api.tu-zi.com"), "doubao-seedream-4-5-251128",
     {"size_mode": "ratio", "ratio": "16:9", "resolution": "4K"}, "4096x2304"),
    (_key("tokendance"), "seedream-5.0-pro",
     {"size_mode": "ratio", "ratio": "1:1"}, "2150x2150"),
])
def test_ratio_mode_without_size_derives_pixels(key, model, params, expected):
    result = normalize_image_size_params(key, model, params)
    assert result["size"] == expected
    assert normalize_image_size_params(key, model, result) == result
