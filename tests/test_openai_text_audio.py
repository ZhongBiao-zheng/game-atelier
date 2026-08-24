from pathlib import Path

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import openai_audio, openai_text


class _JsonResponse:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _AudioResponse:
    status_code = 200
    text = ""
    headers = {"content-type": "audio/pcm"}
    content = b"\x01\x02\x03\x04"


def _add_key(protocol: str, modality: str):
    keys.add_key(keys.KeySpec(
        alias="advanced",
        provider="openai",
        access_key="sk-test",
        models=[keys.ModelSpec(
            name="Advanced",
            id="advanced-model",
            modality=modality,
            protocol=protocol,
        )],
        created_at="2026-08-25T00:00:00Z",
    ))


def test_openai_responses_sends_reasoning_and_reads_output_text(monkeypatch):
    _add_key("openai-responses", "text")
    posted = []

    def fake_post(url, **kwargs):
        posted.append({"url": url, **kwargs})
        return _JsonResponse({
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": f"结果 {len(posted)}"}],
            }],
        })

    monkeypatch.setattr(openai_text.requests, "post", fake_post)
    outputs = openai_text.generate(
        prompt="写文案",
        model="advanced-model",
        alias="advanced",
        n=2,
        params={"reasoning_effort": "xhigh"},
    )

    assert outputs == ["结果 1", "结果 2"]
    assert len(posted) == 2
    assert posted[0]["url"].endswith("/responses")
    assert posted[0]["json"]["reasoning"] == {"effort": "xhigh"}
    assert posted[0]["json"]["input"] == "写文案"


def test_openai_responses_auto_omits_reasoning(monkeypatch):
    _add_key("openai-responses", "text")
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(kwargs["json"])
        return _JsonResponse({"output_text": "完成"})

    monkeypatch.setattr(openai_text.requests, "post", fake_post)
    assert openai_text.generate(
        prompt="写文案",
        model="advanced-model",
        alias="advanced",
        params={"reasoning_effort": "auto"},
    ) == ["完成"]
    assert "reasoning" not in captured


def test_openai_speech_sends_all_controls_and_writes_pcm(tmp_path, monkeypatch):
    _add_key("openai-speech", "audio")
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return _AudioResponse()

    monkeypatch.setattr(openai_audio.requests, "post", fake_post)
    outputs = openai_audio.render(
        prompt="你好",
        model="advanced-model",
        alias="advanced",
        output_dir=tmp_path,
        params={
            "voice": "marin",
            "response_format": "pcm",
            "speed": 1.25,
            "instructions": "  温柔、克制  ",
        },
    )

    assert captured["json"] == {
        "model": "advanced-model",
        "input": "你好",
        "voice": "marin",
        "response_format": "pcm",
        "speed": 1.25,
        "instructions": "温柔、克制",
    }
    assert outputs == [str(Path(tmp_path) / "speech.pcm")]
    assert Path(outputs[0]).read_bytes() == _AudioResponse.content


def test_openai_speech_rejects_json_disguised_as_audio(tmp_path, monkeypatch):
    _add_key("openai-speech", "audio")
    response = _AudioResponse()
    response.headers = {"content-type": "application/json"}
    response.content = b'{"error":"bad request"}'
    response.text = response.content.decode()
    monkeypatch.setattr(openai_audio.requests, "post", lambda *args, **kwargs: response)

    with pytest.raises(openai_audio.OpenAIAudioError, match="returned JSON"):
        openai_audio.render(
            prompt="你好",
            model="advanced-model",
            alias="advanced",
            output_dir=tmp_path,
            params={"response_format": "pcm"},
        )
