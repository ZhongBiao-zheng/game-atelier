import pytest

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


def test_canvas_server_keeps_reasoning_only_for_responses_protocol():
    responses = ModelSpec(
        name="GPT Responses",
        id="gpt-5",
        modality="text",
        protocol="openai-responses",
    )
    chat = responses.model_copy(update={"protocol": "openai-chat"})

    responses_normalized, _, _ = _normalized_params(
        _draft("text", responses.id, n=3, reasoning_effort="xhigh", voice="alloy"),
        3,
        _key("openai", responses),
        responses,
    )
    chat_normalized, _, _ = _normalized_params(
        _draft("text", chat.id, n=2, reasoning_effort="high"),
        2,
        _key("openai", chat),
        chat,
    )

    assert responses_normalized == {"n": 3, "reasoning_effort": "xhigh"}
    assert chat_normalized == {"n": 2}

    auto_normalized, _, _ = _normalized_params(
        _draft("text", responses.id, n=1, reasoning_effort="auto", temperature=0.8),
        1,
        _key("openai", responses),
        responses,
    )
    assert auto_normalized == {"n": 1}


def test_canvas_server_normalizes_openai_speech_controls():
    speech = ModelSpec(
        name="TTS",
        id="gpt-4o-mini-tts",
        modality="audio",
        protocol="openai-speech",
    )

    normalized, job_params, requested_count = _normalized_params(
        _draft(
            "audio",
            speech.id,
            voice="marin",
            response_format="pcm",
            speed=9,
            instructions="  温柔、克制  ",
            reasoning_effort="high",
            ratio="16:9",
        ),
        1,
        _key("openai", speech),
        speech,
    )

    assert requested_count == 1
    assert normalized == {
        "voice": "marin",
        "response_format": "pcm",
        "speed": 4.0,
        "instructions": "温柔、克制",
    }
    assert job_params.model_dump(exclude_none=True) == normalized


def test_canvas_server_rejects_unimplemented_text_and_audio_protocols():
    text = ModelSpec(
        name="Claude Messages",
        id="claude",
        modality="text",
        protocol="anthropic:messages",
    )
    audio = ModelSpec(
        name="Music",
        id="music-generator",
        modality="audio",
        protocol="audio-generation",
    )

    with pytest.raises(ValueError, match="文本模型没有可用"):
        _normalized_params(_draft("text", text.id, n=1), 1, _key("custom", text), text)
    with pytest.raises(ValueError, match="音频模型没有可用"):
        _normalized_params(_draft("audio", audio.id), 1, _key("custom", audio), audio)
