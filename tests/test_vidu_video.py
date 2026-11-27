"""Tests for Vidu Q4 / Q3 video protocol, routing, classification, and Tuzi /v1/videos caller."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import vidu_video
from character_workflow.lib.callers.video_registry import resolve_protocol
from character_workflow.lib.video_caps import first_last_video_defaults, vidu_spec
from viewer_server.routes import _classify_model


class _FakeResp:
    def __init__(self, status_code: int = 200, payload: dict | None = None, content: bytes = b""):
        self.status_code = status_code
        self._payload = payload
        self.content = content
        self.ok = 200 <= status_code < 300
        self.text = ""

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_resolve_protocol_and_classification_for_all_vidu_models():
    models = [
        "viduq4-preview", "viduq3-pro", "viduq3-pro-fast", "viduq3-turbo",
        "viduq3", "viduq3-drama", "viduq3-ad", "viduq3-mix",
    ]
    for model in models:
        assert vidu_spec(model) is not None
        assert resolve_protocol("custom", "https://api.tu-zi.com", model) == "vidu"
        assert resolve_protocol("custom", "https://api.openai-hk.com", model) is None
        assert _classify_model({"id": model}) == "video"


def test_first_last_video_defaults_respects_vidu_frame_support():
    assert first_last_video_defaults("vidu", "viduq3-pro", 1280, 720) == {
        "duration": 1, "resolution": "540p", "watermark": False,
    }
    assert first_last_video_defaults("vidu", "viduq3-pro-fast", 1280, 720) == {
        "duration": 1, "resolution": "720p", "watermark": False,
    }
    assert first_last_video_defaults("vidu", "viduq4-preview", 1280, 720) is None
    assert first_last_video_defaults("vidu", "viduq3-drama", 1280, 720) is None


def test_build_request_text_and_firstlast_and_reference(tmp_path):
    img1 = tmp_path / "a.png"
    img2 = tmp_path / "b.jpg"
    img1.write_bytes(b"\x89PNG\r\n\x1a\n1234")
    img2.write_bytes(b"\xff\xd8\xff\xe01234")

    # 1. viduq3-turbo textGenerate
    _spec, action, body = vidu_video.build_request("waves", "viduq3-turbo", {
        "duration": 1, "resolution": "540p", "ratio": "16:9", "generate_audio": True,
    })
    assert action == "textGenerate"
    assert body["metadata"] == {"action": "textGenerate", "duration": 1, "resolution": "540p"}
    assert body["aspect_ratio"] == "16:9"
    assert body["audio"] is True
    assert body["watermark"] is False
    assert "images" not in body

    # 2. viduq3-pro firstTailGenerate with local base64 images
    _spec, action, body = vidu_video.build_request("morph", "viduq3-pro", {
        "duration": 2, "resolution": "720p", "ratio": "16:9",
        "frame_mode": "firstlast", "reference_images": [str(img1), str(img2)],
        "generate_audio": False, "seed": 42,
    })
    assert action == "firstTailGenerate"
    assert body["metadata"]["action"] == "firstTailGenerate"
    assert "aspect_ratio" not in body  # 首尾帧无画幅参数
    assert body["audio"] is False
    assert body["seed"] == 42
    assert body["images"][0].startswith("data:image/png;base64,")
    assert body["images"][1].startswith("data:image/jpeg;base64,")

    # 3. viduq4-preview referenceGenerate with 2K normalization + audio URL
    _spec, action, body = vidu_video.build_request("cat moves", "viduq4-preview", {
        "duration": 3, "resolution": "2k", "ratio": "9:16",
        "reference_images": [str(img1)],
        "reference_audios": ["https://cdn.example/voice.mp3"],
        "generate_audio": True,
    })
    assert action == "referenceGenerate"
    assert body["resolution"] == "2K"
    assert body["metadata"] == {"action": "referenceGenerate", "duration": 3, "resolution": "2K"}
    assert body["aspect_ratio"] == "9:16"
    assert body["sounds"] == ["https://cdn.example/voice.mp3"]

    # 4. viduq3-drama maps adaptive -> auto and omits audio on viduq3-ad
    _spec, action, drama_body = vidu_video.build_request("dialogue", "viduq3-drama", {
        "duration": 4, "resolution": "720p", "ratio": "adaptive",
        "reference_images": [str(img1)], "generate_audio": True,
    })
    assert action == "referenceGenerate"
    assert drama_body["aspect_ratio"] == "auto"
    assert drama_body["audio"] is True

    _spec, action, ad_body = vidu_video.build_request("ad spot", "viduq3-ad", {
        "duration": 5, "resolution": "1080p", "ratio": "adaptive",
        "reference_images": [str(img1)], "generate_audio": True,
    })
    assert action == "referenceGenerate"
    assert "audio" not in ad_body


def test_build_request_rejects_invalid_combinations(tmp_path):
    img = tmp_path / "f.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    with pytest.raises(vidu_video.ViduVideoError, match="纯文生"):
        vidu_video.build_request("hi", "viduq4-preview", {"duration": 3})

    with pytest.raises(vidu_video.ViduVideoError, match="尾帧"):
        vidu_video.build_request("hi", "viduq3-pro", {"frame_mode": "last", "reference_images": [str(img)]})

    with pytest.raises(vidu_video.ViduVideoError, match="不支持分辨率"):
        vidu_video.build_request("hi", "viduq3-pro-fast", {
            "frame_mode": "first", "reference_images": [str(img)], "resolution": "540p",
        })

    with pytest.raises(vidu_video.ViduVideoError, match="3–15"):
        vidu_video.build_request("hi", "viduq3-turbo", {
            "duration": 1, "reference_images": [str(img)],
        })

    with pytest.raises(vidu_video.ViduVideoError, match="参考音频"):
        vidu_video.build_request("hi", "viduq3", {
            "duration": 3, "reference_images": [str(img)],
            "reference_audios": ["https://cdn.example/a.mp3"],
        })

    with pytest.raises(vidu_video.ViduVideoError, match="参考视频"):
        vidu_video.build_request("hi", "viduq4-preview", {
            "duration": 3, "reference_images": [str(img)],
            "reference_videos": ["https://cdn.example/v.mp4"],
        })


def test_render_video_polls_metadata_url_and_downloads_without_auth_leak(tmp_path, monkeypatch):
    fake_key = SimpleNamespace(
        alias="Tuzi", provider="custom", base_url="https://api.tu-zi.com", access_key="sk-secret",
    )
    monkeypatch.setattr(keys, "find_by_alias", lambda _a: fake_key)

    posted: list[dict] = []
    downloaded_headers: list[dict | None] = []

    def fake_post(url, headers=None, json=None, timeout=None):
        posted.append({"url": url, "body": json})
        return _FakeResp(200, {"id": "task_vidu_1", "status": "queued"})

    def fake_get(url, headers=None, timeout=None):
        if url.endswith("/task_vidu_1"):
            return _FakeResp(200, {
                "id": "task_vidu_1",
                "status": "completed",
                "metadata": {"url": "https://video.cf.vidu.com/out.mp4"},
            })
        downloaded_headers.append(headers)
        return _FakeResp(200, content=b"\x00\x00\x00\x18ftypmp42")

    monkeypatch.setattr("character_workflow.lib.callers.task_submission.requests.post", fake_post)
    monkeypatch.setattr("character_workflow.lib.callers.video_poll.requests.get", fake_get)
    monkeypatch.setattr("character_workflow.lib.callers.vidu_video.requests.get", fake_get)

    resumed_states: list[dict] = []
    paths = vidu_video.render_video(
        prompt="sunset",
        model="viduq3-turbo",
        alias="Tuzi",
        output_dir=tmp_path,
        params={"duration": 1, "resolution": "540p", "ratio": "16:9", "generate_audio": True},
        poll_interval=0.0,
        on_resume_state=resumed_states.append,
    )
    assert len(paths) == 1
    assert Path(paths[0]).read_bytes().startswith(b"\x00\x00\x00\x18ftyp")
    assert posted[0]["url"] == "https://api.tu-zi.com/v1/videos"
    assert downloaded_headers == [None]  # 绝不把 Tuzi Bearer key 发给第三方 CDN
    assert resumed_states[-1]["tasks"] == [{"id": "task_vidu_1"}]
