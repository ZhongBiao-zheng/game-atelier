"""Alias-based caller dispatch protocol (Task 11).

Verifies:
1. dispatch("lovart-1") routes to lovart.render with key creds injected
2. dispatch("missing") raises NoSuchKeyError
3. dispatch on a stub provider raises NotImplementedError (via stubs.*_render)
4. lovart.render injects access_key / secret_key into env before calling
   submit_and_wait, and returns output_paths.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import NoSuchKeyError, dispatch
from character_workflow.lib.callers import lovart as lovart_caller
from character_workflow.lib.keys import KeySpec


@pytest.fixture
def isolated_keys_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
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


def test_dispatch_routes_lovart_alias_to_lovart_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("lovart-main", "lovart")

    captured: dict = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return ["/tmp/v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.lovart.render",
        fake_render,
    )

    out_dir = tmp_path / "out"
    paths = dispatch(
        prompt="一只狐狸",
        model="generate_image_gpt_image_2",
        alias="lovart-main",
        output_dir=out_dir,
    )

    assert paths == ["/tmp/v1.png"]
    assert captured["alias"] == "lovart-main"
    assert captured["prompt"] == "一只狐狸"
    assert captured["model"] == "generate_image_gpt_image_2"
    assert captured["kwargs"]["output_dir"] == out_dir


def test_dispatch_routes_custom_t8star_alias_to_zhenzhen_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("zz-main", "custom", base_url="https://ai.t8star.org")
    captured = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return ["/tmp/zz-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.zhenzhen.render",
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


def test_dispatch_unknown_alias_raises_no_such_key(isolated_keys_db):
    with pytest.raises(NoSuchKeyError, match="missing-alias"):
        dispatch(
            prompt="x",
            model="m",
            alias="missing-alias",
            output_dir=Path("/tmp/out"),
        )


def test_dispatch_stub_provider_raises_not_implemented(
    isolated_keys_db, tmp_path,
):
    _add("oai-1", "openai")

    with pytest.raises(NotImplementedError):
        dispatch(
            prompt="x",
            model="dall-e-3",
            alias="oai-1",
            output_dir=tmp_path / "out",
        )


def test_lovart_render_injects_keys_into_env_and_returns_paths(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add(
        "lovart-x",
        "lovart",
        access_key="AK-RENDER",
        secret_key="SK-RENDER",
    )

    captured: dict = {}

    def fake_submit(*, prompt, model, output_dir, **kwargs):
        # Simulate the real submit_and_wait peeking at env via os.environ
        # in real callers it goes through subprocess.run env= dict. We capture
        # what render passes through by monkeypatching os.environ briefly
        import os
        captured["AK"] = os.environ.get("LOVART_ACCESS_KEY")
        captured["SK"] = os.environ.get("LOVART_SECRET_KEY")
        captured["prompt"] = prompt
        captured["model"] = model
        captured["output_dir"] = output_dir
        return lovart_caller.LovartResult(
            output_paths=["/abs/v1.png"],
            raw_json={"final_status": "done"},
        )

    monkeypatch.setattr(
        "character_workflow.lib.callers.lovart.submit_and_wait",
        fake_submit,
    )

    out_dir = tmp_path / "out"
    paths = lovart_caller.render(
        prompt="圣灵祭祀",
        model="generate_image_gpt_image_2",
        alias="lovart-x",
        output_dir=out_dir,
    )

    assert paths == ["/abs/v1.png"]
    assert captured["AK"] == "AK-RENDER"
    assert captured["SK"] == "SK-RENDER"
    assert captured["output_dir"] == out_dir


def test_lovart_render_rejects_wrong_provider_alias(isolated_keys_db, tmp_path):
    _add("oai-2", "openai")
    with pytest.raises(ValueError, match="provider"):
        lovart_caller.render(
            prompt="x",
            model="m",
            alias="oai-2",
            output_dir=tmp_path / "out",
        )


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
