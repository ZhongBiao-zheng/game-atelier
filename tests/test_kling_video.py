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
