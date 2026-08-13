"""HappyHorse（阿里百炼 DashScope）视频 caller 契约测试（mock HTTP，不真打 API）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import happyhorse_video as hh
from character_workflow.lib.callers import video_poll

_INPUT_CLIP = "https://cdn.x/user-input.mp4"


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


def _done(url: str = "https://cdn.ali/out.mp4") -> dict:
    return {"output": {"task_status": "SUCCEEDED", "video_url": url}}


@pytest.fixture
def dashscope_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    _keys.add_key(_keys.KeySpec(
        alias="ali",
        provider="custom",  # KeySpec.provider 无 happyhorse 字面量，路由靠 protocol 不靠它
        base_url="https://dashscope.aliyuncs.com/api/v1",
        access_key="sk-fake",
        created_at="2026-08-13T00:00:00+00:00",
    ))
    return tmp_path


def _render(tmp_path, *, model="happyhorse-1.0-t2v", params=None, **kw):
    return hh.render_video(
        prompt="p", model=model, alias="ali", output_dir=tmp_path / "o",
        params=params or {}, poll_interval=0, **kw,
    )


def test_render_submits_polls_downloads(dashscope_key, tmp_path, monkeypatch):
    posted = {}
    monkeypatch.setattr(hh.requests, "post", lambda url, headers=None, json=None, timeout=None: (
        posted.update(url=url, headers=headers) or _FakeResp(200, {"output": {"task_id": "h-1"}})))
    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(200, _done()))

    out = _render(tmp_path)
    assert posted["url"].endswith("/services/aigc/video-generation/video-synthesis")
    assert posted["headers"]["X-DashScope-Async"] == "enable"
    assert Path(out[0]).read_bytes() == b"MP4"


def test_poll_recovers_from_transient_network_error(dashscope_key, tmp_path, monkeypatch):
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-1"}}))
    calls = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        if headers is None:  # _download_mp4 不带 headers
            return _FakeResp(200, {})
        calls["n"] += 1
        if calls["n"] <= 2:
            raise requests.ConnectionError("Connection reset by peer")
        return _FakeResp(200, _done())

    monkeypatch.setattr(hh.requests, "get", fake_get)
    # max_polls=1：抖动若吃预算就会当场超时。
    assert _render(tmp_path, max_polls=1)
    assert calls["n"] == 3


def test_poll_transient_5xx_is_not_task_failure(dashscope_key, tmp_path, monkeypatch):
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-1"}}))
    seq = [_FakeResp(503, {"message": "busy"}), _FakeResp(200, _done())]

    def fake_get(url, headers=None, timeout=None):
        return _FakeResp(200, {}) if headers is None else seq.pop(0)

    monkeypatch.setattr(hh.requests, "get", fake_get)
    assert _render(tmp_path, max_polls=1)


def test_abandon_after_consecutive_failures_names_task_id(dashscope_key, tmp_path, monkeypatch):
    monkeypatch.setattr(video_poll, "_TRANSIENT_WINDOW_SECONDS", 3.0)
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-lost"}}))

    def always_down(url, headers=None, timeout=None):
        raise requests.ConnectionError("dns failure")

    monkeypatch.setattr(hh.requests, "get", always_down)
    with pytest.raises(hh.HappyHorseVideoError, match="h-lost"):
        _render(tmp_path)


def test_failure_timeout_and_missing_url_carry_task_id(dashscope_key, tmp_path, monkeypatch):
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-9"}}))

    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(
        200, {"output": {"task_status": "FAILED", "message": "invalid prompt"}}))
    with pytest.raises(hh.HappyHorseVideoError, match="h-9"):
        _render(tmp_path)

    # task_id 仅 24h 有效，过期后上游回 UNKNOWN —— 报错同样要带上标识便于对账。
    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(
        200, {"output": {"task_status": "UNKNOWN"}}))
    with pytest.raises(hh.HappyHorseVideoError, match="h-9"):
        _render(tmp_path)

    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(
        200, {"output": {"task_status": "RUNNING"}}))
    with pytest.raises(hh.HappyHorseVideoError, match="h-9"):
        _render(tmp_path, max_polls=2)


def test_download_failure_carries_task_id_and_source_url(dashscope_key, tmp_path, monkeypatch):
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-dl"}}))

    def fake_get(url, headers=None, timeout=None):
        if headers is None:
            raise requests.ConnectionError("reset")
        return _FakeResp(200, _done())

    monkeypatch.setattr(hh.requests, "get", fake_get)
    with pytest.raises(hh.HappyHorseVideoError) as excinfo:
        _render(tmp_path)
    assert "h-dl" in str(excinfo.value)
    assert "https://cdn.ali/out.mp4" in str(excinfo.value)


def test_toplevel_echoed_input_video_is_not_a_product(dashscope_key, tmp_path, monkeypatch):
    """video-edit 的输入视频只能是公网直链，正是最容易被回显成「产物」的东西。

    旧逻辑在 output 里找不到就兜底扫 payload 顶层的 url，扫到的是用户自己的输入原片，
    下载后 is_valid_video 当然通过（本来就是合法 mp4）→ job DONE、交付输入原片、零报错。
    现在只认 output 下的产物位置，找不到就明确报错。
    """
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-5"}}))
    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(200, {
        "url": _INPUT_CLIP,                       # 顶层回显输入
        "output": {"task_status": "SUCCEEDED"},   # 产物位置为空
    }))
    with pytest.raises(hh.HappyHorseVideoError, match="未返回视频地址"):
        _render(tmp_path, model="happyhorse-1.0-video-edit",
                params={"reference_videos": [_INPUT_CLIP]})


def test_echoed_input_inside_output_is_skipped_for_real_product(dashscope_key, tmp_path, monkeypatch):
    # output.url 是回显的输入、真产物在 output.results[] 里：按排除集跳过回显继续找。
    monkeypatch.setattr(hh.requests, "post", lambda *a, **k: _FakeResp(200, {"output": {"task_id": "h-6"}}))
    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(200, {"output": {
        "task_status": "SUCCEEDED",
        "url": _INPUT_CLIP,
        "results": [{"video_url": "https://cdn.ali/real.mp4"}],
    }}))
    got = {}
    monkeypatch.setattr(hh, "_download_mp4", lambda url, d, i, **kw: (got.update(url=url) or "ok"))

    _render(tmp_path, model="happyhorse-1.0-video-edit", params={"reference_videos": [_INPUT_CLIP]})
    assert got["url"] == "https://cdn.ali/real.mp4"
