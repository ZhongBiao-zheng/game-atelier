from __future__ import annotations

import base64
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


def test_generate_audio_explicit_passthrough(seedance_key, tmp_path, monkeypatch):
    """上游 generate_audio 默认 true：关闭必须显式发 false，省略字段≠关闭。"""
    bodies: list[dict] = []
    monkeypatch.setattr(
        vv.requests, "post",
        lambda url, headers=None, json=None, timeout=None: (
            bodies.append(json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})
        ),
    )
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    common = dict(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", poll_interval=0)
    vv.render_video(**common, params={"generate_audio": False})
    assert bodies[-1]["generate_audio"] is False
    vv.render_video(**common, params={"generate_audio": True})
    assert bodies[-1]["generate_audio"] is True
    vv.render_video(**common, params={})
    assert "generate_audio" not in bodies[-1]


def test_on_phase_called_sent_then_downloading(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t1"}}))
    monkeypatch.setattr(
        vv.requests, "get",
        lambda *a, **k: _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://x/v.mp4"}}),
    )
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    phases: list[str] = []
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={}, poll_interval=0, on_phase=phases.append,
    )
    assert phases == ["sent", "downloading"]


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
    first = tmp_path / "a.png"
    first.write_bytes(b"png-a")
    last = tmp_path / "b.png"
    last.write_bytes(b"png-b")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"frame_mode": "firstlast", "reference_images": [str(first), str(last)]},
        poll_interval=0,
    )
    parts = posted["body"]["content"]
    assert parts[1]["role"] == "first_frame"
    assert parts[2]["role"] == "last_frame"


def test_last_only_role(seedance_key, tmp_path, monkeypatch):
    # 仅尾帧也是合法提交：frame_mode=last 时第 0 张参考图按 last_frame 角色发送。
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    last = tmp_path / "b.png"
    last.write_bytes(b"png-b")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"frame_mode": "last", "reference_images": [str(last)]},
        poll_interval=0,
    )
    assert posted["body"]["content"][1]["role"] == "last_frame"


def test_local_reference_image_inlined_as_data_url(seedance_key, tmp_path, monkeypatch):
    # Web 上传的参考图是本地绝对路径，Ark 拉不到 —— 提交前必须内联成 base64 data-url。
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"fake-png-bytes")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"reference_images": [str(ref)]}, poll_interval=0,
    )
    url = posted["body"]["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == b"fake-png-bytes"


def test_http_reference_image_passthrough(seedance_key, tmp_path, monkeypatch):
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"reference_images": ["https://cdn.x/hosted.png"]}, poll_interval=0,
    )
    assert posted["body"]["content"][1]["image_url"]["url"] == "https://cdn.x/hosted.png"


def test_missing_reference_image_raises(seedance_key, tmp_path):
    with pytest.raises(vv.VolcengineVideoError, match="读取参考图失败"):
        vv.render_video(
            prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
            params={"reference_images": [str(tmp_path / "gone.png")]}, poll_interval=0,
        )


def test_local_reference_video_without_oss_config_raises(seedance_key, tmp_path):
    # 视频参考上游显式拒 base64（must be a web url，2026-06-12 实测）；
    # 本地路径要走 OSS 中转，未配置 OSS 时必须给出明确报错。
    local = tmp_path / "clip.mp4"
    local.write_bytes(b"mp4")
    with pytest.raises(vv.VolcengineVideoError, match="尚未配置 OSS"):
        vv.render_video(
            prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
            params={"reference_videos": [str(local)]}, poll_interval=0,
        )


def test_local_reference_video_uploaded_via_oss(seedance_key, tmp_path, monkeypatch):
    # 本地视频 → OSS presigned 直链后再提交，content 里发的是直链而非本地路径。
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    local = tmp_path / "clip.mp4"
    local.write_bytes(b"mp4")
    monkeypatch.setattr(
        vv.oss_upload, "upload_for_url",
        lambda p: f"https://bucket.oss.example/video-refs/abc.mp4?sig=1&src={Path(p).name}",
    )
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"reference_videos": [str(local)]}, poll_interval=0,
    )
    part = posted["body"]["content"][1]
    assert part["role"] == "reference_video"
    assert part["video_url"]["url"].startswith("https://bucket.oss.example/video-refs/abc.mp4")


def test_local_reference_audio_inlined_as_data_url(seedance_key, tmp_path, monkeypatch):
    # 音频与视频不同：audio_url 官方支持 base64（2026-06-12 实测通过），本地文件内联发送。
    posted = {}
    monkeypatch.setattr(vv.requests, "post", lambda url, headers=None, json=None, timeout=None: (posted.update(body=json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: "ok")
    clip = tmp_path / "voice.mp3"
    clip.write_bytes(b"fake-mp3-bytes")
    vv.render_video(
        prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
        params={"reference_audios": [str(clip)]}, poll_interval=0,
    )
    url = posted["body"]["content"][1]["audio_url"]["url"]
    assert posted["body"]["content"][1]["role"] == "reference_audio"
    assert url.startswith("data:audio/mpeg;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == b"fake-mp3-bytes"


def test_oversize_reference_audio_rejected(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv, "_AUDIO_INLINE_MAX_BYTES", 4)
    clip = tmp_path / "big.mp3"
    clip.write_bytes(b"12345")
    with pytest.raises(vv.VolcengineVideoError, match="15MB"):
        vv.render_video(
            prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
            params={"reference_audios": [str(clip)]}, poll_interval=0,
        )


def test_skips_echoed_input_image(seedance_key, tmp_path, monkeypatch):
    # i2v：上游成功响应回显输入参考图（扁平 content[].url）+ 真输出视频地址。
    # 容器优先下钻会先抓到回显图；必须靠图片扩展名过滤挑出真视频。
    payload = {"data": {
        "status": "succeeded",
        "content": [{"type": "image_url", "url": "https://cdn.x/input-ref.png"}],
        "video_url": "https://cdn.x/output.mp4",
    }}
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, payload))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i: (picked.update(url=url) or str(Path(d) / "v1.mp4")))

    out = vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", params={}, poll_interval=0)
    assert picked["url"] == "https://cdn.x/output.mp4"
    assert out == [str(tmp_path / "o" / "v1.mp4")]


def test_poll_timeout_raises(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t"}}))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {"status": "running"}}))
    with pytest.raises(vv.VolcengineVideoError, match="轮询超时"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, max_polls=2, poll_interval=0)


def test_success_without_urls_raises(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t"}}))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {"status": "succeeded"}}))
    with pytest.raises(vv.VolcengineVideoError, match="未返回视频地址"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", params={}, poll_interval=0)


def test_submit_without_url_or_taskid_raises(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {}}))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {}))
    with pytest.raises(vv.VolcengineVideoError, match="task id"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", params={}, poll_interval=0)
