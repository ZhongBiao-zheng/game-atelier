"""自定义接口的音频模板：结构校验、能力声明、二进制 / hex / 轮询结果、格式判定与安全约束。"""
import copy
import json
from pathlib import Path

import pytest
import requests

from character_workflow.lib import audio_caps, http_protocols, keys
from character_workflow.lib.callers import declarative, dispatch_audio, video_poll
from character_workflow.lib.http_protocol_schema import (
    ProtocolInvalidError, declared_capabilities, parse_protocol,
)
from tests.fake_http_vendor import FakeVendor

SECRET = "sk-test-secret-0123456789"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 64
FLAC = b"fLaC" + b"\x00" * 64

SPEECH = {
    "version": 1, "name": "OpenAI 兼容语音", "kind": "audio", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/audio/speech",
               "body": {"model": "$model", "input": "$prompt", "voice": "$voice",
                        "speed": "$speed", "response_format": "$format"}},
    "options": {"voices": [{"id": "alloy", "label": "Alloy"}, {"id": "nova"}],
                "speeds": [0.75, 1, 1.25, 1.5], "formats": ["mp3", "wav"], "max_chars": 20},
    "result": {"body": "binary"},
}
HEX = {
    "version": 1, "name": "MiniMax 兼容", "kind": "audio", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/t2a_v2",
               "body": {"model": "$model", "text": "$prompt",
                        "voice_setting": {"voice_id": "$voice", "speed": "$rate"}}},
    "options": {"voices": [{"id": "male-qn-qingse", "label": "青涩青年"}], "custom_voice": True,
                "speeds": [0.5, 1, 2]},
    "derive": {"rate": {"from": "speed", "map": {"0.5": -50, "1": 0, "2": 100}}},
    "result": {"hex": ["data.audio"], "error": "base_resp.status_msg"},
}
MUSIC = {
    "version": 1, "name": "歌曲", "kind": "audio", "auth": {"type": "bearer"},
    "submit": {"path": "/song", "body": {"model": "$model", "prompt": "$prompt", "lyric": "$lyrics",
                                         "pure": "$instrumental", "n": "$n"}},
    "options": {"count": 2},
    "poll": {"path": "/task/${taskId}", "task_id": "id", "status": "status",
             "success": ["done"], "failure": ["fail"], "interval_seconds": 1,
             "result": {"urls": ["songs.*.url"]}},
}


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        yield server


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(video_poll.time, "sleep", lambda _s: None)
    monkeypatch.setattr(declarative.time, "sleep", lambda _s: None)


def configure(server, document, *, model="m1"):
    stored = http_protocols.save_protocol(copy.deepcopy(document))
    keys.add_key(keys.KeySpec(
        alias="vendor", provider="custom", base_url=server.url, access_key=SECRET,
        models=[keys.ModelSpec(id=model, name=model, modality="audio", protocol="declarative",
                               declarative_id=stored.id)],
        created_at="2026-11-15T00:00:00Z",
    ))
    return stored.id


def run(tmp_path, params=None, prompt="你好"):
    return dispatch_audio(prompt=prompt, model="m1", alias="vendor", output_dir=tmp_path / "out",
                          params=params or {})


# ---- 结构与能力声明 ------------------------------------------------------------------------


def test_speech_template_declares_audio_controls():
    caps = declared_capabilities(parse_protocol(copy.deepcopy(SPEECH)))
    assert caps["kind"] == "audio" and caps["family"] == "speech"
    assert caps["voices"] == [{"id": "alloy", "label": "Alloy"}, {"id": "nova", "label": "nova"}]
    assert caps["speeds"] == [0.75, 1, 1.25, 1.5] and caps["formats"] == ["mp3", "wav"]
    assert (caps["max_chars"], caps["max_count"], caps["lyrics"], caps["instrumental"]) == (20, 1, False, False)


def test_music_family_comes_from_placeholders():
    caps = declared_capabilities(parse_protocol(copy.deepcopy(MUSIC)))
    assert (caps["family"], caps["max_count"], caps["lyrics"], caps["instrumental"]) == ("music", 2, True, True)
    assert caps["voices"] is None and caps["speeds"] is None and caps["formats"] is None


@pytest.mark.parametrize("patch,message", [
    ({"kind": "image"}, "二进制响应只用于音频接口"),
    ({"poll": MUSIC["poll"]}, "二进制响应只用于同步接口"),
    ({"options": {"speeds": [1]}}, "options.voices"),
    ({"options": {**SPEECH["options"], "speeds": [9]}}, "0.25–4"),
    ({"options": {**SPEECH["options"], "count": 2}}, "语音一次只出一条"),
    ({"submit": {"path": "/x", "body": {"text": "$prompt", "size": "$ratio"}}}, "音频接口不能用 $ratio"),
])
def test_invalid_audio_templates(patch, message):
    with pytest.raises(ProtocolInvalidError) as error:
        parse_protocol({**copy.deepcopy(SPEECH), **patch})
    assert any(message in issue.message or message in issue.path for issue in error.value.issues)


def test_audio_fields_are_rejected_on_image_templates():
    image = {"version": 1, "name": "图", "kind": "image", "auth": {"type": "bearer"},
             "submit": {"path": "/x", "body": {"prompt": "$prompt", "v": "$voice"}},
             "options": {"formats": ["mp3"]}, "result": {"hex": ["a"]}}
    with pytest.raises(ProtocolInvalidError) as error:
        parse_protocol(image)
    messages = {issue.message for issue in error.value.issues}
    assert "$voice 只能用在音频接口里" in messages
    assert "只有音频接口能声明这一项" in messages
    assert "hex 结果只用于音频接口" in messages


# ---- 二进制结果 -----------------------------------------------------------------------------


def test_binary_speech_streams_to_file_by_file_header(vendor, tmp_path):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", WAV)
    paths = run(tmp_path, {"voice": "nova", "speed": 1.25, "response_format": "wav"})
    assert [Path(p).name for p in paths] == ["v1.wav"] and Path(paths[0]).read_bytes() == WAV
    call = vendor.calls("POST")[0]
    assert call.json() == {"model": "m1", "input": "你好", "voice": "nova", "speed": 1.25,
                           "response_format": "wav"}
    assert call.headers["Authorization"] == f"Bearer {SECRET}"


def test_file_header_wins_over_content_type(vendor, tmp_path):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", (200, FLAC, {"Content-Type": "audio/mpeg"}))
    assert Path(run(tmp_path)[0]).suffix == ".flac"


@pytest.mark.parametrize("reply,match", [
    ({"error": {"message": "bad voice"}}, "不是音频"),
    (b"\x00\x01garbage", "无法识别的音频格式"),
    (b"{\"oops\": 1}", "JSON"),
])
def test_binary_rejects_non_audio(vendor, tmp_path, reply, match):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", reply)
    with pytest.raises(declarative.DeclarativeError, match=match):
        run(tmp_path)
    assert not list((tmp_path / "out").glob("v1*"))


def test_options_are_enforced_before_any_request(vendor, tmp_path):
    configure(vendor, SPEECH)
    for params, prompt, match in [({"voice": "ghost"}, "你好", "音色"),
                                  ({"speed": 2}, "你好", "语速"),
                                  ({"response_format": "flac"}, "你好", "格式"),
                                  ({}, "字" * 21, "20 字")]:
        with pytest.raises(declarative.DeclarativeError, match=match):
            run(tmp_path, params, prompt=prompt)
    assert vendor.calls() == []


# ---- 二进制分支的安全约束（与 send() 同一套） ------------------------------------------------


def test_binary_request_only_goes_to_base_url(vendor, tmp_path):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", MP3)
    run(tmp_path)
    assert [(c.method, c.path) for c in vendor.received] == [("POST", "/v1/audio/speech")]
    with pytest.raises(ProtocolInvalidError):
        parse_protocol({**copy.deepcopy(SPEECH), "submit": {**SPEECH["submit"],
                                                            "path": "https://evil.example/steal"}})


def test_binary_redirect_is_not_followed(vendor, tmp_path):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", (302, b"", {"Location": "http://evil.example/steal"}))
    with pytest.raises(declarative.DeclarativeError, match="重定向"):
        run(tmp_path)
    assert len(vendor.calls()) == 1


class _BrokenBody:
    """响应头已到、读体时断开：模拟厂商已受理、传输中途失败。"""
    status_code = 200
    headers = {"Content-Type": "audio/mpeg"}

    def iter_content(self, chunk_size=None):
        yield MP3[:8]
        raise requests.ConnectionError("Read timed out.")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_binary_body_failure_after_headers_submits_only_once(vendor, tmp_path, monkeypatch):
    configure(vendor, SPEECH)
    calls = []

    def broken(*args, **kwargs):
        calls.append(kwargs.get("allow_redirects"))
        return _BrokenBody()

    monkeypatch.setattr(declarative.requests, "request", broken)
    with pytest.raises(declarative.DeclarativeError, match="已收到响应头"):
        run(tmp_path)
    assert calls == [False]
    assert not list((tmp_path / "out").glob("*"))


def test_binary_retries_only_undelivered_and_gateway_errors(vendor, tmp_path):
    configure(vendor, SPEECH)
    vendor.on("POST", "/v1/audio/speech", (503, {"error": "busy"}), MP3)
    assert run(tmp_path)
    assert len(vendor.calls("POST")) == 2
    vendor.received.clear()
    vendor.on("POST", "/v1/audio/speech", (500, {"error": "boom"}))
    with pytest.raises(declarative.DeclarativeError, match="custom api 500"):
        run(tmp_path)
    assert len(vendor.calls("POST")) == 1


def test_binary_error_text_never_contains_the_key(vendor, tmp_path):
    configure(vendor, {**SPEECH, "auth": {"type": "query", "name": "key"}})
    vendor.on("POST", "/v1/audio/speech", (401, {"error": {"message": f"bad key {SECRET}"}}))
    with pytest.raises(declarative.DeclarativeError) as error:
        run(tmp_path)
    assert SECRET not in str(error.value)


def test_binary_oversized_response_is_cut(vendor, tmp_path, monkeypatch):
    configure(vendor, SPEECH)
    monkeypatch.setattr(declarative, "AUDIO_LIMIT", 16)
    vendor.on("POST", "/v1/audio/speech", MP3)
    with pytest.raises(declarative.DeclarativeError, match="过大"):
        run(tmp_path)


# ---- hex 与轮询结果 ------------------------------------------------------------------------


def test_hex_result_with_custom_voice_and_derived_speed(vendor, tmp_path):
    configure(vendor, HEX)
    vendor.on("POST", "/v1/t2a_v2", {"data": {"audio": MP3.hex()}, "base_resp": {"status_code": 0}})
    paths = run(tmp_path, {"voice": "my-clone", "speed": 2})
    assert Path(paths[0]).read_bytes() == MP3
    assert vendor.calls("POST")[0].json()["voice_setting"] == {"voice_id": "my-clone", "speed": 100}


def test_async_music_keeps_requested_songs(vendor, tmp_path):
    configure(vendor, MUSIC)
    vendor.on("POST", "/song", {"id": "t1"})
    vendor.on("GET", "/task/t1", {"status": "running"},
              {"status": "done", "songs": [{"url": vendor.url + "/a.mp3"}, {"url": vendor.url + "/b.mp3"}]})
    vendor.on("GET", "/a.mp3", MP3)
    vendor.on("GET", "/b.mp3", WAV)
    params = {"n": 2, "lyrics": "[VERSE] 风"}
    paths = run(tmp_path, params)
    assert [Path(p).name for p in paths] == ["v1.mp3", "v2.wav"]
    assert vendor.calls("POST")[0].json() == {"model": "m1", "prompt": "你好", "lyric": "[VERSE] 风",
                                              "pure": False, "n": 2}
    assert params["provider_task_ids"] == ["t1"]


# ---- 能力表与画布 --------------------------------------------------------------------------


def test_audio_caps_follow_the_template(vendor):
    configure(vendor, SPEECH)
    key = keys.find_by_alias("vendor")
    caps = audio_caps.audio_caps(key, key.models[0])
    assert caps.family == "speech" and caps.speeds == (0.75, 1.0, 1.25, 1.5)
    assert audio_caps.normalize_speech_params(caps, {"voice": "ghost", "speed": 1.4,
                                                     "response_format": "aac"}) == {
        "voice": "alloy", "response_format": "mp3", "speed": 1.5}
    keys.delete_key("vendor")
    configure(vendor, MUSIC)
    key = keys.find_by_alias("vendor")
    music = audio_caps.audio_caps(key, key.models[0])
    assert music.family == "music" and music.controls == frozenset()
    assert audio_caps.normalize_speech_params(music, {"voice": "x"}) == {}
    assert audio_caps.normalize_music_params(music, "m1", {"instrumental": True, "n": 2}) == {
        "instrumental": True, "n": 2}


def test_gateway_member_uses_the_snapshot():
    snapshot = declared_capabilities(parse_protocol(copy.deepcopy(SPEECH)))
    member = keys.ViaMember(alias="vendor", provider="custom", model_id="m1", name="m1",
                            protocol="declarative")
    model = keys.ModelSpec(id="m1", name="m1", modality="audio", protocol="declarative",
                           via=[member], declared_snapshot=snapshot)
    caps = audio_caps.audio_caps(keys.KeySpec(alias="hub", provider="atelier", access_key="x",
                                              created_at="2026-11-15T00:00:00Z"), model)
    assert caps is not None and caps.voices == ("alloy", "nova")


def test_declarative_audio_is_unpriced():
    from character_workflow.lib.generation_pricing import estimate_cost_cny

    assert estimate_cost_cny(kind="audio", provider="custom", model_id="m1", protocol="declarative",
                             text_length=10) is None


def test_assist_accepts_audio():
    from character_workflow.lib import http_protocol_assist as assist

    shaped, _ = assist.shape_document(json.loads(json.dumps(SPEECH)), "audio")
    assert shaped["kind"] == "audio"
    assert '"audio"' in assist.SPEC and "result.body" in assist.SPEC
