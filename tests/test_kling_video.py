"""可灵（OpenAI-HK 聚合）视频 caller 契约测试（mock HTTP，不真打 API）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import kling_video as kv
from character_workflow.lib.callers import video_poll


class _FakeResp:
    def __init__(self, status_code: int, payload: dict, content: bytes = b"MP4"):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)
        self.content = content

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


def _done(url: str = "https://cdn.kling/out.mp4") -> dict:
    return {"data": {"task_status": "succeed", "task_result": {"videos": [{"url": url}]}}}


@pytest.fixture
def kling_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    _keys.add_key(_keys.KeySpec(
        alias="hk",
        provider="kling",
        base_url="https://api.openai-hk.com/v1",
        access_key="hk-fake",
        created_at="2026-08-13T00:00:00+00:00",
    ))
    return tmp_path


def _render(tmp_path, **kw):
    return kv.render_video(
        prompt="p", model="kling-video-v2-6", alias="hk",
        output_dir=tmp_path / "o", params=kw.pop("params", {}), poll_interval=0, **kw,
    )


def test_render_submits_polls_downloads(kling_key, tmp_path, monkeypatch):
    posted = {}
    monkeypatch.setattr(kv.requests, "post", lambda url, headers=None, json=None, timeout=None: (
        posted.update(url=url) or _FakeResp(200, {"data": {"task_id": "k-1"}})))
    monkeypatch.setattr(kv.requests, "get", lambda *a, **k: _FakeResp(200, _done()))

    out = _render(tmp_path)
    assert posted["url"].endswith("/kling/v1/videos/text2video")
    assert Path(out[0]).read_bytes() == b"MP4"


def test_poll_recovers_from_transient_network_error(kling_key, tmp_path, monkeypatch):
    # 15-30 分钟轮询窗口里一次切节点 / DNS 抖动，不该把已计费的任务判死。
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-1"}}))
    calls = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        if headers is None:  # _download_mp4 不带 headers
            return _FakeResp(200, {})
        calls["n"] += 1
        if calls["n"] <= 2:
            raise requests.ConnectionError("Connection reset by peer")
        return _FakeResp(200, _done())

    monkeypatch.setattr(kv.requests, "get", fake_get)
    # max_polls=1：抖动若吃预算就会当场超时。
    assert _render(tmp_path, max_polls=1)
    assert calls["n"] == 3


def test_poll_transient_5xx_is_not_task_failure(kling_key, tmp_path, monkeypatch):
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-1"}}))
    seq = [_FakeResp(502, {"message": "bad gateway"}), _FakeResp(200, _done())]

    def fake_get(url, headers=None, timeout=None):
        return _FakeResp(200, {}) if headers is None else seq.pop(0)

    monkeypatch.setattr(kv.requests, "get", fake_get)
    assert _render(tmp_path, max_polls=1)


def test_abandon_after_consecutive_failures_names_task_id(kling_key, tmp_path, monkeypatch):
    monkeypatch.setattr(video_poll, "_TRANSIENT_WINDOW_SECONDS", 3.0)
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-lost"}}))

    def always_down(url, headers=None, timeout=None):
        raise requests.ConnectionError("dns failure")

    monkeypatch.setattr(kv.requests, "get", always_down)
    with pytest.raises(kv.KlingVideoError, match="k-lost"):
        _render(tmp_path)


def test_failure_timeout_and_missing_url_carry_task_id(kling_key, tmp_path, monkeypatch):
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-9"}}))

    monkeypatch.setattr(kv.requests, "get", lambda *a, **k: _FakeResp(
        200, {"data": {"task_status": "failed", "task_status_msg": "nsfw"}}))
    with pytest.raises(kv.KlingVideoError, match="k-9"):
        _render(tmp_path)

    monkeypatch.setattr(kv.requests, "get", lambda *a, **k: _FakeResp(
        200, {"data": {"task_status": "succeed", "task_result": {"videos": []}}}))
    with pytest.raises(kv.KlingVideoError, match="k-9"):
        _render(tmp_path)

    monkeypatch.setattr(kv.requests, "get", lambda *a, **k: _FakeResp(
        200, {"data": {"task_status": "processing"}}))
    with pytest.raises(kv.KlingVideoError, match="k-9"):
        _render(tmp_path, max_polls=2)


def test_download_failure_carries_task_id_and_source_url(kling_key, tmp_path, monkeypatch):
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-dl"}}))

    def fake_get(url, headers=None, timeout=None):
        if headers is None:  # _download_mp4 不带 headers
            raise requests.ConnectionError("reset")
        return _FakeResp(200, _done())

    monkeypatch.setattr(kv.requests, "get", fake_get)
    with pytest.raises(kv.KlingVideoError) as excinfo:
        _render(tmp_path)
    assert "k-dl" in str(excinfo.value)
    assert "https://cdn.kling/out.mp4" in str(excinfo.value)


def test_echoed_input_image_not_taken_from_output_array(kling_key, tmp_path, monkeypatch):
    # 可灵的产物位置本来就窄（task_result.videos[]），但上游若把输入直链回显进来，
    # 排除集是最后一道闸：绝不把用户自己传的东西当产物交付。
    ref = "https://cdn.x/user-first-frame.png"
    monkeypatch.setattr(kv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"task_id": "k-1"}}))
    monkeypatch.setattr(kv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {
        "task_status": "succeed",
        "task_result": {"videos": [{"url": ref}, {"url": "https://cdn.kling/real.mp4"}]},
    }}))
    got = {}
    monkeypatch.setattr(kv, "_download_mp4",
                        lambda url, d, i, **kw: (got.update(url=url) or "ok"))

    _render(tmp_path, params={"reference_images": [ref], "frame_mode": "first"})
    assert got["url"] == "https://cdn.kling/real.mp4"


# ---- 可灵新版接口（词元跳动 / 兔子转发，klingai_video）----

from character_workflow.lib.callers import klingai_video as kai  # noqa: E402


def test_klingai_t2v_v4_uses_settings_and_no_audio_toggle():
    spec, endpoint, body = kai.build_request(
        "p", "kling-4.0", {"duration": 12, "resolution": "1080p", "ratio": "21:9",
                           "generate_audio": False})
    assert (spec.endpoint_version, endpoint) == ("v2", "text2video")
    assert body == {"model_name": "kling-4.0", "prompt": "p",
                    "settings": {"resolution": "1080p", "duration": 12, "aspect_ratio": "21:9"}}


def test_klingai_v3_firstlast_orders_frames_and_sends_audio(tmp_path):
    first, last = tmp_path / "a.png", tmp_path / "b.png"
    first.write_bytes(b"A")
    last.write_bytes(b"B")
    spec, endpoint, body = kai.build_request("p", "kling-3.0", {
        "reference_images": [str(first), str(last)], "frame_mode": "firstlast",
        "ratio": "16:9", "generate_audio": True, "duration": 5})
    assert (spec.endpoint_version, endpoint) == ("v1", "image2video")
    assert [c["type"] for c in body["contents"]] == ["prompt", "first_frame", "last_frame"]
    assert body["contents"][1]["url"] == "QQ=="  # 本地图编成裸 base64
    # 图生视频比例随首帧：不发 aspect_ratio；3.0 的 audio 默认 off，开了必须显式发 native。
    assert body["settings"] == {"duration": 5, "audio": "native"}


def test_klingai_omni_refs_route_to_omni_endpoint():
    _, endpoint, body = kai.build_request("p", "kling-4.0-flash", {
        "reference_images": ["https://x/a.png", "https://x/b.png"]})
    assert endpoint == "omni-video"
    assert [(c["type"], c.get("id")) for c in body["contents"][1:]] == [
        ("refer_image", "image_1"), ("refer_image", "image_2")]
    # 3.0 Omni 只挂 omni-video：纯文生也走它。
    assert kai.build_request("p", "kling-3.0-omni", {})[1] == "omni-video"


@pytest.mark.parametrize(("model", "params", "message"), [
    ("kling-3.0", {"reference_images": ["https://x/a.png"]}, "不支持全能参考"),
    ("kling-4.0", {"reference_images": ["https://x/a.png"], "frame_mode": "last"}, "只设置尾帧"),
    ("kling-4.0-flash", {"reference_images": ["https://x/a.png", "https://x/b.png"],
                         "frame_mode": "firstlast"}, "只支持首帧"),
    ("kling-4.0-flash", {"resolution": "1080p"}, "不支持 1080p"),
    ("kling-3.0-turbo", {"duration": 20}, "3–15"),
    ("kling-4.0", {"reference_audios": ["a.mp3"]}, "参考音频"),
])
def test_klingai_rejects_out_of_contract_requests_before_billing(model, params, message):
    with pytest.raises(kai.KlingaiVideoError, match=message):
        kai.build_request("p", model, params)


def _td_key(tmp_path, monkeypatch, *, base_url="https://tokendance.space/gateway/v1"):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    _keys.add_key(_keys.KeySpec(alias="td", provider="tokendance", base_url=base_url,
                                access_key="td-fake", created_at="2026-11-10T00:00:00+00:00"))


def test_klingai_tokendance_render_submits_v2_and_reads_outputs(tmp_path, monkeypatch):
    _td_key(tmp_path, monkeypatch)
    posted, task_ids = {}, []
    monkeypatch.setattr(kai.requests, "post", lambda url, headers=None, json=None, timeout=None: (
        posted.update(url=url, body=json) or _FakeResp(200, {"code": 0, "data": {"id": "t-1"}})))
    polls = iter([
        _FakeResp(200, {"code": 0, "data": [{"id": "t-1", "status": "processing"}]}),
        _FakeResp(200, {"code": 0, "data": [{"id": "t-1", "status": "succeeded", "outputs": [
            {"type": "image", "url": "https://cdn/x.png"},
            {"type": "video", "url": "https://cdn/out.mp4"}]}]}),
    ])

    def fake_get(url, headers=None, timeout=None):
        if url == "https://cdn/out.mp4":
            assert headers is None  # 第三方存储不带渠道 key
            return _FakeResp(200, {})
        assert url == "https://tokendance.space/gateway/kling/v2/text2video/t-1"
        return next(polls)

    monkeypatch.setattr(kai.requests, "get", fake_get)
    out = kai.render_video(prompt="p", model="kling-4.0-flash", alias="td",
                           output_dir=tmp_path / "o", params={"duration": 3}, poll_interval=0,
                           on_task_id=task_ids.append)
    assert posted["url"] == "https://tokendance.space/gateway/kling/v2/text2video"
    assert posted["body"]["model_name"] == "kling-4.0-flash"
    assert task_ids == ["t-1"]
    assert Path(out[0]).read_bytes() == b"MP4"


def test_klingai_failed_task_reports_reason_with_task_id(tmp_path, monkeypatch):
    _td_key(tmp_path, monkeypatch)
    monkeypatch.setattr(kai.requests, "post",
                        lambda *a, **k: _FakeResp(200, {"code": 0, "data": {"id": "t-9"}}))
    monkeypatch.setattr(kai.requests, "get", lambda *a, **k: _FakeResp(
        200, {"data": [{"id": "t-9", "status": "failed", "message": "内容风控"}]}))
    with pytest.raises(kai.KlingaiVideoError, match=r"内容风控（task_id=t-9）"):
        kai.render_video(prompt="p", model="kling-3.0", alias="td", output_dir=tmp_path / "o",
                         params={}, poll_interval=0)


def test_klingai_tuzi_uses_unified_videos_endpoint(tmp_path, monkeypatch):
    _td_key(tmp_path, monkeypatch, base_url="https://api.tu-zi.com/v1")
    posted = {}
    monkeypatch.setattr(kai.requests, "post", lambda url, headers=None, json=None, timeout=None: (
        posted.update(url=url, body=json) or _FakeResp(200, {"id": "tz-1", "status": "queued"})))

    def fake_get(url, headers=None, timeout=None):
        if url == "https://api.tu-zi.com/v1/videos/tz-1":
            return _FakeResp(200, {"id": "tz-1", "status": "completed",
                                   "video_url": "https://cdn/tz.mp4"})
        assert url == "https://cdn/tz.mp4" and headers is None
        return _FakeResp(200, {})

    monkeypatch.setattr(kai.requests, "get", fake_get)
    out = kai.render_video(prompt="p", model="kling-4.0", alias="td", output_dir=tmp_path / "o",
                           params={"duration": 3, "resolution": "720p"}, poll_interval=0)
    assert posted["url"] == "https://api.tu-zi.com/v1/videos"
    assert posted["body"] == {"model": "kling-4.0",
                              "contents": [{"type": "prompt", "text": "p"}],
                              "settings": {"resolution": "720p", "duration": 3}}
    assert Path(out[0]).read_bytes() == b"MP4"


def test_klingai_submit_network_error_is_unconfirmed_and_not_retried(tmp_path, monkeypatch):
    _td_key(tmp_path, monkeypatch)
    calls, attempts = {"n": 0}, []

    def boom(*a, **k):
        calls["n"] += 1
        raise requests.ConnectionError("reset")

    monkeypatch.setattr(kai.requests, "post", boom)
    with pytest.raises(kai.KlingaiVideoError, match="视频提交结果未确认"):
        kai.render_video(prompt="p", model="kling-4.0", alias="td", output_dir=tmp_path / "o",
                         params={}, poll_interval=0, on_submission=attempts.append)
    assert calls["n"] == 1
    assert attempts[-1]["outcome"] == "unconfirmed"
