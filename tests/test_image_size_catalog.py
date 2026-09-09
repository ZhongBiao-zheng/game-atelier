import base64
import json
from importlib.resources import files

import pytest

from character_workflow.lib.callers import openai_image
from character_workflow.lib.canvas_runs import _normalized_image_preference_params
from character_workflow.lib.image_size import normalize_image_size_params, supports_auto_image_size
from character_workflow.lib.image_size_catalog import image_size_options, is_nano_image_size_model
from character_workflow.lib.keys import KeySpec, ModelSpec


_OPENROUTER_OPTIONS = json.loads(
    files("character_workflow").joinpath("image_size_catalog.json").read_text(encoding="utf-8")
)["openrouter"]


def _key(model, provider="custom", base_url="https://api.tu-zi.com/v1"):
    return KeySpec(
        alias="test", provider=provider, base_url=base_url, access_key="test-key",
        created_at="2026-09-09T00:00:00Z",
        models=[ModelSpec(name=model, id=model, modality="image")],
    )


@pytest.mark.parametrize("model", ["nano-banana-pro", "gemini-3-pro-image-preview"])
@pytest.mark.parametrize("ratio", ["21:9", "4:5", "5:4"])
def test_nano_ratios_survive_preferences_and_freezing(model, ratio):
    key = _key(model)
    preference = _normalized_image_preference_params(
        key, key.models[0], {"size_mode": "ratio", "ratio": ratio},
    )
    frozen = normalize_image_size_params(key, model, preference.model_dump(exclude_none=True))
    assert frozen["size"] == frozen["ratio"] == ratio


def test_hk_nano_only_exposes_verified_ratios():
    options = image_size_options("custom", "https://api.openai-hk.com", "nano-banana")
    assert options["ratios"] == ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2"]


def test_model_normalization_matches_browser_dimensions():
    assert not is_nano_image_size_model("gemini-nonimage")
    assert is_nano_image_size_model("google/gemini-3.1-flash-image-preview")
    assert image_size_options("tokendance", None, "seedream-5.0-pro")["resolutions"] == ["2K"]


def test_openrouter_model_specific_ratios_resolutions_and_unknown_model():
    options = image_size_options("openrouter", None, "google/gemini-3.1-flash-image-preview")
    assert "8:1" in options["ratios"]
    assert options["resolutions"] == ["512", "1K", "2K", "4K"]
    unknown = image_size_options("openrouter", None, "unknown/model")
    assert "auto" not in unknown["ratios"]
    assert len(unknown["ratios"]) == 8
    assert unknown["resolutions"] == []
    assert not supports_auto_image_size("openrouter", "https://openrouter.ai/api/v1", "unknown/model")
    assert supports_auto_image_size(
        "openrouter", "https://openrouter.ai/api/v1", "black-forest-labs/flux.2-pro",
    )


@pytest.mark.parametrize("model,options", _OPENROUTER_OPTIONS.items(), ids=_OPENROUTER_OPTIONS)
def test_every_openrouter_catalog_ratio_and_resolution_survives_freezing(model, options):
    key = _key(model, "openrouter", "https://openrouter.ai/api/v1")
    assert image_size_options(key.provider, key.base_url, model) == options
    if not options["ratios"]:
        frozen = normalize_image_size_params(
            key, model, {"size_mode": "ratio", "ratio": "1:1", "size": "1:1"},
        )
        assert frozen == {}
        return
    for ratio in options["ratios"]:
        if ratio == "auto":
            assert supports_auto_image_size(key.provider, key.base_url, model)
            frozen = normalize_image_size_params(key, model, {"size_mode": "auto"})
            assert frozen == {"size_mode": "auto", "size": "auto"}
            continue
        for resolution in [None, *options["resolutions"]]:
            source = {"size_mode": "ratio", "ratio": ratio, "size": ratio}
            if resolution is not None:
                source["resolution"] = resolution
            preference = _normalized_image_preference_params(key, key.models[0], source)
            frozen = normalize_image_size_params(
                key, model, preference.model_dump(exclude_none=True),
            )
            assert frozen["ratio"] == frozen["size"] == ratio
            assert frozen.get("resolution") == resolution


@pytest.mark.parametrize("model", ["gpt-image-2", "mj_fast_imagine", "doubao-seedream-4-5-251128"])
def test_cli_without_size_mode_keeps_nonpreset_ratio(model):
    source = {"ratio": "7:3", "size": "2240x960"}
    assert normalize_image_size_params(_key(model), model, source) == source


@pytest.mark.parametrize("resolution,expected", [(None, None), ("1k", "1K"), ("4K", "4K")])
def test_openrouter_preferences_preserve_explicit_resolution_only(resolution, expected):
    model = "google/gemini-3-pro-image"
    key = _key(model, "openrouter", "https://openrouter.ai/api/v1")
    source = {"size_mode": "ratio", "ratio": "4:5"}
    if resolution:
        source["resolution"] = resolution
    preference = _normalized_image_preference_params(key, key.models[0], source)
    assert preference.ratio == "4:5"
    assert preference.resolution == expected
    frozen = normalize_image_size_params(key, model, preference.model_dump(exclude_none=True))
    assert frozen.get("resolution") == expected


@pytest.mark.parametrize("params", [
    {"size_mode": "ratio", "ratio": "8:1"},
    {"size_mode": "ratio", "ratio": "4:5", "resolution": "512"},
])
def test_freezing_rejects_unsupported_model_values(params):
    model = "google/gemini-3-pro-image"
    key = _key(model, "openrouter", "https://openrouter.ai/api/v1")
    with pytest.raises(ValueError, match="不支持"):
        normalize_image_size_params(key, model, params)


def test_canonical_gemini_rejects_custom_pixels_without_changing_family():
    model = "gemini-3-pro-image-preview"
    assert openai_image.image_family(model) == "standard"
    with pytest.raises(ValueError, match="自定义"):
        normalize_image_size_params(_key(model), model, {"size_mode": "custom", "size": "2048x2048"})


@pytest.mark.parametrize("mode", ["ratio", "auto", "custom"])
def test_model_without_dimensions_drops_size_controls(mode):
    model = "meta/muse-image"
    key = _key(model, "openrouter", "https://openrouter.ai/api/v1")
    params = {"size_mode": mode, "ratio": "1:1", "size": "1:1", "resolution": "2K", "n": 1}
    assert normalize_image_size_params(key, model, params) == {"n": 1}
    preference = _normalized_image_preference_params(key, key.models[0], params)
    assert preference.model_dump(exclude_none=True) == {"n": 1}


@pytest.mark.parametrize("base_url,model,ratio,outbound", [
    ("https://api.tu-zi.com/v1", "nano-banana-pro", "21:9", "21x9"),
    ("https://api.tu-zi.com/v1", "gemini-3-pro-image-preview", "5:4", "5x4"),
    ("https://api.openai-hk.com/v1", "nano-banana", "9:16", "9x16"),
    ("https://example.com/v1", "nano-banana", "9:16", "9:16"),
])
def test_gateway_ratio_translation_only_changes_outbound_request(
    monkeypatch, tmp_path, base_url, model, ratio, outbound,
):
    key = _key(model, base_url=base_url)
    monkeypatch.setattr("character_workflow.lib.keys.find_by_alias", lambda alias: key)
    captured = []

    def fake_post(url, api_key, payload, **kwargs):
        captured.append(payload)
        return {"data": [{"b64_json": base64.b64encode(b"image").decode()}]}

    monkeypatch.setattr(openai_image, "_post_json", fake_post)
    monkeypatch.setattr(openai_image.tuzi_async, "execute_json", lambda **kwargs: fake_post(
        kwargs["url"], kwargs["api_key"], kwargs["payload"],
    ))
    params = {"size": ratio, "ratio": ratio}
    openai_image.render(prompt="test", model=model, alias="test", output_dir=tmp_path, params=params)
    assert captured[0]["size"] == outbound
    assert params["size"] == params["ratio"] == ratio
