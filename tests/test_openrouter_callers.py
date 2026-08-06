"""OpenRouter 图片 / 视频 caller 契约测试（mock HTTP，不真打 API）。"""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import dispatch, openrouter_image, openrouter_video
from character_workflow.lib.keys import KeySpec

_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


@pytest.fixture
def openrouter_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / ".runtime").mkdir(parents=True, exist_ok=True)
    keys.add_key(
        KeySpec(
            alias="OpenRouter",
            provider="openrouter",
            base_url="https://openrouter.ai/api/v1",
            access_key="AK-openrouter",
            secret_key=None,
            capabilities=["portrait"],
            models=[],
            notes="",
            created_at="2026-08-06T00:00:00Z",
        )
    )
    return tmp_path


def test_image_payload_ratio_maps_to_aspect_ratio():
    payload = openrouter_image._image_payload(
        prompt="p", model="bytedance-seed/seedream-4.5", n=2,
        kwargs={"size": "16:9", "params": {"resolution": "2k"}},
    )
    assert payload["aspect_ratio"] == "16:9"
    assert payload["resolution"] == "2K"
    assert payload["n"] == 2
    assert "size" not in payload
    assert "quality" not in payload  # 非 gpt-image 族不发 quality


def test_image_payload_pixel_size_is_authoritative():
    # 显式 WxH 透传 size，且不与 aspect_ratio/resolution 同发（OpenRouter 同发 400）。
    payload = openrouter_image._image_payload(
        prompt="p", model="openai/gpt-image-2", n=1,
        kwargs={"size": "2048x2048", "params": {"resolution": "2K", "quality": "medium"}},
    )
    assert payload["size"] == "2048x2048"
    assert "aspect_ratio" not in payload
    assert "resolution" not in payload
    assert payload["quality"] == "medium"  # gpt-image 尾段发 quality


def test_image_payload_references_become_input_references(tmp_path):
    ref = tmp_path / "ref.png"
    ref.write_bytes(_PNG)
    payload = openrouter_image._image_payload(
        prompt="p", model="openai/gpt-image-2", n=1,
        kwargs={"params": {"reference_images": [str(ref)]}},
    )
    refs = payload["input_references"]
    assert refs[0]["type"] == "image_url"
    assert refs[0]["image_url"]["url"].startswith("data:image/png;base64,")


def test_dispatch_openrouter_render_writes_b64_outputs(openrouter_key, tmp_path, monkeypatch):
    calls = {}

    def fake_post_json(url, api_key, payload, *, timeout):
        calls["url"] = url
        calls["payload"] = payload
        return {"data": [{"b64_json": base64.b64encode(_PNG).decode()}]}

    monkeypatch.setattr(openrouter_image, "_post_json", fake_post_json)
    out = tmp_path / "out"
    paths = dispatch(
        prompt="a cat", model="openai/gpt-image-2", alias="OpenRouter",
        output_dir=out, n=1, params={"size": "1:1", "quality": "medium"},
    )
    assert calls["url"] == "https://openrouter.ai/api/v1/images"
    assert calls["payload"]["aspect_ratio"] == "1:1"
    assert len(paths) == 1
    assert Path(paths[0]).read_bytes() == _PNG


def test_video_body_frame_modes(tmp_path):
    first = tmp_path / "a.png"
    last = tmp_path / "b.png"
    first.write_bytes(_PNG)
    last.write_bytes(_PNG)

    body = openrouter_video._build_body(
        "p", "google/veo-3.1",
        {"reference_images": [str(first), str(last)], "frame_mode": "firstlast",
         "duration": 5, "resolution": "720p", "ratio": "16:9", "generate_audio": False},
    )
    assert [f["frame_type"] for f in body["frame_images"]] == ["first_frame", "last_frame"]
    assert "input_references" not in body
    assert body["duration"] == 5
    assert body["resolution"] == "720p"
    assert body["aspect_ratio"] == "16:9"
    assert body["generate_audio"] is False

    # frame_mode=auto → 参考图走 input_references（reference-to-video）
    body = openrouter_video._build_body(
        "p", "google/veo-3.1", {"reference_images": [str(first)], "frame_mode": "auto"},
    )
    assert "frame_images" not in body
    assert body["input_references"][0]["type"] == "image_url"


def test_video_render_submits_polls_downloads(openrouter_key, tmp_path, monkeypatch):
    seen = {"posts": 0, "polls": 0}

    class FakeResp:
        def __init__(self, payload=None, content=b""):
            self._payload = payload
            self.content = content
            self.ok = True
            self.status_code = 200

        def json(self):
            return self._payload

        def raise_for_status(self):
            return None

    def fake_post(url, *, headers, json, timeout):
        seen["posts"] += 1
        assert url == "https://openrouter.ai/api/v1/videos"
        return FakeResp({"id": "job1", "polling_url": f"{url}/job1", "status": "pending"})

    def fake_get(url, *, headers, timeout):
        if url.endswith("/content?index=0"):
            return FakeResp(content=b"MP4DATA")
        seen["polls"] += 1
        status = "pending" if seen["polls"] < 2 else "completed"
        payload = {"id": "job1", "status": status}
        if status == "completed":
            payload["unsigned_urls"] = [
                "https://openrouter.ai/api/v1/videos/job1/content?index=0"
            ]
        return FakeResp(payload)

    monkeypatch.setattr(openrouter_video.requests, "post", fake_post)
    monkeypatch.setattr(openrouter_video.requests, "get", fake_get)

    paths = openrouter_video.render_video(
        prompt="p", model="google/veo-3.1", alias="OpenRouter",
        output_dir=tmp_path / "vid", params={}, poll_interval=0,
    )
    assert seen["posts"] == 1
    assert Path(paths[0]).read_bytes() == b"MP4DATA"


def test_video_render_failed_status_raises(openrouter_key, tmp_path, monkeypatch):
    class FakeResp:
        ok = True
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    monkeypatch.setattr(
        openrouter_video.requests, "post",
        lambda url, **kw: FakeResp({"id": "j", "polling_url": "https://x/videos/j"}),
    )
    monkeypatch.setattr(
        openrouter_video.requests, "get",
        lambda url, **kw: FakeResp({"status": "failed", "error": "Content policy violation"}),
    )
    with pytest.raises(openrouter_video.OpenRouterVideoError, match="Content policy"):
        openrouter_video.render_video(
            prompt="p", model="openai/sora-2-pro", alias="OpenRouter",
            output_dir=tmp_path / "vid", params={}, poll_interval=0,
        )
