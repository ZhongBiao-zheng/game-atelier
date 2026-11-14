"""语音生成：能力表、MiniMax caller、分派、估价、模型分类、用量。"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from character_workflow.lib import audio_caps, generation_pricing, keys, tokendance_prices
from character_workflow.lib.callers import minimax_speech

CASES = json.loads((Path(__file__).parent / "fixtures/audio_caps_cases.json").read_text())
MINIMAX_PRICING = {"items": [
    {"id": "minimax:t2a_v2:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
    {"id": "minimax:t2a_v2_ws:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
    {"id": "minimax:voice_clone:counts", "plans": [{"unit": "counts", "rate": "7.92"}]},
    {"id": "minimax:voice_clone:characters", "plans": [{"unit": "kCharacters", "rate": "0.28"}]},
]}


@pytest.mark.parametrize("case", CASES["protocol"])
def test_shared_protocol_cases(case):
    key = SimpleNamespace(provider=case["provider"])
    model = SimpleNamespace(id=case["model_id"], protocol=case["protocol"], via=None)
    assert audio_caps.audio_protocol(key, model) == case["expected"]


@pytest.mark.parametrize("case", CASES["normalize"])
def test_shared_normalize_cases(case):
    caps = audio_caps.AUDIO_CAPS[case["protocol"]]
    assert audio_caps.normalize_speech_params(caps, case["params"]) == case["expected"]


def test_gateway_model_needs_every_member_on_one_protocol():
    def member(provider, model_id, protocol):
        return keys.ViaMember(alias=provider, provider=provider, model_id=model_id,
                              name=model_id, protocol=protocol)

    key = SimpleNamespace(provider="atelier")
    same = SimpleNamespace(id="tts-1", protocol=None, via=[
        member("custom", "tts-1", None), member("openai", "tts-1", "openai-speech")])
    mixed = SimpleNamespace(id="speech", protocol=None, via=[
        member("custom", "tts-1", None), member("tokendance", "speech", "minimax-t2a")])
    assert audio_caps.audio_protocol(key, same) == "openai-speech"
    assert audio_caps.audio_protocol(key, mixed) is None
    assert audio_caps.audio_protocol(key, SimpleNamespace(id="x", protocol=None, via=[])) is None


# ---- MiniMax caller -------------------------------------------------------------------------


class _Response:
    def __init__(self, status_code=200, body=None, text=""):
        self.status_code = status_code
        self._body = body
        self.text = text or json.dumps(body or {})

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


def _ok(audio=b"ID3\x04audio", characters=12):
    return _Response(body={
        "data": {"audio": audio.hex(), "status": 2},
        "extra_info": {"usage_characters": characters, "audio_format": "mp3"},
        "base_resp": {"status_code": 0, "status_msg": "success"},
    })


def _add_minimax(base_url="https://tokendance.space/gateway/v1", provider="tokendance"):
    keys.add_key(keys.KeySpec(
        alias="td", provider=provider, base_url=base_url, access_key="sk-test",
        models=[keys.ModelSpec(name="Speech", id="minimax-speech-2.8-turbo",
                               modality="audio", protocol="minimax-t2a")],
        created_at="2026-11-14T00:00:00Z",
    ))


def _render(tmp_path, params=None, prompt="今天天气真好"):
    return minimax_speech.render(prompt=prompt, model="minimax-speech-2.8-turbo", alias="td",
                                 output_dir=tmp_path, params=params if params is not None else {})


def test_minimax_sends_explicit_payload_and_writes_audio(tmp_path, monkeypatch):
    _add_minimax()
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"minimax-speech-2.8-turbo": MINIMAX_PRICING}.get)
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return _ok(characters=6)

    monkeypatch.setattr(minimax_speech.requests, "post", fake_post)
    params = {"voice": "female-yujie", "speed": 1.25, "response_format": "wav", "instructions": "x"}
    changed = []
    outputs = minimax_speech.render(
        prompt="  今天天气真好  ", model="minimax-speech-2.8-turbo", alias="td",
        output_dir=tmp_path, params=params, on_params_changed=lambda: changed.append(True),
    )

    assert captured["url"] == "https://tokendance.space/gateway/minimax/v1/t2a_v2"
    assert captured["headers"]["Authorization"] == "Bearer sk-test"
    assert captured["json"] == {
        "model": "minimax-speech-2.8-turbo",
        "text": "今天天气真好",
        "stream": False,
        "voice_setting": {"voice_id": "female-yujie", "speed": 1.25, "vol": 1, "pitch": 0},
        "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "wav", "channel": 1},
        "output_format": "hex",
        "subtitle_enable": False,
        "aigc_watermark": False,
    }
    assert outputs == [str(tmp_path / "speech.wav")]
    assert Path(outputs[0]).read_bytes() == b"ID3\x04audio"
    # 实付按上游回报的计费字数：6 字 × 0.16 元 / 千字。
    assert params["actual_cost_cny"] == 0.00096
    assert changed == [True]


def test_minimax_official_endpoint_and_unpriced_channel(tmp_path, monkeypatch):
    _add_minimax(base_url="https://api.minimaxi.com/v1", provider="custom")
    urls = []
    monkeypatch.setattr(minimax_speech.requests, "post",
                        lambda url, **kwargs: urls.append(url) or _ok())
    params = {}
    _render(tmp_path, params)
    assert urls == ["https://api.minimaxi.com/v1/t2a_v2"]
    assert "actual_cost_cny" not in params


def test_minimax_keeps_custom_voice_and_drops_foreign_builtin(tmp_path, monkeypatch):
    _add_minimax()
    sent = []
    monkeypatch.setattr(minimax_speech.requests, "post",
                        lambda url, **kwargs: sent.append(kwargs["json"]) or _ok())
    _render(tmp_path, {"voice": "my-cloned-voice"})
    _render(tmp_path, {"voice": "alloy"})
    assert [body["voice_setting"]["voice_id"] for body in sent] == ["my-cloned-voice", "male-qn-qingse"]


@pytest.mark.parametrize("response,match", [
    (_Response(body={"base_resp": {"status_code": 1004, "status_msg": "auth failed"}}), "1004: auth failed"),
    (_Response(400, text="bad request"), "speech api 400"),
    (_Response(body={"data": {"audio": ""}, "base_resp": {"status_code": 0}}), "没有返回音频"),
    (_Response(body={"data": {"audio": "zz"}, "base_resp": {"status_code": 0}}), "无法解码"),
    (_Response(text="<html>"), "不是 JSON"),
])
def test_minimax_failures_are_reported(tmp_path, monkeypatch, response, match):
    _add_minimax()
    monkeypatch.setattr(minimax_speech.requests, "post", lambda url, **kwargs: response)
    with pytest.raises(minimax_speech.MiniMaxSpeechError, match=match):
        _render(tmp_path)


def test_minimax_rejects_empty_and_overlong_text_without_calling(tmp_path, monkeypatch):
    _add_minimax()
    monkeypatch.setattr(minimax_speech.requests, "post", lambda *a, **k: pytest.fail("called"))
    with pytest.raises(minimax_speech.MiniMaxSpeechError, match="请输入"):
        _render(tmp_path, prompt="   ")
    with pytest.raises(minimax_speech.MiniMaxSpeechError, match="9999"):
        _render(tmp_path, prompt="字" * 10000)


def test_minimax_retries_only_undelivered_and_gateway_errors(tmp_path, monkeypatch):
    _add_minimax()
    monkeypatch.setattr(minimax_speech.time, "sleep", lambda seconds: None)
    replies = [requests.ConnectionError("refused"), _Response(503, text="busy"), _ok()]
    calls = []

    def flaky(url, **kwargs):
        calls.append(url)
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(minimax_speech.requests, "post", flaky)
    assert _render(tmp_path)
    assert len(calls) == 3

    calls.clear()
    monkeypatch.setattr(minimax_speech.requests, "post",
                        lambda url, **kwargs: calls.append(url) or _Response(429, text="rate"))
    with pytest.raises(minimax_speech.MiniMaxSpeechError, match="429"):
        _render(tmp_path)
    assert len(calls) == 1

    calls.clear()

    def timeout(url, **kwargs):
        calls.append(url)
        raise requests.ReadTimeout("slow")

    monkeypatch.setattr(minimax_speech.requests, "post", timeout)
    with pytest.raises(minimax_speech.MiniMaxSpeechError):
        _render(tmp_path)
    assert len(calls) == 1


def test_dispatch_audio_routes_by_protocol(tmp_path, monkeypatch):
    from character_workflow.lib.callers import dispatch_audio

    _add_minimax()
    keys.add_key(keys.KeySpec(
        alias="ark", provider="tokendance", base_url="https://tokendance.space/gateway/v1",
        access_key="sk", models=[keys.ModelSpec(name="Seed", id="seed-tts-2.0", modality="audio",
                                                protocol="ark-tts")],
        created_at="2026-11-14T00:00:00Z",
    ))
    monkeypatch.setattr(minimax_speech, "render", lambda **kwargs: ["minimax"])
    assert dispatch_audio(prompt="hi", model="minimax-speech-2.8-turbo", alias="td",
                          output_dir=tmp_path) == ["minimax"]
    with pytest.raises(ValueError, match="没有可用的生成协议"):
        dispatch_audio(prompt="hi", model="seed-tts-2.0", alias="ark", output_dir=tmp_path)


# ---- 估价 -----------------------------------------------------------------------------------


def test_speech_estimate_uses_character_rate(monkeypatch):
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"minimax-speech-2.8-turbo": MINIMAX_PRICING}.get)
    estimate = generation_pricing.estimate_cost_cny
    request = {"kind": "audio", "provider": "tokendance", "model_id": "minimax-speech-2.8-turbo",
               "protocol": "minimax-t2a"}
    assert estimate(**request, text_length=1000) == 0.16
    assert estimate(**request, text_length=20) == 0.0032
    assert estimate(**request) is None
    assert estimate(**{**request, "model_id": "unknown"}, text_length=20) is None
    assert estimate(kind="audio", provider="custom", base_url="https://api.openai-hk.com",
                    model_id="tts-1", text_length=20) is None


def test_speech_rate_needs_one_unambiguous_plan(monkeypatch):
    conflicting = {"items": [
        {"id": "minimax:t2a_v2:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
        {"id": "other:tts:characters", "plans": [{"unit": "kCharacters", "rate": "0.3"}]},
    ]}
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"m": conflicting}.get)
    assert generation_pricing.speech_cost_cny(provider="tokendance", model_id="m", characters=10) is None


# ---- 模型分类 -------------------------------------------------------------------------------


def test_models_preview_maps_vendor_speech_protocols(tmp_path, monkeypatch):
    from tests.local_client import LocalTestClient as TestClient
    from tests.test_keys_api import _preview_with_upstream
    from viewer_server.server_app import build_app

    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    rows = [
        {"id": "minimax-speech-2.8-turbo",
         "supported_protocols": ["minimax:t2a_v2", "minimax:t2a_v2_ws", "minimax:voice_clone"]},
        {"id": "seed-tts-2.0", "supported_protocols": ["ark:tts", "ark:tts_ws"]},
        {"id": "kling-tts", "supported_protocols": ["kling:tts"]},
        {"id": "qwen-audio-3.1-asr-flash-streaming", "supported_protocols": ["qwen:audio-asr-streaming"]},
        {"id": "tts-1", "supported_protocols": ["openai:text-to-speech"]},
    ]
    by_id = {m["id"]: m for m in _preview_with_upstream(client, rows).json()["models"]}

    assert (by_id["minimax-speech-2.8-turbo"]["modality"], by_id["minimax-speech-2.8-turbo"]["protocol"]) \
        == ("audio", "minimax-t2a")
    # 厂商私有协议不能再被 tts 字样认成 OpenAI audio/speech：本机还跑不了，就保持不可执行。
    assert (by_id["seed-tts-2.0"]["modality"], by_id["seed-tts-2.0"]["protocol"]) == ("audio", "ark-tts")
    assert by_id["kling-tts"]["protocol"] == "kling-tts"
    assert "qwen-audio-3.1-asr-flash-streaming" not in by_id
    assert by_id["tts-1"]["protocol"] == "openai-speech"


# ---- 用量 -----------------------------------------------------------------------------------


def test_usage_counts_audio_jobs():
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
    from character_workflow.lib.usage_stats import mine_records

    job = Job(job_id="a1", character_id="td", namespace="studio", kind=JobKind.AUDIO, prompt="hi",
              model="tts-1", alias="td", status=JobStatus.DONE, error=None,
              submitted_at="2026-11-14T00:00:00+00:00", completed_at="2026-11-14T00:00:03+00:00",
              output_paths=["/tmp/a.mp3"], params=JobParams(estimated_cost_cny=0.001))
    rows = mine_records([job], {})
    assert [(row["kind"], row["cost_cny"]) for row in rows] == [("audio", 0.001)]


# ---- 画布提交 -------------------------------------------------------------------------------


def test_canvas_freezes_minimax_params_by_its_protocol():
    from character_workflow.lib.canvas_runs import _normalized_params
    from character_workflow.lib.schemas import CanvasGenerationDraft, JobParams

    model = keys.ModelSpec(name="Speech", id="minimax-speech-2.8-turbo", modality="audio",
                           protocol="minimax-t2a")
    key = keys.KeySpec(alias="td", provider="tokendance", access_key="sk", models=[model],
                       created_at="2026-11-14T00:00:00Z")

    def freeze(**params):
        draft = CanvasGenerationDraft(mode="audio", prompt="你好", model=model.id, alias="td",
                                      params=JobParams(**params), updated_at="2026-11-14T00:00:00Z")
        return _normalized_params(draft, 1, key, model)[0]

    assert freeze(voice="Chinese (Mandarin)_News_Anchor", response_format="wav", speed=1.5,
                  instructions="温柔") == {
        "voice": "Chinese (Mandarin)_News_Anchor", "response_format": "wav", "speed": 1.5}
    assert freeze(voice="marin", response_format="pcm", speed=0.25) == {
        "voice": "male-qn-qingse", "response_format": "mp3", "speed": 0.5}
