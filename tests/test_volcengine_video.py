from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import video_poll
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: str(Path(d) / "v1.mp4"))

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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
    common = dict(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", poll_interval=0)
    vv.render_video(**common, params={"generate_audio": False})
    assert bodies[-1]["generate_audio"] is False
    vv.render_video(**common, params={"generate_audio": True})
    assert bodies[-1]["generate_audio"] is True
    vv.render_video(**common, params={})
    assert "generate_audio" not in bodies[-1]


def test_watermark_explicit_passthrough(seedance_key, tmp_path, monkeypatch):
    bodies: list[dict] = []
    monkeypatch.setattr(
        vv.requests, "post",
        lambda url, headers=None, json=None, timeout=None: (
            bodies.append(json) or _FakeResp(200, {"data": {"video_url": "https://x/v.mp4"}})
        ),
    )
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
    common = dict(prompt="p", model="", alias="ark", output_dir=tmp_path / "o", poll_interval=0)
    vv.render_video(**common, params={"watermark": True})
    assert bodies[-1]["watermark"] is True
    vv.render_video(**common, params={"watermark": False})
    assert bodies[-1]["watermark"] is False


def test_on_phase_called_sent_then_downloading(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t1"}}))
    monkeypatch.setattr(
        vv.requests, "get",
        lambda *a, **k: _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://x/v.mp4"}}),
    )
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: str(Path(d) / "v1.mp4"))

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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")
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
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: (picked.update(url=url) or str(Path(d) / "v1.mp4")))

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


# ---------------------------------------------------------------- 轮询期网络抖动

_INPUT_CLIP = "https://cdn.x/user-input.mp4"


def _echo_payload(status: str, *, with_output: bool) -> dict:
    """复刻上游成功响应回显输入的形状：content[] 正是请求体里那个键。"""
    data: dict = {
        "status": status,
        "content": [{
            "type": "video_url",
            "video_url": {"url": _INPUT_CLIP},
            "role": "reference_video",
        }],
    }
    if with_output:
        data["video_url"] = "https://cdn.x/real-output.mp4"
    return {"data": data}


def test_poll_recovers_from_transient_network_error(seedance_key, tmp_path, monkeypatch):
    # 轮询窗口 15-30 分钟，期间 Clash 切节点 / DNS 抖动是常态。抖一下就把已计费的
    # 任务判死 = 画师重试再付一次钱。抖动必须可恢复，且不吃 max_polls 预算。
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-1"}}))
    calls = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise requests.ConnectionError("Connection reset by peer")
        return _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://cdn.x/o.mp4"}})

    monkeypatch.setattr(vv.requests, "get", fake_get)
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4",
                        lambda url, d, i, **kw: (picked.update(url=url) or str(Path(d) / "v1.mp4")))

    # max_polls=1：两次网络异常若被计入预算就会当场超时，能出片才说明预算没被偷吃。
    out = vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                          params={}, max_polls=1, poll_interval=0)
    assert out == [str(tmp_path / "o" / "v1.mp4")]
    assert picked["url"] == "https://cdn.x/o.mp4"
    assert calls["n"] == 3


def test_poll_transient_5xx_is_not_task_failure(seedance_key, tmp_path, monkeypatch):
    # 网关 5xx 不是任务结论，判死会误杀正在跑的计费任务。
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-1"}}))
    seq = [_FakeResp(503, {"error": "upstream busy"}),
           _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://cdn.x/o.mp4"}})]
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: seq.pop(0))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")

    assert vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                           params={}, max_polls=1, poll_interval=0) == ["ok"]


def test_poll_abandon_after_consecutive_failures_names_task_id(seedance_key, tmp_path, monkeypatch):
    # 放弃是允许的，但必须交出 task_id：上游任务照跑照计费，人工得能凭它把片子取回来。
    monkeypatch.setattr(video_poll, "_TRANSIENT_WINDOW_SECONDS", 3.0)
    monkeypatch.setattr(vv.requests, "post",
                        lambda *a, **k: _FakeResp(200, {"data": {"id": "cgt-abc-123"}}))

    def always_down(url, headers=None, timeout=None):
        raise requests.ConnectionError("dns failure")

    monkeypatch.setattr(vv.requests, "get", always_down)
    with pytest.raises(vv.VolcengineVideoError, match="cgt-abc-123"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, poll_interval=0)


def test_poll_http_4xx_carries_task_id(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-42"}}))
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: _FakeResp(403, {"error": {"message": "model not enabled"}}))
    with pytest.raises(vv.VolcengineVideoError, match="t-42"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, poll_interval=0)


def test_task_failure_and_timeout_carry_task_id(seedance_key, tmp_path, monkeypatch):
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-77"}}))
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: _FakeResp(200, {"data": {"status": "failed", "message": "bad prompt"}}))
    with pytest.raises(vv.VolcengineVideoError, match="t-77"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, poll_interval=0)

    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {"status": "running"}}))
    with pytest.raises(vv.VolcengineVideoError, match="t-77"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, max_polls=2, poll_interval=0)


def test_download_failure_carries_task_id_and_source_url(seedance_key, tmp_path, monkeypatch):
    # 走到下载失败时片子已经出好也已计费，只是没拉下来；报错不带标识 = 产物彻底丢。
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-dl"}}))

    def fake_get(url, headers=None, timeout=None):
        if headers is None:  # 下载（_download_mp4 不带 headers）
            raise requests.ConnectionError("reset")
        return _FakeResp(200, {"data": {"status": "succeeded", "video_url": "https://cdn.x/o.mp4"}})

    monkeypatch.setattr(vv.requests, "get", fake_get)
    with pytest.raises(vv.VolcengineVideoError) as excinfo:
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={}, poll_interval=0)
    assert "t-dl" in str(excinfo.value)
    assert "https://cdn.x/o.mp4" in str(excinfo.value)


# ------------------------------------------------------- 回显的输入视频不是产物


def test_echoed_input_video_not_downloaded(seedance_key, tmp_path, monkeypatch):
    """参考视频按契约必须是公网直链，剥掉 query 就是 .mp4 —— 扩展名过滤拦不住。

    容器优先下钻会先抓到 content[] 里回显的输入，旧逻辑直接把它当产物下载：
    is_valid_video 当然过（本来就是合法 mp4），job 标 DONE，交付的是用户自己的输入原片。
    """
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-1"}}))
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: _FakeResp(200, _echo_payload("succeeded", with_output=True)))
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4",
                        lambda url, d, i, **kw: (picked.update(url=url) or "ok"))

    vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                    params={"reference_videos": [_INPUT_CLIP]}, poll_interval=0)
    assert picked["url"] == "https://cdn.x/real-output.mp4"


def test_success_with_only_echoed_input_refuses_to_deliver(seedance_key, tmp_path, monkeypatch):
    # 排干净后没有候选就报错，绝不退回列表首个（那正好是回显的输入原片）。
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-9"}}))
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: _FakeResp(200, _echo_payload("succeeded", with_output=False)))
    with pytest.raises(vv.VolcengineVideoError, match="未返回视频地址"):
        vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                        params={"reference_videos": [_INPUT_CLIP]}, poll_interval=0)


def test_submit_echo_is_not_taken_as_inline_output(seedance_key, tmp_path, monkeypatch):
    # 提交阶段比轮询更危险：那里连 status 门都没有，回显会被当成「同步直出」下载。
    monkeypatch.setattr(
        vv.requests, "post",
        lambda *a, **k: _FakeResp(200, {"data": {
            "id": "t-5",
            "content": [{"type": "video_url", "video_url": {"url": _INPUT_CLIP}}],
        }}),
    )
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: _FakeResp(200, _echo_payload("succeeded", with_output=True)))
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4",
                        lambda url, d, i, **kw: (picked.update(url=url) or "ok"))

    vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                    params={"reference_videos": [_INPUT_CLIP]}, poll_interval=0)
    assert picked["url"] == "https://cdn.x/real-output.mp4", "提交回显不该被当成直出产物"


def test_submit_inline_output_still_short_circuits(seedance_key, tmp_path, monkeypatch):
    # 加了排除/状态门之后，真正的「提交即直出」快路径必须还在。
    monkeypatch.setattr(vv.requests, "post",
                        lambda *a, **k: _FakeResp(200, {"data": {"video_url": "https://cdn.x/inline.mp4"}}))
    polled = {"n": 0}
    monkeypatch.setattr(vv.requests, "get",
                        lambda *a, **k: (polled.update(n=polled["n"] + 1) or _FakeResp(200, {})))
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4",
                        lambda url, d, i, **kw: (picked.update(url=url) or "ok"))

    vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                    params={}, poll_interval=0)
    assert picked["url"] == "https://cdn.x/inline.mp4"
    assert polled["n"] == 0


def test_oss_presigned_reference_video_is_excluded(seedance_key, tmp_path, monkeypatch):
    # 本地参考视频经 OSS 变成预签名直链后再发出去，回显时 query 可能被改写。
    local = tmp_path / "clip.mp4"
    local.write_bytes(b"mp4")
    monkeypatch.setattr(vv.oss_upload, "upload_for_url",
                        lambda p: "https://bucket.oss.example/refs/abc.mp4?sig=1")
    monkeypatch.setattr(vv.requests, "post", lambda *a, **k: _FakeResp(200, {"data": {"id": "t-2"}}))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {
        "status": "succeeded",
        "content": [{"url": "https://bucket.oss.example/refs/abc.mp4?sig=REWRITTEN"}],
        "video_url": "https://cdn.x/real-output.mp4",
    }}))
    picked = {}
    monkeypatch.setattr(vv, "_download_mp4",
                        lambda url, d, i, **kw: (picked.update(url=url) or "ok"))

    vv.render_video(prompt="p", model="", alias="ark", output_dir=tmp_path / "o",
                    params={"reference_videos": [str(local)]}, poll_interval=0)
    assert picked["url"] == "https://cdn.x/real-output.mp4"


def test_reference_limits_are_per_generation_not_family_wide():
    """参考素材上限按代际取 —— 旧版全族硬截 9/3/3，把 2.5 的参考矩阵砍掉三分之二。

    官方：2.0 系（含 fast / mini）图9/视频3/音频3；2.5 图30/视频10/音频10。
    """
    assert vv.seedance_limits("doubao-seedance-2-0-260128").max_images == 9
    assert vv.seedance_limits("seedance-2.0-fast").max_videos == 3
    assert vv.seedance_limits("seedance-2.0-mini").max_audios == 3
    assert vv.seedance_limits("seedance-2.5").max_images == 30
    assert vv.seedance_limits("doubao-seedance-2-5-260628").max_videos == 10
    assert vv.seedance_limits("").max_images == 9  # 未知模型走保守值


def test_seedance_25_keeps_more_than_nine_reference_images(seedance_key, tmp_path, monkeypatch):
    """2.5 传 12 张参考图应当全发出去；旧版会在第 9 张截断。"""
    urls = [f"https://cdn.x/ref{i}.png" for i in range(12)]
    seen: dict = {}
    monkeypatch.setattr(vv.requests, "post",
                        lambda url, **kw: (seen.update(kw.get("json") or {})
                                           or _FakeResp(200, {"data": {"id": "t-1"}})))
    monkeypatch.setattr(vv.requests, "get", lambda *a, **k: _FakeResp(200, {"data": {
        "status": "succeeded", "video_url": "https://cdn.x/out.mp4",
    }}))
    monkeypatch.setattr(vv, "_download_mp4", lambda url, d, i, **kw: "ok")

    vv.render_video(prompt="p", model="seedance-2.5", alias="ark", output_dir=tmp_path / "o",
                    params={"reference_images": urls, "frame_mode": "auto"}, poll_interval=0)

    images = [c for c in seen["content"] if c.get("type") == "image_url"]
    assert len(images) == 12
