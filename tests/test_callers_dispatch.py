"""Alias-based caller dispatch protocol.

Verifies:
1. dispatch routes openai / custom aliases to openai_image render
2. dispatch("missing") raises NoSuchKeyError
3. video-only provider keys can be stored without dispatch regression
"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib import keys
from character_workflow.lib.callers import NoSuchKeyError, dispatch
from character_workflow.lib.keys import KeySpec


@pytest.fixture
def isolated_keys_db(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    (tmp_path / ".runtime").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _add(alias: str, provider: str, **overrides) -> KeySpec:
    spec = KeySpec(
        alias=alias,
        provider=provider,  # type: ignore[arg-type]
        base_url=overrides.pop("base_url", None),
        access_key=overrides.pop("access_key", "AK-" + alias),
        secret_key=overrides.pop("secret_key", "SK-" + alias),
        capabilities=overrides.pop("capabilities", ["portrait"]),
        models=overrides.pop("models", []),
        notes=overrides.pop("notes", ""),
        created_at=overrides.pop("created_at", "2026-05-22T00:00:00Z"),
    )
    keys.add_key(spec)
    return spec


def test_dispatch_custom_key_routes_to_openai_image(
    isolated_keys_db, tmp_path, monkeypatch,
):
    """custom Key（含 OpenAI-HK）一律走 openai_image 同步通道——聚合异步通道已随分类 API 删除。"""
    _add("hk", "custom", base_url="https://api.openai-hk.com/v1")
    seen = {}

    def fake_openai_render(*, prompt, model, alias, **kwargs):
        seen["where"] = "openai_image"
        seen["alias"] = alias
        return ["/tmp/hk-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.openai_image.render", fake_openai_render
    )

    paths = dispatch(
        prompt="x", model="gpt-image-2", alias="hk", output_dir=tmp_path / "out"
    )
    assert seen["where"] == "openai_image"
    assert seen["alias"] == "hk"
    assert paths == ["/tmp/hk-v1.png"]


def test_dispatch_unknown_alias_raises_no_such_key(isolated_keys_db):
    with pytest.raises(NoSuchKeyError, match="missing-alias"):
        dispatch(
            prompt="x",
            model="m",
            alias="missing-alias",
            output_dir=Path("/tmp/out"),
        )


def test_dispatch_routes_openai_alias_to_openai_image_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("oai-1", "openai")
    captured = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return ["/tmp/openai-v1.png"]

    monkeypatch.setattr(
        "character_workflow.lib.callers.openai_image.render",
        fake_render,
    )

    paths = dispatch(
        prompt="x",
        model="gpt-image-2",
        alias="oai-1",
        output_dir=tmp_path / "out",
    )

    assert paths == ["/tmp/openai-v1.png"]
    assert captured["alias"] == "oai-1"
    assert captured["model"] == "gpt-image-2"


def test_video_provider_keys_can_be_stored_without_dispatch_regression(isolated_keys_db):
    for provider in ["runway", "kling", "veo", "seedance"]:
        spec = KeySpec(
            alias=f"{provider}-main",
            provider=provider,  # type: ignore[arg-type]
            base_url=None,
            access_key="video-secret",
            secret_key=None,
            capabilities=["promo"],
            models=[{"name": provider.title(), "id": provider}],
            modalities=["video"],
            notes="",
            created_at="2026-05-26T18:30:00Z",
        )
        keys.add_key(spec)

    assert keys.find_by_alias("runway-main").modalities == ["video"]
    assert keys.find_by_alias("kling-main").models[0].id == "kling"


def test_dispatch_video_routes_seedance(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="ark", provider="seedance",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="ark-fake", created_at="2026-06-09T00:00:00+00:00",
    ))
    captured = {}

    def fake_render_video(*, prompt, model, alias, output_dir, params=None, **kw):
        captured.update(prompt=prompt, model=model, alias=alias)
        return ["/abs/v1.mp4"]

    from character_workflow.lib.callers import volcengine_video
    monkeypatch.setattr(volcengine_video, "render_video", fake_render_video)

    out = callers.dispatch_video(
        prompt="sea", model="doubao-seedance-2-0-fast-260128", alias="ark",
        output_dir=tmp_path, params={"duration": 5},
    )
    assert out == ["/abs/v1.mp4"]
    assert captured["alias"] == "ark"


def test_dispatch_video_rejects_unwired_provider(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="kl", provider="kling", access_key="x", created_at="2026-06-09T00:00:00+00:00",
    ))
    with pytest.raises(callers.WrongProviderError):
        callers.dispatch_video(prompt="p", model="m", alias="kl", output_dir=tmp_path, params={})


# ---- happyhorse（阿里百炼 DashScope 协议，经词元跳动网关）----


@pytest.fixture
def tokendance_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    keys.add_key(KeySpec(
        alias="td", provider="tokendance",
        base_url="https://tokendance.space/gateway/v1",
        access_key="td-fake", created_at="2026-06-11T00:00:00+00:00",
    ))
    return tmp_path


def test_dispatch_video_routes_tokendance_happyhorse(tokendance_key, tmp_path, monkeypatch):
    from character_workflow.lib import callers
    from character_workflow.lib.callers import happyhorse_video
    captured = {}

    def fake_render_video(*, prompt, model, alias, output_dir, params=None, **kw):
        captured.update(model=model, alias=alias)
        return ["/abs/v1.mp4"]

    monkeypatch.setattr(happyhorse_video, "render_video", fake_render_video)
    out = callers.dispatch_video(
        prompt="p", model="happyhorse-1.0-t2v", alias="td",
        output_dir=tmp_path, params={},
    )
    assert out == ["/abs/v1.mp4"]
    assert captured["model"] == "happyhorse-1.0-t2v"


class _FakeResp:
    def __init__(self, payload: dict):
        self.status_code = 200
        self.ok = True
        self.text = ""
        self._payload = payload

    def json(self):
        return self._payload


def _mock_happyhorse_upstream(monkeypatch, posted: dict):
    from character_workflow.lib.callers import happyhorse_video as hh

    def fake_post(url, headers=None, json=None, timeout=None):
        posted.update(url=url, headers=headers, body=json)
        return _FakeResp({"output": {"task_id": "t-1", "task_status": "PENDING"}})

    monkeypatch.setattr(hh.requests, "post", fake_post)
    monkeypatch.setattr(hh.requests, "get", lambda *a, **k: _FakeResp(
        {"output": {"task_status": "SUCCEEDED", "video_url": "https://cdn.x/v.mp4"}}
    ))
    monkeypatch.setattr(hh, "_download_mp4", lambda url, d, i, **kw: str(d / f"v{i}.mp4"))
    return hh


def test_happyhorse_t2v_body_follows_dashscope_contract(tokendance_key, tmp_path, monkeypatch):
    posted: dict = {}
    hh = _mock_happyhorse_upstream(monkeypatch, posted)
    out = hh.render_video(
        prompt="马奔跑", model="happyhorse-1.0-t2v", alias="td",
        output_dir=tmp_path / "o",
        params={"duration": 5, "resolution": "720p", "ratio": "16:9", "seed": 42},
        poll_interval=0,
    )
    assert out == [str(tmp_path / "o" / "v1.mp4")]
    # 词元跳动网关 URL 改写：剥 /v1 → /alibaba/happyhorse/v1/video-synthesis
    assert posted["url"] == "https://tokendance.space/gateway/alibaba/happyhorse/v1/video-synthesis"
    assert posted["headers"]["X-DashScope-Async"] == "enable"
    body = posted["body"]
    assert body["model"] == "happyhorse-1.0-t2v"
    assert body["input"] == {"prompt": "马奔跑"}  # t2v 无 media
    assert body["parameters"]["resolution"] == "720P"  # 官方要求大写 P
    assert body["parameters"]["watermark"] is False  # 官方默认 true，必须显式关
    assert body["parameters"]["ratio"] == "16:9"
    assert body["parameters"]["duration"] == 5
    assert body["parameters"]["seed"] == 42


def test_happyhorse_i2v_maps_first_frame(tokendance_key, tmp_path, monkeypatch):
    posted: dict = {}
    hh = _mock_happyhorse_upstream(monkeypatch, posted)
    ref = tmp_path / "first.png"
    ref.write_bytes(b"png-bytes")
    hh.render_video(
        prompt="动起来", model="happyhorse-1.0-i2v", alias="td",
        output_dir=tmp_path / "o",
        params={"duration": 5, "resolution": "1080P", "ratio": "16:9",
                "reference_images": [str(ref)], "frame_mode": "first"},
        poll_interval=0,
    )
    media = posted["body"]["input"]["media"]
    assert len(media) == 1
    assert media[0]["type"] == "first_frame"
    assert media[0]["url"].startswith("data:image/png;base64,")
    # i2v 无 ratio（随首帧）
    assert "ratio" not in posted["body"]["parameters"]


def test_happyhorse_video_edit_drops_duration_and_requires_public_video(
    tokendance_key, tmp_path, monkeypatch,
):
    posted: dict = {}
    hh = _mock_happyhorse_upstream(monkeypatch, posted)
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"png-bytes")
    hh.render_video(
        prompt="换成雪景", model="happyhorse-1.0-video-edit", alias="td",
        output_dir=tmp_path / "o",
        params={"duration": 5, "ratio": "16:9", "resolution": "720P",
                "reference_videos": ["https://cdn.x/in.mp4"],
                "reference_images": [str(ref)]},
        poll_interval=0,
    )
    media = posted["body"]["input"]["media"]
    assert media[0] == {"type": "video", "url": "https://cdn.x/in.mp4"}
    assert media[1]["type"] == "reference_image"
    # edit 无 duration / ratio（随输入视频）
    assert "duration" not in posted["body"]["parameters"]
    assert "ratio" not in posted["body"]["parameters"]

    # 输入视频仅公网 URL，本地路径显式报错
    local = tmp_path / "in.mp4"
    local.write_bytes(b"mp4")
    with pytest.raises(hh.HappyHorseVideoError, match="公网"):
        hh.render_video(
            prompt="p", model="happyhorse-1.0-video-edit", alias="td",
            output_dir=tmp_path / "o",
            params={"reference_videos": [str(local)]}, poll_interval=0,
        )


def test_dispatch_video_routes_custom_by_explicit_protocol(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    from character_workflow.lib.callers import kling_video
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
        models=[_keys.ModelSpec(name="My", id="my-vid", modality="video", protocol="kling")],
    ))
    captured = {}

    def fake(*, prompt, model, alias, output_dir, params=None, **kw):
        captured["model"] = model
        return ["/abs/v1.mp4"]

    monkeypatch.setattr(kling_video, "render_video", fake)
    out = callers.dispatch_video(
        prompt="p", model="my-vid", alias="cu", output_dir=tmp_path, params={},
    )
    assert out == ["/abs/v1.mp4"]
    assert captured["model"] == "my-vid"


def test_dispatch_video_no_protocol_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
        models=[_keys.ModelSpec(name="Foo", id="foo-video-1", modality="video")],
    ))
    with pytest.raises(callers.WrongProviderError, match="无法识别"):
        callers.dispatch_video(
            prompt="p", model="foo-video-1", alias="cu", output_dir=tmp_path, params={},
        )


def test_dispatch_video_unknown_protocol_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib import callers
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
        models=[_keys.ModelSpec(name="Z", id="z", modality="video", protocol="bogus")],
    ))
    with pytest.raises(callers.WrongProviderError, match="未知视频协议"):
        callers.dispatch_video(
            prompt="p", model="z", alias="cu", output_dir=tmp_path, params={},
        )
