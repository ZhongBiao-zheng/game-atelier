import pytest

from character_workflow.lib.canvas_runs import _normalized_image_preference_params, _normalized_params
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


@pytest.mark.parametrize("provider,base_url", [
    ("openai", None), ("custom", "https://api.tu-zi.com/v1"),
    ("custom", "https://api.openai-hk.com"),
])
def test_new_canvas_image_preferences_default_to_auto(provider, base_url):
    model = ModelSpec(name="GPT", id="gpt-image-2", modality="image")
    key = _key(provider, model).model_copy(update={"base_url": base_url})
    source = {"n": 2}
    result = _normalized_image_preference_params(key, model, source)
    assert result.model_dump(exclude_none=True) == {
        "size_mode": "auto", "size": "auto", "n": 2,
    }
    assert source == {"n": 2}
    for saved in ({"ratio": "2:3"}, {"size": "1024x1536"}, {"resolution": "2K"}):
        assert _normalized_image_preference_params(key, model, saved).size != "auto"


def test_new_canvas_unsupported_model_keeps_ratio_default():
    model = ModelSpec(name="Nano", id="nano-banana-pro", modality="image")
    result = _normalized_image_preference_params(_key("custom", model), model, {})
    assert result.ratio == "1:1"
    assert result.size != "auto"


def test_canvas_server_locks_midjourney_to_four_candidates():
    model = ModelSpec(name="Midjourney V7", id="midjourney-v7", modality="image")

    normalized, job_params, requested_count = _normalized_params(
        _draft("image", model.id, n=1, mj_profile="e6wl24r"),
        1,
        _key("custom", model),
        model,
    )

    assert requested_count == 4
    assert normalized["n"] == 4
    assert job_params.n == 4
    assert normalized["mj_profile"] == "e6wl24r"


@pytest.mark.parametrize("mode,size,expected", [
    ("auto", "1360x2048", {"size_mode": "auto", "size": "auto", "n": 2}),
    ("custom", "1360x2048", {"size_mode": "custom", "size": "1360x2048", "n": 2}),
])
def test_canvas_freezes_only_active_size_intent(mode, size, expected):
    model = ModelSpec(name="GPT", id="gpt-image-2", modality="image")
    normalized, job_params, count = _normalized_params(
        _draft("image", model.id, size_mode=mode, size=size,
               ratio="2:3", resolution="2K", custom_size="1600x2000"),
        2, _key("openai", model), model,
    )
    assert normalized == expected
    assert job_params.model_dump(exclude_none=True) == expected
    assert count == 2


def test_canvas_preference_recovery_keeps_inactive_draft_values_until_freeze():
    model = ModelSpec(name="GPT", id="gpt-image-2", modality="image")
    key = _key("openai", model)
    source = {"size_mode": "auto", "size": "1360x2048", "ratio": "2:3",
              "resolution": "2K", "custom_size": "1360x2048"}
    preference = _normalized_image_preference_params(key, model, source)
    assert preference.size == "auto"
    assert preference.ratio == "2:3"
    assert preference.custom_size == "1360x2048"
    draft = _draft("image", model.id, **preference.model_dump(exclude_none=True))
    normalized, _, _ = _normalized_params(draft, 1, key, model)
    assert normalized == {"size_mode": "auto", "size": "auto", "n": 1}


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


def test_prompt_asset_hint_survives_canvas_image_freeze_without_loading_the_asset():
    model = ModelSpec(name="GPT", id="gpt-image-2", modality="image")
    draft = _draft("image", model.id, prompt_asset_id="deleted-prompt", n=1)
    draft.prompt = "用户已经改过正文"
    normalized, params, _ = _normalized_params(draft, 1, _key("openai", model), model)
    assert normalized["prompt_asset_id"] == "deleted-prompt"
    assert params.prompt_asset_id == "deleted-prompt"


@pytest.mark.parametrize("edited", [False, True])
def test_canvas_connected_prompt_keeps_asset_default_after_editing(edited):
    from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document
    from character_workflow.lib.canvas_runs import prepare_canvas_generation
    from character_workflow.lib.keys import KeysDB, write_keys_db
    from character_workflow.lib.schemas import (
        CanvasImageNode, CanvasInputConnection, CanvasMediaNodeData, CanvasPoint,
        CanvasTextNode, CanvasTextNodeData, CanvasTextVersion,
    )

    project = create_canvas_project("效果图默认来源")
    document = read_canvas_document(project.project_id)
    model = ModelSpec(id="gpt-image-2", name="GPT", modality="image")
    write_keys_db(KeysDB(keys=[_key("openai", model)]))
    source = CanvasTextNode(
        id="source", type="text", title="提示词", position=CanvasPoint(x=0, y=0),
        data=CanvasTextNodeData(current_version_id="v1", generation_draft=(
            _draft("text", "gpt-5", prompt_asset_id="ca-prompt") if edited else None
        )),
    )
    target = CanvasImageNode(
        id="target", type="image", title="图片", position=CanvasPoint(x=400, y=0),
        data=CanvasMediaNodeData(generation_draft=_draft("image", model.id)),
    )
    version = CanvasTextVersion(
        version_id="v1", kind="text", text="改过的提示词" if edited else "原提示词",
        sha256="e" * 64, created_at=document.updated_at,
        origin={"kind": "user_edit"} if edited else {
            "kind": "creation_asset_snapshot", "title": "提示词", "asset_id": "ca-prompt",
        },
    )
    document = document.model_copy(update={
        "nodes": [source, target], "content_versions": {"v1": version},
        "connections": [CanvasInputConnection(
            id="edge", role="input", source_node_id=source.id, target_node_id=target.id,
        )],
    })
    prepared = prepare_canvas_generation(project.project_id, document, target)
    assert prepared.job_params.prompt_asset_id == "ca-prompt"
