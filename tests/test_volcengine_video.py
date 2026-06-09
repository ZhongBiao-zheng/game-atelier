from __future__ import annotations

import json
from pathlib import Path

import pytest

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import volcengine_video as vv


class _FakeResp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")

    @property
    def content(self) -> bytes:
        return b"\x00\x00\x00\x18ftypmp42fake-mp4-bytes"


@pytest.fixture
def seedance_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    _keys.add_key(_keys.KeySpec(
        alias="ark",
        provider="seedance",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="ark-fake",
        created_at="2026-06-09T00:00:00+00:00",
    ))
    return tmp_path


def test_submit_returns_inline_url(seedance_key, tmp_path, monkeypatch):
    posted = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        posted["url"] = url
        posted["body"] = json
        return _FakeResp(200, {"data": {"video_url": "https://cdn.x/v.mp4"}})

    def fake_get(url, headers=None, timeout=None):
        return _FakeResp(200, {"content": b"\x00\x00\x00\x18ftyp"})

    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv.requests, "post", fake_post)
    # download fetch
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: str(Path(d) / "v1.mp4"))

    out = vv.render_video(
        prompt="a calm sea",
        model="doubao-seedance-2-0-fast-260128",
        alias="ark",
        output_dir=tmp_path / "out",
        params={"duration": 5, "resolution": "720p", "frame_mode": "auto"},
        poll_interval=0,
    )
    assert out == [str(tmp_path / "out" / "v1.mp4")]
    assert posted["url"].endswith("/contents/generations/tasks")
    assert posted["body"]["model"] == "doubao-seedance-2-0-fast-260128"
    assert posted["body"]["content"][0] == {"type": "text", "text": "a calm sea"}
    assert posted["body"]["duration"] == 5
    assert posted["body"]["resolution"] == "720p"


def test_poll_until_succeeded(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "task-1"}}))

    calls = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            return _FakeResp(200, {"data": {"status": "running"}})
        return _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://cdn.x/done.mp4"}})

    monkeypatch.setattr(vv.requests, "get", fake_get)
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: str(Path(d) / "v1.mp4"))

    out = vv.render_video(
        prompt="p", model="", alias="ark",
        output_dir=tmp_path / "out", params={}, poll_interval=0,
    )
    assert out == [str(tmp_path / "out" / "v1.mp4")]
    assert calls["n"] == 3


def test_poll_failure_raises(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t"}}))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {"status": "failed", "message": "bad prompt"}}))
    with pytest.raises(vv.VolcengineVideoError, match="bad prompt"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", params={}, poll_interval=0)


def test_firstlast_roles(seedance_key, tmp_path, monkeypatch):
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"frame_mode": "firstlast", "reference_images": ["a.png", "b.png"]},
        poll_interval=0,
    )
    parts = posted["body"]["content"]
    assert parts[1]["role"] == "first_frame"
    assert parts[2]["role"] == "last_frame"
