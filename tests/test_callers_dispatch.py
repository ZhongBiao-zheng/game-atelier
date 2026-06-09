"""Alias-based caller dispatch protocol.

Verifies:
1. dispatch routes openai / custom 聚合 aliases to the right render fn
2. dispatch("missing") raises NoSuchKeyError
3. video-only provider keys can be stored without dispatch regression
"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import NoSuchKeyError, dispatch
from character_workflow.lib.keys import KeySpec


@pytest.fixture
def isolated_keys_db(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / ".runtime").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _add(alias: str, provider: str, **overrides) -> KeySpec:
    spec = KeySpec(
        alias=alias,
        provider=provider,  # type: ignore[arg-type]
        base_url=overrides.pop("base_url", None),
        access_key=overrides.pop("access_key", "AK-" + alias),
        secret_key=overrides.pop("secret_key", "SK-" + alias),
        capabilities=overrides.pop("capabilities", ["portrait"]),
        models=overrides.pop("models", []),
        routing_scope=overrides.pop("routing_scope", "general"),
        routing_category=overrides.pop("routing_category", None),
        routing_hints=overrides.pop("routing_hints", []),
        notes=overrides.pop("notes", ""),
        created_at=overrides.pop("created_at", "2026-05-22T00:00:00Z"),
    )
    keys.add_key(spec)
    return spec


def test_dispatch_routes_custom_aggregator_alias_to_aggregator_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("zz-main", "custom", routing_scope="classified", routing_category="gpt_image")
    captured = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return ["/tmp/zz-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.aggregator.render",
        fake_render,
    )

    out_dir = tmp_path / "out"
    paths = dispatch(
        prompt="fox",
        model="gpt-image-2-all",
        alias="zz-main",
        output_dir=out_dir,
    )

    assert paths == ["/tmp/zz-v1.png"]
    assert captured["alias"] == "zz-main"
    assert captured["prompt"] == "fox"
    assert captured["model"] == "gpt-image-2-all"
    assert captured["kwargs"]["output_dir"] == out_dir


def test_dispatch_openai_hk_custom_key_routes_to_openai_image_not_aggregator(
    isolated_keys_db, tmp_path, monkeypatch,
):
    """OpenAI-HK 即便配了 routing 也必须走 openai_image 同步通道，不进 aggregator。"""
    _add(
        "hk", "custom",
        base_url="https://api.openai-hk.com/v1",
        routing_scope="classified", routing_category="gpt_image",
    )
    seen = {}

    def fake_openai_render(*, prompt, model, alias, **kwargs):
        seen["where"] = "openai_image"
        seen["alias"] = alias
        return ["/tmp/hk-v1.png"]

    def fake_aggregator_render(*, prompt, model, alias, **kwargs):
        seen["where"] = "aggregator"
        return ["/tmp/agg-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.openai_image.render", fake_openai_render
    )
    monkeypatch.setattr(
        "character_workflow.lib.callers.aggregator.render", fake_aggregator_render
    )

    paths = dispatch(
        prompt="x", model="gpt-image-2", alias="hk", output_dir=tmp_path / "out"
    )
    assert seen["where"] == "openai_image"
    assert paths == ["/tmp/hk-v1.png"]


def test_dispatch_unknown_alias_raises_no_such_key(isolated_keys_db):
    with pytest.raises(NoSuchKeyError, match="missing-alias"):
        dispatch(
            prompt="x",
            model="m",
            alias="missing-alias",
            output_dir=Path("/tmp/out"),
        )


def test_dispatch_routes_openai_alias_to_openai_image_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("oai-1", "openai")
    captured = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return ["/tmp/openai-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.openai_image.render",
        fake_render,
    )

    paths = dispatch(
        prompt="x",
        model="gpt-image-2",
        alias="oai-1",
        output_dir=tmp_path / "out",
    )

    assert paths == ["/tmp/openai-v1.png"]
    assert captured["alias"] == "oai-1"
    assert captured["model"] == "gpt-image-2"


def test_video_provider_keys_can_be_stored_without_dispatch_regression(isolated_keys_db):
    for provider in ["runway", "kling", "veo", "seedance"]:
        spec = KeySpec(
            alias=f"{provider}-main",
            provider=provider,  # type: ignore[arg-type]
            base_url=None,
            access_key="video-secret",
            secret_key=None,
            capabilities=["promo"],
            models=[{"name": provider.title(), "id": provider}],
            modalities=["video"],
            notes="",
            created_at="2026-05-26T18:30:00Z",
        )
        keys.add_key(spec)

    assert keys.find_by_alias("runway-main").modalities == ["video"]
    assert keys.find_by_alias("kling-main").models[0].id == "kling"


def test_dispatch_video_routes_seedance(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="ark", provider="seedance",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="ark-fake", created_at="2026-06-09T00:00:00+00:00",
    ))
    captured = {}

    def fake_render_video(*, prompt, model, alias, output_dir, params=None, **kw):
        captured.update(prompt=prompt, model=model, alias=alias)
        return ["/abs/v1.mp4"]

    from character_workflow.lib.callers import volcengine_video
    monkeypatch.setattr(volcengine_video, "render_video", fake_render_video)

    out = callers.dispatch_video(
        prompt="sea", model="doubao-seedance-2-0-fast-260128", alias="ark",
        output_dir=tmp_path, params={"duration": 5},
    )
    assert out == ["/abs/v1.mp4"]
    assert captured["alias"] == "ark"


def test_dispatch_video_rejects_unwired_provider(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="kl", provider="kling", access_key="x", created_at="2026-06-09T00:00:00+00:00",
    ))
    with pytest.raises(callers.WrongProviderError):
        callers.dispatch_video(prompt="p", model="m", alias="kl", output_dir=tmp_path, params={})
