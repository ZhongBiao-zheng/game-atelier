from character_workflow.lib.canvas_runs import _normalized_params
from character_workflow.lib.keys import KeySpec, ModelSpec
from character_workflow.lib.schemas import CanvasGenerationDraft, JobParams


def _key(provider: str, model: ModelSpec) -> KeySpec:
    return KeySpec(
        alias="canvas-test",
        provider=provider,
        access_key="sk-test",
        models=[model],
        created_at="2026-08-25T00:00:00Z",
    )


def _draft(mode: str, model: str, **params) -> CanvasGenerationDraft:
    return CanvasGenerationDraft(
        mode=mode,
        prompt="test",
        model=model,
        alias="canvas-test",
        params=JobParams(**params),
        updated_at="2026-08-25T00:00:00Z",
    )


def test_canvas_server_locks_midjourney_to_four_candidates():
    model = ModelSpec(name="Midjourney V7", id="midjourney-v7", modality="image")

    normalized, job_params, requested_count = _normalized_params(
        _draft("image", model.id, n=1, background="transparent"),
        1,
        _key("custom", model),
        model,
    )

    assert requested_count == 4
    assert normalized["n"] == 4
    assert job_params.n == 4
    assert "background" not in normalized


def test_canvas_server_keeps_background_only_for_direct_gpt_image_protocol():
    direct = ModelSpec(name="GPT Image", id="gpt-image-2", modality="image", protocol="openai")
    ark = direct.model_copy(update={"protocol": "ark"})

    direct_normalized, _, _ = _normalized_params(
        _draft("image", direct.id, n=2, background="transparent"),
        2,
        _key("openai", direct),
        direct,
    )
    ark_normalized, _, _ = _normalized_params(
        _draft("image", ark.id, n=2, background="transparent"),
        2,
        _key("custom", ark),
        ark,
    )

    assert direct_normalized["background"] == "transparent"
    assert "background" not in ark_normalized


def test_canvas_server_strips_unsupported_video_watermark():
    kling = ModelSpec(name="Kling", id="kling-v2", modality="video", protocol="kling")
    seedance = ModelSpec(
        name="Seedance",
        id="seedance-2.0",
        modality="video",
        protocol="seedance",
    )

    kling_normalized, _, _ = _normalized_params(
        _draft("video", kling.id, watermark=True),
        1,
        _key("kling", kling),
        kling,
    )
    seedance_normalized, _, _ = _normalized_params(
        _draft("video", seedance.id, watermark=True),
        1,
        _key("seedance", seedance),
        seedance,
    )

    assert "watermark" not in kling_normalized
    assert seedance_normalized["watermark"] is True
