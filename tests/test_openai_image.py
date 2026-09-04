from __future__ import annotations

import base64
from http.client import IncompleteRead
import json
from pathlib import Path
import subprocess

import pytest
import requests

from character_workflow.lib import keys
from character_workflow.lib.callers import openai_image
from character_workflow.lib.keys import KeySpec

IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"


class FakeDownloadResponse:
    def __init__(
        self,
        content: bytes = b"",
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ):
        self.content = content
        self.status_code = status_code
        self.headers = headers or {"Content-Length": str(len(content))}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def iter_content(self, chunk_size: int):
        yield self.content


class FakePostResponse:
    def __init__(self, payload: dict, *, status_code: int = 200):
        self.payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return self.payload


def _add_key(*, alias: str, provider: str, base_url: str | None) -> None:
    keys.add_key(KeySpec(
        alias=alias,
        provider=provider,  # type: ignore[arg-type]
        base_url=base_url,
        access_key="test-key",
        secret_key=None,
        capabilities=["portrait"],
        models=[{"name": "GPT Image 2", "id": "gpt-image-2"}],
        created_at="2026-05-28T00:00:00Z",
    ))


def test_image_url_normalizes_openai_hk_root_to_v1_generations():
    assert (
        openai_image._chat_image_url("https://api.openai-hk.com")
        == "https://api.openai-hk.com/v1/chat/completions"
    )


def test_image_url_keeps_versioned_api_roots_and_repairs_wrong_endpoint():
    assert (
        openai_image._image_url("https://api.example.com/v1")
        == "https://api.example.com/v1/images/generations"
    )
    assert (
        openai_image._image_url("https://ark.cn-beijing.volces.com/api/v3")
        == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    )
    assert (
        openai_image._image_url("https://api.openai-hk.com/v1/chat/completions")
        == "https://api.openai-hk.com/v1/images/generations"
    )


def test_render_openai_provider_posts_to_image_endpoint_and_writes_data_url(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="openai", provider="openai", base_url="https://api.example.com/v1")
    image_bytes = b"\x89PNG\r\n\x1a\nfake"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        # setdefault 只留首次：单次只回 1 张时补足循环会再发 n=1 的请求（预期行为）。
        captured.setdefault("url", url)
        captured.setdefault("timeout", timeout)
        captured.setdefault("payload", json)
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="fox",
        model="gpt-image-2",
        alias="openai",
        output_dir=tmp_path,
        n=3,
        size="1024x1024",
    )

    assert captured["url"] == "https://api.example.com/v1/images/generations"
    assert captured["payload"]["model"] == "gpt-image-2"
    assert captured["payload"]["n"] == 3
    assert captured["payload"]["size"] == "1024x1024"
    assert captured["payload"]["response_format"] == "b64_json"
    assert Path(paths[0]).read_bytes() == image_bytes


@pytest.mark.parametrize("model", ["gpt-image-2", "gpt-image-2-1k"])
def test_render_tuzi_uses_async_tasks_and_reuses_persisted_ids(
    isolated_data_root,
    tmp_path,
    monkeypatch,
    model,
):
    _add_key(alias="Tuzi", provider="custom", base_url="https://api.tu-zi.com")
    image_bytes = b"\x89PNG\r\n\x1a\ntuzi"
    params = {"provider_task_protocol": "tuzi_async", "provider_task_ids": ["saved-1"]}
    calls: list[dict[str, object]] = []
    persisted: list[str] = []

    def fake_execute_json(**kwargs):
        calls.append(kwargs)
        return {
            "data": [{"b64_json": base64.b64encode(image_bytes).decode("ascii")}],
        }

    monkeypatch.setattr(openai_image.tuzi_async, "execute_json", fake_execute_json)

    paths = openai_image.render(
        prompt="fox",
        model=model,
        alias="Tuzi",
        output_dir=tmp_path,
        n=1,
        size="2048x2048",
        params=params,
        on_params_changed=lambda: persisted.extend(params["provider_task_ids"]),
    )

    assert calls[0]["url"] == "https://api.tu-zi.com/v1/images/generations"
    assert calls[0]["payload"]["model"] == model
    assert calls[0]["task_id"] == "saved-1"
    assert calls[0]["payload"]["size"] == "2048x2048"
    assert calls[0]["payload"].get("quality") is None
    assert persisted == []
    assert Path(paths[0]).read_bytes() == image_bytes


@pytest.mark.parametrize(
    ("model", "requested_quality", "outbound_model", "outbound_quality"),
    [
        (
            "nano-banana-pro-2k",
            "high",
            "gemini-3-pro-image-preview",
            "2k",
        ),
        (
            "nano-banana-pro-4k",
            "low",
            "gemini-3-pro-image-preview",
            "4k",
        ),
        (
            "nano-banana-2-2k",
            "high",
            "gemini-3.1-flash-image-preview",
            "2k",
        ),
        (
            "nano-banana-2-4k",
            "low",
            "gemini-3.1-flash-image-preview",
            "4k",
        ),
        (
            "nano-banana-pro-4k-vip",
            "high",
            "gemini-3-pro-image-preview-4k-vip",
            None,
        ),
    ],
)
def test_render_tuzi_routes_nano_models_to_billable_payloads(
    isolated_data_root,
    tmp_path,
    monkeypatch,
    model,
    requested_quality,
    outbound_model,
    outbound_quality,
):
    _add_key(alias="Tuzi", provider="custom", base_url="https://api.tu-zi.com")
    captured: dict[str, object] = {}

    def fake_execute_json(**kwargs):
        captured.update(kwargs)
        return {"data": [{
            "b64_json": base64.b64encode(b"\x89PNG\r\n\x1a\n4k").decode("ascii"),
        }]}

    monkeypatch.setattr(openai_image.tuzi_async, "execute_json", fake_execute_json)

    openai_image.render(
        prompt="banana cat",
        model=model,
        alias="Tuzi",
        output_dir=tmp_path,
        n=1,
        size="3:4",
        params={"quality": requested_quality},
    )

    assert captured["url"] == "https://api.tu-zi.com/v1/images/generations"
    assert captured["payload"]["model"] == outbound_model
    assert captured["payload"].get("quality") == outbound_quality


def test_render_tuzi_resume_never_submits_supplemental_billed_task(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="Tuzi", provider="custom", base_url="https://api.tu-zi.com")
    calls: list[str | None] = []
    params = {"provider_task_protocol": "tuzi_async", "provider_task_ids": ["saved-1"]}

    def fake_execute_json(**kwargs):
        calls.append(kwargs["task_id"])
        return {"data": [{
            "b64_json": base64.b64encode(b"\x89PNG\r\n\x1a\none").decode("ascii"),
        }]}

    monkeypatch.setattr(openai_image.tuzi_async, "execute_json", fake_execute_json)

    paths = openai_image.render(
        prompt="fox", model="gpt-image-2", alias="Tuzi", output_dir=tmp_path,
        n=2, size="2048x2048", params=params,
    )

    assert calls == ["saved-1"]
    assert len(paths) == 1
    assert "只返回了 1 张图" in params["warnings"][0]


@pytest.mark.parametrize("model", ["gpt-image-2", "gpt-image-2-1k"])
def test_render_tuzi_reference_edit_uses_async_multipart(
    isolated_data_root,
    tmp_path,
    monkeypatch,
    model,
):
    _add_key(alias="Tuzi", provider="custom", base_url="https://api.tu-zi.com")
    reference = tmp_path / "reference.png"
    reference.write_bytes(b"\x89PNG\r\n\x1a\nreference")
    image_bytes = b"\x89PNG\r\n\x1a\nedited"
    captured: dict[str, object] = {}

    def fake_execute_multipart(**kwargs):
        captured.update(kwargs)
        kwargs["on_task_id"]("edit-task-1")
        return {"data": [{"b64_json": base64.b64encode(image_bytes).decode("ascii")}]}

    monkeypatch.setattr(openai_image.tuzi_async, "execute_multipart", fake_execute_multipart)
    params: dict[str, object] = {}

    paths = openai_image.render(
        prompt="restyle",
        model=model,
        alias="Tuzi",
        output_dir=tmp_path / "out",
        n=1,
        size="2048x2048",
        source_image=str(reference),
        params=params,
    )

    assert captured["url"] == "https://api.tu-zi.com/v1/images/edits"
    assert captured["fields"]["model"] == model
    assert captured["files"][0][0] == "image"
    assert params["provider_task_ids"] == ["edit-task-1"]
    assert Path(paths[0]).read_bytes() == image_bytes


def test_post_json_retries_only_pre_flight_failures(monkeypatch):
    """连接**建立阶段**的失败没送达上游，重试安全。"""
    image_bytes = b"\x89PNG\r\n\x1a\nretry"
    calls = {"n": 0}

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "data": [{
                    "b64_json": "data:image/png;base64,"
                    + base64.b64encode(image_bytes).decode("ascii"),
                }]
            }

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise requests.ConnectionError("Failed to establish a new connection: refused")
        return FakeResponse()

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _seconds: None)

    data = openai_image._post_json(
        "https://api.example.test/v1/images/generations",
        "ak",
        {"model": "gpt-image-2"},
        timeout=10,
    )

    assert calls["n"] == 2
    assert data["data"][0]["b64_json"].startswith("data:image/png;base64,")


@pytest.mark.parametrize("error", [
    requests.ReadTimeout("Read timed out"),
    requests.ConnectionError(
        "('Connection aborted.', RemoteDisconnected('Remote end closed connection'))"
    ),
    requests.ConnectionError("Connection reset by peer"),
])
def test_post_json_never_retries_after_request_reached_upstream(error, monkeypatch):
    """请求已送达 = 上游可能正在出图：重试就是再买一次。

    同步出图端点在图出完前一个字节都不吐，所以读超时几乎必然是「还在跑」而不是「没跑」。
    实测记录：读超时 180s 时 HK 复杂生成假超时 → 重试 → 墙钟翻倍 + 厂商双计费。
    """
    calls = {"n": 0}

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        raise error

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)

    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("https://x/v1/images/generations", "ak", {}, timeout=10)
    assert calls["n"] == 1


def test_post_json_does_not_retry_non_json_200(monkeypatch):
    """200 但响应体不是 JSON：这次调用已经在上游执行过，重试只会重复计费。"""
    calls = {"n": 0}

    class BadBody:
        status_code = 200
        text = "<html>gateway</html>"

        def json(self):
            raise ValueError("Expecting value: line 1 column 1")

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        return BadBody()

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)

    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("https://x/v1/images/generations", "ak", {}, timeout=10)
    assert calls["n"] == 1


class _StatusResponse:
    """带状态码的假响应：用于驱动 _post_json 的瞬时网关重试分支。"""

    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self.text = "" if payload is None else json.dumps(payload)
        self._payload = payload or {}

    def json(self):
        return self._payload


def test_post_json_retries_504_gateway_then_succeeds(monkeypatch):
    image_bytes = b"\x89PNG\r\n\x1a\nok"
    ok = {"data": [{"b64_json": base64.b64encode(image_bytes).decode("ascii")}]}
    calls = {"n": 0}

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        # new-api 网关瞬时 504，重试一次即过。
        return _StatusResponse(504, {"error": {"message": "bad response status code 504"}}) \
            if calls["n"] == 1 else _StatusResponse(200, ok)

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)

    data = openai_image._post_json(
        "https://api.openai-hk.com/v1/images/generations", "ak", {"model": "gpt-image-2"}, timeout=10,
    )
    assert calls["n"] == 2
    assert data == ok


def test_post_json_does_not_retry_403(monkeypatch):
    calls = {"n": 0}

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        return _StatusResponse(403, {"error": {"message": "forbidden"}})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)

    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("https://api.openai-hk.com/v1/images/generations", "ak", {}, timeout=10)
    assert calls["n"] == 1  # 确定性 4xx 不重试


def test_post_json_504_exhausts_retries_and_caps_writes(monkeypatch):
    calls = {"n": 0}

    def fake_post(*args, **kwargs):
        calls["n"] += 1
        return _StatusResponse(504, {"error": {"message": "bad response status code 504"}})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)

    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("https://api.openai-hk.com/v1/images/generations", "ak", {}, timeout=10)
    # 持续 504 最多打 3 次写请求（range(3)），不会无限放大成 N 次出图。
    assert calls["n"] == 3


def test_render_seedream_normalizes_size_to_minimum_pixel_area(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(
        alias="seedream",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
    )
    image_bytes = b"\x89PNG\r\n\x1a\nseedream"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="fox",
        model="doubao-seedream-4-5-251128",
        alias="seedream",
        output_dir=tmp_path,
        n=1,
        size="1296x1296",
    )

    assert captured["url"] == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    assert captured["payload"]["size"] == "1920x1920"
    assert Path(paths[0]).read_bytes() == image_bytes


def test_render_seedream_embeds_reference_images_as_base64_image_field(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(
        alias="seedream",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
    )
    ref_one = tmp_path / "ref1.png"
    ref_one.write_bytes(b"\x89PNG\r\n\x1a\nref-one")
    ref_two = tmp_path / "ref2.jpg"
    ref_two.write_bytes(b"\xff\xd8\xff\xe0ref-two")
    image_bytes = b"\x89PNG\r\n\x1a\nseedream-edit"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="restyle",
        model="doubao-seedream-5-0-260128",
        alias="seedream",
        output_dir=tmp_path,
        n=1,
        size="2048x2048",
        reference_images=[str(ref_one), str(ref_two)],
    )

    image = captured["payload"]["image"]
    assert isinstance(image, list) and len(image) == 2
    assert image[0].startswith("data:image/png;base64,")
    assert image[1].startswith("data:image/jpeg;base64,")


def test_render_openai_hk_gpt_image_with_reference_uses_sync_edits(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """HK gpt-image 带参考图 → 同步 /images/edits（multipart），绝不带 ?async=true。"""
    _add_key(alias="hk", provider="custom", base_url="https://api.openai-hk.com")
    ref = tmp_path / "lvbu.png"
    ref.write_bytes(b"\x89PNG\r\n\x1a\nlvbu")
    edited = b"\x89PNG\r\n\x1a\nedited"
    captured: dict[str, object] = {}

    def fake_post(url, headers, data, files, timeout):
        captured["url"] = url
        captured["data"] = data
        captured["files"] = files
        return FakePostResponse({
            "data": [{"b64_json": base64.b64encode(edited).decode("ascii")}],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="给吕布换银色战甲",
        model="gpt-image-2",
        alias="hk",
        output_dir=tmp_path,
        n=1,
        size="1024x1536",
        quality="high",
        source_image=str(ref),
    )

    assert captured["url"] == "https://api.openai-hk.com/v1/images/edits"
    assert "async" not in str(captured["url"])
    assert any(part[0] == "image" for part in captured["files"])
    assert captured["data"]["model"] == "gpt-image-2"
    # 1024x1536 不在 HK 尺寸表 → snap 到表内 2:3（1376x2064）；edits 路径同样 snap。
    assert captured["data"]["size"] == "1376x2064"
    assert captured["data"]["quality"] == "high"
    assert len(paths) == 1


def test_render_openai_hk_nano_banana_with_reference_uses_generations(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """回归：nano-banana 带参考图走 generations 的 image 字段，绝不进 /images/edits。

    OpenAI-HK / 聚合商对 nano-banana 的 /images/edits 一律 403（openresty 拒未实现路由）；
    nano-banana 是 Gemini 多模态，图生图实测走 generations+image 可用。仅 gpt-image 走 edits。
    """
    _add_key(alias="hk", provider="custom", base_url="https://api.openai-hk.com")
    ref = tmp_path / "lvbu.png"
    ref.write_bytes(b"\x89PNG\r\n\x1a\nlvbu")
    captured: dict[str, object] = {}

    def fake_post(url, headers=None, json=None, data=None, files=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["files"] = files
        return FakePostResponse({
            "data": [{"b64_json": base64.b64encode(b"\x89PNG\r\n\x1a\nedited").decode("ascii")}],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="给吕布换银色战甲",
        model="nano-banana-2",
        alias="hk",
        output_dir=tmp_path,
        n=1,
        size="3:4",
        quality="high",
        source_image=str(ref),
    )

    assert captured["url"] == "https://api.openai-hk.com/v1/images/generations"
    assert "/images/edits" not in str(captured["url"])
    assert captured["files"] is None  # JSON 路径，非 multipart edits
    assert captured["json"]["model"] == "nano-banana-2"
    assert captured["json"].get("image")  # 参考图作为 image 字段送出
    assert len(paths) == 1


def test_render_openai_hk_gpt_image_no_reference_stays_on_generations(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """无参考图仍走 generations（JSON），不误入 edits。"""
    _add_key(alias="hk", provider="custom", base_url="https://api.openai-hk.com")
    img = b"\x89PNG\r\n\x1a\ngen"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        return FakePostResponse({
            "data": [{"b64_json": base64.b64encode(img).decode("ascii")}],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="吕布立绘", model="gpt-image-2", alias="hk",
        output_dir=tmp_path, n=1, size="1024x1536",
    )
    assert captured["url"].endswith("/v1/images/generations")
    assert len(paths) == 1


def test_render_seedream_truncates_reference_images_to_cap(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(
        alias="seedream",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
    )
    # 火山引擎 Seedream 图生图上限 10 张；传 12 张应截断到前 10 张。
    refs = []
    for i in range(12):
        ref = tmp_path / f"ref{i}.png"
        ref.write_bytes(b"\x89PNG\r\n\x1a\n" + str(i).encode())
        refs.append(str(ref))
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(b"\x89PNG\r\n\x1a\nout").decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="restyle",
        model="doubao-seedream-5-0-260128",
        alias="seedream",
        output_dir=tmp_path,
        n=1,
        size="2048x2048",
        reference_images=refs,
    )

    image = captured["payload"]["image"]
    assert isinstance(image, list) and len(image) == 10


def test_render_seedream_omits_image_field_without_references(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(
        alias="seedream",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
    )
    image_bytes = b"\x89PNG\r\n\x1a\nno-ref"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="fox",
        model="doubao-seedream-5-0-260128",
        alias="seedream",
        output_dir=tmp_path,
        n=1,
        size="2048x2048",
    )

    assert "image" not in captured["payload"]


def test_render_seedream_backfills_when_api_returns_fewer_images(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(
        alias="seedream",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
    )
    images = [b"\x89PNG\r\n\x1a\nseedream-1", b"\x89PNG\r\n\x1a\nseedream-2"]
    captured: dict[str, object] = {"payloads": []}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["payloads"].append(json)
        index = len(captured["payloads"]) - 1
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(images[index]).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="fox",
        model="doubao-seedream-4-5-251128",
        alias="seedream",
        output_dir=tmp_path,
        n=2,
        size="2048x2048",
    )

    assert captured["url"] == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    assert [payload["n"] for payload in captured["payloads"]] == [2, 1]
    assert captured["payloads"][0]["sequential_image_generation"] == "auto"
    assert [Path(path).name for path in paths] == ["v1.png", "v2.png"]
    assert Path(paths[0]).read_bytes() == images[0]
    assert Path(paths[1]).read_bytes() == images[1]


def test_render_openai_hk_non_image_model_falls_back_to_chat_completions(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="openai-hk", provider="custom", base_url="https://api.openai-hk.com")
    first_image = b"\x89PNG\r\n\x1a\nchat-1"
    second_image = b"\x89PNG\r\n\x1a\nchat-2"
    captured: dict[str, object] = {"payloads": [], "downloads": []}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["payloads"].append(json)
        index = len(captured["payloads"])
        return FakePostResponse({
            "choices": [{
                "message": {
                    "content": f"好了：![image](https://cdn.example.com/out-{index}.png)",
                },
            }],
        })

    def fake_get(url, headers, timeout, stream):
        captured["downloads"].append(url)
        captured["download_user_agent"] = headers.get("User-Agent")
        captured["download_stream"] = stream
        if url == "https://cdn.example.com/out-1.png":
            return FakeDownloadResponse(first_image)
        if url == "https://cdn.example.com/out-2.png":
            return FakeDownloadResponse(second_image)
        raise AssertionError(f"unexpected download URL: {url}")

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image.render(
        prompt="pixel dog",
        model="hk-chat-vision",
        alias="openai-hk",
        output_dir=tmp_path,
        n=2,
        size="2048x2048",
    )

    assert captured["url"] == "https://api.openai-hk.com/v1/chat/completions"
    assert [payload["model"] for payload in captured["payloads"]] == [
        "hk-chat-vision",
        "hk-chat-vision",
    ]
    assert all(
        payload["messages"][-1]["content"].startswith("pixel dog")
        for payload in captured["payloads"]
    )
    assert all(
        "Generate 2 images." not in payload["messages"][-1]["content"]
        for payload in captured["payloads"]
    )
    assert all("2048x2048" in payload["messages"][-1]["content"] for payload in captured["payloads"])
    assert captured["downloads"] == [
        "https://cdn.example.com/out-1.png",
        "https://cdn.example.com/out-2.png",
    ]
    assert "Mozilla" in captured["download_user_agent"]
    assert captured["download_stream"] is False
    assert [Path(path).name for path in paths] == ["v1.png", "v2.png"]
    assert Path(paths[0]).read_bytes() == first_image
    assert Path(paths[1]).read_bytes() == second_image


def test_render_openai_hk_gpt_image_uses_images_endpoint_with_size_and_quality(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="openai-hk", provider="custom", base_url="https://api.openai-hk.com")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(b"\x89PNG\r\n\x1a\nhk-gpt").decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="city poster",
        model="gpt-image-2",
        alias="openai-hk",
        output_dir=tmp_path,
        n=1,
        size="1536x1024",
        params={"quality": "high"},
    )

    # gpt-image 不再走 chat，而是真正的 images 端点，且把 size/quality 当真参数发出。
    assert captured["url"] == "https://api.openai-hk.com/v1/images/generations"
    payload = captured["payload"]
    # 1536x1024 不在 HK 尺寸表 → snap 到表内 3:2（2064x1376）。
    assert payload["size"] == "2064x1376"
    assert payload["quality"] == "high"
    assert "watermark" not in payload
    assert "sequential_image_generation" not in payload


def test_render_gpt_image_passes_transparent_background(
    isolated_data_root, tmp_path, monkeypatch,
):
    _add_key(alias="openai-hk", provider="custom", base_url="https://api.openai-hk.com")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{"b64_json": "data:image/png;base64," + base64.b64encode(b"png").decode()}],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(
        prompt="cutout", model="gpt-image-2", alias="openai-hk", output_dir=tmp_path,
        n=1, params={"background": "transparent"},
    )
    assert captured["payload"]["background"] == "transparent"


def test_render_ark_gpt_image_strips_unverified_background(
    isolated_data_root, tmp_path, monkeypatch,
):
    keys.add_key(KeySpec(
        alias="ark-gpt",
        provider="custom",
        base_url="https://api.example.com/v1",
        access_key="test-key",
        capabilities=["portrait"],
        models=[{
            "name": "GPT Image 2",
            "id": "gpt-image-2",
            "modality": "image",
            "protocol": "ark",
        }],
        created_at="2026-08-25T00:00:00Z",
    ))
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{"b64_json": "data:image/png;base64," + base64.b64encode(b"png").decode()}],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(
        prompt="cutout", model="gpt-image-2", alias="ark-gpt", output_dir=tmp_path,
        n=1, params={"background": "transparent"},
    )

    assert "background" not in captured["payload"]


def test_render_openai_hk_gpt_image_snaps_offtable_portrait_to_supported_size(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """skill 立绘的 1024x1536 不在 HK 尺寸表 → 必须 snap 到表内 2:3（1376x2064），

    否则 HK 把它按总像素出成正方形（1024×1536 → 1254²）。这是用户真机出方图的根因。
    """
    _add_key(alias="hk", provider="custom", base_url="https://api.openai-hk.com")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(b"\x89PNG\r\n\x1a\nportrait").decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="吕布立绘", model="gpt-image-2", alias="hk",
        output_dir=tmp_path, n=1, size="1024x1536",
    )
    assert captured["payload"]["size"] == "1376x2064"


def test_render_openai_hk_gpt_image_keeps_ontable_size_unchanged(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """表内精确值（Studio 的 1536x2048 3:4 竖图）原样下发，不被 snap 改动。"""
    _add_key(alias="hk", provider="custom", base_url="https://api.openai-hk.com")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["payload"] = json
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(b"\x89PNG\r\n\x1a\nstudio").decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    openai_image.render(
        prompt="city", model="gpt-image-2", alias="hk",
        output_dir=tmp_path, n=1, size="1536x2048",
    )
    assert captured["payload"]["size"] == "1536x2048"


def test_render_openai_hk_nano_banana_passes_ratio_size_and_backfills(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="openai-hk", provider="custom", base_url="https://api.openai-hk.com")
    captured: dict[str, object] = {"payloads": []}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["payloads"].append(json)
        idx = len(captured["payloads"])
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(f"\x89PNG\r\n\x1a\nnano-{idx}".encode()).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)

    paths = openai_image.render(
        prompt="banana cat",
        model="nano-banana",
        alias="openai-hk",
        output_dir=tmp_path,
        n=3,
        size="16:9",
        params={"quality": "low"},
    )

    # nano-banana：size 是比例字符串原样下发；单次只回 1 张 → 循环补足到 3 张。
    assert captured["url"] == "https://api.openai-hk.com/v1/images/generations"
    assert len(captured["payloads"]) == 3
    assert captured["payloads"][0]["size"] == "16:9"
    assert captured["payloads"][0]["quality"] == "low"
    assert len(paths) == 3


def test_fixed_nano_resolution_quality_reads_model_suffix():
    assert openai_image.fixed_nano_resolution_quality("nano-banana-pro-4k") == "4k"
    assert openai_image.fixed_nano_resolution_quality("nano-banana-2-2k") == "2k"
    assert openai_image.fixed_nano_resolution_quality("nano-banana-pro-4k-vip") == "4k"
    assert openai_image.fixed_nano_resolution_quality("nano-banana-pro") is None
    assert openai_image.fixed_nano_resolution_quality("gpt-image-2") is None

    assert (
        openai_image.tuzi_outbound_image_model("nano-banana-pro-4k")
        == "gemini-3-pro-image-preview"
    )
    assert (
        openai_image.tuzi_outbound_image_model("nano-banana-pro-2k")
        == "gemini-3-pro-image-preview"
    )
    assert (
        openai_image.tuzi_outbound_image_model("nano-banana-2-4k")
        == "gemini-3.1-flash-image-preview"
    )
    assert (
        openai_image.tuzi_outbound_image_model("vendor/NANO_BANANA_PRO_4K")
        == "gemini-3-pro-image-preview"
    )
    assert (
        openai_image.tuzi_outbound_image_model("nano-banana-pro-4k-vip")
        == "gemini-3-pro-image-preview-4k-vip"
    )
    assert openai_image.tuzi_outbound_image_model("gpt-image-2") == "gpt-image-2"


def test_image_items_from_text_cleans_malformed_markdown_url():
    dirty = (
        "![image](https://pro.filesystem.site/cdn/20260529/out.png]"
        "(https://pro.filesystem.site/cdn/20260529/out.png)"
    )

    assert openai_image._image_items_from_text(dirty) == [
        {"url": "https://pro.filesystem.site/cdn/20260529/out.png"},
    ]


def test_write_outputs_cleans_url_before_download(tmp_path, monkeypatch):
    image_bytes = b"\x89PNG\r\n\x1a\nclean"
    captured: dict[str, object] = {}

    def fake_get(url, headers, timeout, stream):
        captured["url"] = url
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {
            "data": [{
                "url": (
                    "https://pro.filesystem.site/cdn/20260529/out.png]"
                    "(https://pro.filesystem.site/cdn/20260529/out.png"
                ),
            }],
        },
        tmp_path,
    )

    assert captured["url"] == "https://pro.filesystem.site/cdn/20260529/out.png"
    assert Path(paths[0]).read_bytes() == image_bytes


def test_write_outputs_downloads_url_with_browser_headers(tmp_path, monkeypatch):
    image_bytes = b"\x89PNG\r\n\x1a\nurl"
    captured: dict[str, object] = {}

    def fake_get(url, headers, timeout, stream):
        captured["url"] = url
        captured["user_agent"] = headers.get("User-Agent")
        captured["accept"] = headers.get("Accept")
        captured["timeout"] = timeout
        captured["stream"] = stream
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert captured["url"] == "https://cdn.example.com/out.png"
    assert "Mozilla" in captured["user_agent"]
    assert captured["accept"] == IMAGE_ACCEPT
    assert captured["timeout"] == 180.0
    assert captured["stream"] is False
    assert Path(paths[0]).read_bytes() == image_bytes


def test_write_outputs_retries_url_download_after_chunked_encoding_error(
    tmp_path,
    monkeypatch,
):
    image_bytes = b"\x89PNG\r\n\x1a\nretry"
    calls: list[dict[str, object]] = []

    def fake_get(url, headers, timeout, stream):
        calls.append({"url": url, "headers": headers, "timeout": timeout})
        if len(calls) == 1:
            raise requests.exceptions.ChunkedEncodingError("incomplete read")
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 2
    assert calls[0]["url"] == "https://cdn.example.com/out.png"
    assert calls[0]["headers"]["Accept"] == IMAGE_ACCEPT
    assert calls[0]["timeout"] == 180.0
    assert Path(paths[0]).read_bytes() == image_bytes


def test_write_outputs_wraps_url_download_http_errors(tmp_path, monkeypatch):
    def fake_get(url, headers, timeout, stream):
        return FakeDownloadResponse(b"Forbidden", status_code=403)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    try:
        openai_image._write_outputs(
            {"data": [{"url": "https://cdn.example.com/out.png"}]},
            tmp_path,
        )
    except openai_image.OpenAIImageError as exc:
        assert "download image 403" in str(exc)
        assert "https://cdn.example.com/out.png" in str(exc)
    else:
        raise AssertionError("expected OpenAIImageError")


def test_write_outputs_resumes_after_incomplete_stream(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 10)
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers, "stream": stream})
        if len(calls) == 1:
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(second))},
            )
        if len(calls) == 2:
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(second))},
            )
        assert headers["Range"] == f"bytes={len(first)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={"Content-Range": f"bytes {len(first)}-{len(first) + len(second) - 1}/{len(first) + len(second)}"},
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert calls[0]["stream"] is False
    assert calls[0]["headers"].get("Range") is None
    assert Path(paths[0]).read_bytes() == first + second


def test_write_outputs_uses_incomplete_read_partial_before_resume(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 4)
    partial = b"p" * 3
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise IncompleteRead(partial, len(second))

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        if len(calls) == 2:
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        assert headers["Range"] == f"bytes={len(first) + len(partial)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={
                "Content-Range": (
                    f"bytes {len(first) + len(partial)}-"
                    f"{len(first) + len(partial) + len(second) - 1}/"
                    f"{len(first) + len(partial) + len(second)}"
                ),
            },
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == first + partial + second


def test_write_outputs_uses_nested_incomplete_read_partial_before_resume(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 4)
    partial = b"p" * 3
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError(
                "broken",
                IncompleteRead(partial, len(second)),
            )

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        if len(calls) == 2:
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        assert headers["Range"] == f"bytes={len(first) + len(partial)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={
                "Content-Range": (
                    f"bytes {len(first) + len(partial)}-"
                    f"{len(first) + len(partial) + len(second) - 1}/"
                    f"{len(first) + len(partial) + len(second)}"
                ),
            },
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == first + partial + second


def test_write_outputs_restarts_when_range_response_is_misaligned(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\npartial"
    full = b"\x89PNG\r\n\x1a\nfull"
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + 10)},
            )
        if len(calls) == 2:
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + 10)},
            )
        assert headers["Range"] == f"bytes={len(first)}-"
        return FakeDownloadResponse(
            full,
            status_code=206,
            headers={"Content-Range": f"bytes 0-{len(full) - 1}/{len(full)}"},
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == full


def test_write_outputs_uses_curl_before_known_truncated_partial_image(
    tmp_path,
    monkeypatch,
):
    partial = b"\x89PNG\r\n\x1a\npartial"
    image_bytes = b"\x89PNG\r\n\x1a\ncurl"

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield partial
            raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_get(url, headers, timeout, stream):
        return InterruptedDownloadResponse(
            b"",
            headers={"Content-Length": str(len(partial) + 100)},
        )

    def fake_run(command, check, capture_output):
        return subprocess.CompletedProcess(command, 0, stdout=image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)
    monkeypatch.setattr(openai_image.subprocess, "run", fake_run)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert Path(paths[0]).read_bytes() == image_bytes


def test_write_outputs_falls_back_to_curl_after_download_retries(tmp_path, monkeypatch):
    image_bytes = b"\x89PNG\r\n\x1a\ncurl"
    get_calls: list[str] = []
    captured: dict[str, object] = {}

    def fake_get(url, headers, timeout, stream):
        get_calls.append(url)
        raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_run(command, check, capture_output):
        captured["command"] = command
        captured["check"] = check
        captured["capture_output"] = capture_output
        return subprocess.CompletedProcess(command, 0, stdout=image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)
    monkeypatch.setattr(openai_image.subprocess, "run", fake_run)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(get_calls) == 6
    assert captured["command"][:6] == ["curl", "-sS", "-L", "--fail", "--retry", "5"]
    assert captured["check"] is True
    assert captured["capture_output"] is True
    assert Path(paths[0]).read_bytes() == image_bytes


def test_write_outputs_hides_raw_incomplete_read_when_all_downloads_fail(
    tmp_path,
    monkeypatch,
):
    def fake_get(url, headers, timeout, stream):
        raise requests.exceptions.ChunkedEncodingError("IncompleteRead(1 bytes read)")

    def fake_run(command, check, capture_output):
        raise subprocess.CalledProcessError(22, command)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)
    monkeypatch.setattr(openai_image.subprocess, "run", fake_run)

    try:
        openai_image._write_outputs(
            {"data": [{"url": "https://cdn.example.com/out.png"}]},
            tmp_path,
        )
    except openai_image.OpenAIImageError as exc:
        assert str(exc) == "download image failed after retries"
    else:
        raise AssertionError("expected OpenAIImageError")


def test_download_image_url_uses_non_streaming_first(monkeypatch):
    """Phase 1: first call uses stream=False and returns without streaming fallback."""
    image_bytes = b"\x89PNG\r\n\x1a\ncomplete"
    captured: dict[str, object] = {}

    def fake_get(url, headers, timeout, stream):
        captured["stream"] = stream
        captured["calls"] = captured.get("calls", 0) + 1
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    result = openai_image._download_image_url("https://cdn.example.com/out.png")

    assert result == image_bytes
    assert captured["stream"] is False
    assert captured["calls"] == 1


def test_download_image_url_falls_through_to_streaming_after_non_streaming_failure(
    monkeypatch,
):
    """Phase 1 failure falls back to stream=True retry path."""
    image_bytes = b"\x89PNG\r\n\x1a\ncomplete"
    calls: list[bool] = []

    def fake_get(url, headers, timeout, stream):
        calls.append(stream)
        if not stream:
            raise requests.exceptions.ChunkedEncodingError("incomplete read")
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    result = openai_image._download_image_url("https://cdn.example.com/out.png")

    assert result == image_bytes
    assert calls[0] is False
    assert calls[1] is True


def test_image_family_classifies_by_model_prefix():
    from character_workflow.lib.callers.openai_image import image_family
    assert image_family("gpt-image-2") == "gpt-image"
    assert image_family("nano-banana-hd") == "nano-banana"
    # Tuzi nano 别名（含分辨率后缀）仍归 nano-banana 族。
    assert image_family("nano-banana-pro-4k") == "nano-banana"
    assert image_family("nano-banana-2-2k") == "nano-banana"
    assert image_family("seedream-5.0-lite") == "seedream"
    assert image_family("seededit-3") == "seedream"
    # 子串匹配：Tuzi 的 doubao-seedream-* 也归 seedream 族（不是 startswith）。
    assert image_family("doubao-seedream-4-5-251128") == "seedream"
    assert image_family("foo-image-1") == "standard"


def test_custom_seedream_normalizes_size_to_minimum_pixels(tmp_path, monkeypatch):
    # Tuzi 的 doubao-seedream 走 custom provider：小尺寸必须被后端归一到 ≥3.6M，
    # 否则 Tuzi 报 "image size must be at least 3686400 pixels"（实测）。
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib.callers import openai_image
    _keys.add_key(_keys.KeySpec(
        alias="tz", provider="custom", base_url="https://api.tu-zi.com",
        access_key="x", created_at="2026-07-08T00:00:00Z",
    ))
    posted = {}
    monkeypatch.setattr(
        openai_image.tuzi_async,
        "execute_json",
        lambda **kwargs: (
            posted.update(body=kwargs["payload"]),
            {"data": [{"b64_json": "aGk="}]},
        )[1],
    )
    openai_image.render(prompt="p", model="doubao-seedream-4-5-251128", alias="tz",
                        output_dir=tmp_path / "o", size="1024x1024")
    w, h = (int(v) for v in posted["body"]["size"].split("x"))
    assert w * h >= 3686400, posted["body"]["size"]


def test_write_outputs_skips_empty_b64_and_uses_url(tmp_path, monkeypatch):
    # Tuzi 在 response_format=url 时仍回 b64_json:""，别把空串当图写空文件——落到 url 分支。
    from character_workflow.lib.callers import openai_image
    monkeypatch.setattr(openai_image, "_download_image_url", lambda url: b"\x89PNG\r\n\x1a\nDATA")
    paths = openai_image._write_outputs(
        {"data": [{"b64_json": "", "url": "https://x/y.png"}]}, tmp_path,
    )
    assert len(paths) == 1
    assert (tmp_path / "v1.png").read_bytes() == b"\x89PNG\r\n\x1a\nDATA"


def test_custom_gpt_image_sends_quality(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib.callers import openai_image
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
    ))
    posted = {}
    monkeypatch.setattr(openai_image, "_post_json",
                        lambda url, key, payload, *, timeout: (posted.update(url=url, body=payload),
                                                               {"data": [{"b64_json": "aGk="}]})[1])
    openai_image.render(prompt="p", model="gpt-image-2", alias="cu",
                        output_dir=tmp_path / "o", quality="high")
    assert posted["url"].endswith("/images/generations")
    assert posted["body"]["quality"] == "high"  # custom gpt-image 也发 quality


def test_custom_gpt_image_reference_uses_official_edits(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib.callers import openai_image
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
    ))
    ref = tmp_path / "r.png"
    ref.write_bytes(b"png")
    seen = {}
    monkeypatch.setattr(openai_image, "_post_multipart",
                        lambda url, key, *, fields, files, timeout: (seen.update(url=url),
                                                                     {"data": [{"b64_json": "aGk="}]})[1])
    openai_image.render(prompt="p", model="gpt-image-2", alias="cu",
                        output_dir=tmp_path / "o", reference_images=[str(ref)])
    assert seen["url"].endswith("/images/edits")  # custom gpt-image 图生图走官方 multipart edits


def test_custom_standard_model_no_quality(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys as _keys
    from character_workflow.lib.callers import openai_image
    _keys.add_key(_keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
    ))
    posted = {}
    monkeypatch.setattr(openai_image, "_post_json",
                        lambda url, key, payload, *, timeout: (posted.update(body=payload),
                                                               {"data": [{"b64_json": "aGk="}]})[1])
    openai_image.render(prompt="p", model="foo-image-1", alias="cu",
                        output_dir=tmp_path / "o", quality="high")
    assert "quality" not in posted["body"]  # standard 族不发 quality


# --- 词元跳动 Ark 图片协议（网关按协议挂端点，打错入口报 503 无可用端点） ---

def _add_tokendance_key(alias: str, models: list[dict]) -> None:
    keys.add_key(KeySpec(
        alias=alias,
        provider="tokendance",
        base_url="https://tokendance.space/gateway/v1",
        access_key="test-key",
        capabilities=["portrait"],
        models=models,
        created_at="2026-08-13T00:00:00Z",
    ))


def test_ark_image_url_rewrites_tokendance_gateway_and_leaves_ark_direct_alone():
    assert (
        openai_image._ark_image_url("https://tokendance.space/gateway/v1")
        == "https://tokendance.space/gateway/ark/v3/images/generations"
    )
    # 火山直连的 base 本身就是 Ark 根，端点与 OpenAI 兼容路径同形。
    assert (
        openai_image._ark_image_url("https://ark.cn-beijing.volces.com/api/v3")
        == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    )


def test_resolve_image_protocol_routes_tokendance_seedream_to_ark():
    assert openai_image.resolve_image_protocol("tokendance", None, "seedream-5.0-pro") == "ark"
    assert openai_image.resolve_image_protocol("tokendance", None, "seedance-2.0") is None
    assert openai_image.resolve_image_protocol("custom", None, "doubao-seedream-4-5") is None


def test_render_tokendance_seedream_posts_to_ark_endpoint(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """seedream-5.0-pro 只声明 ark:image-generations，打 /v1 会被网关判 503 无可用端点。"""
    _add_tokendance_key("td", [{"name": "Seedream 5.0 Pro", "id": "seedream-5.0-pro"}])
    image_bytes = b"\x89PNG\r\n\x1a\npro"
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        return FakePostResponse({
            "data": [{
                "b64_json": "data:image/png;base64,"
                + base64.b64encode(image_bytes).decode("ascii"),
            }],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    paths = openai_image.render(
        prompt="fox", model="seedream-5.0-pro", alias="td",
        output_dir=tmp_path, n=1, size="1024x1536",
    )

    assert captured["url"] == "https://tokendance.space/gateway/ark/v3/images/generations"
    assert Path(paths[0]).read_bytes() == image_bytes


def test_render_tokendance_honors_stored_openai_protocol(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """存下来的上游协议标注是权威值，压过 provider+族启发式。"""
    _add_tokendance_key(
        "td-lite",
        [{"name": "Seedream 5.0 lite", "id": "seedream-5.0-lite", "protocol": "openai"}],
    )
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(
        prompt="fox", model="seedream-5.0-lite", alias="td-lite",
        output_dir=tmp_path, n=1, size="1024x1536",
    )

    assert captured["url"] == "https://tokendance.space/gateway/v1/images/generations"


def test_no_endpoints_available_503_is_fatal_and_not_retried(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers, json, timeout):
        calls["n"] += 1
        return FakePostResponse(
            {"error": {"message": "模型 'x' 下无可用端点", "code": "no_endpoints_available"}},
            status_code=503,
        )

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)
    with pytest.raises(openai_image.OpenAIImageError) as excinfo:
        openai_image._post_json("https://x/v1/images/generations", "k", {}, timeout=1)

    assert calls["n"] == 1  # 确定性错误：一次就抛，不空烧三轮退避
    assert "no_endpoints_available" in str(excinfo.value)


def test_plain_503_still_retries(monkeypatch):
    """回归保护：网关瞬时 503（无 no_endpoints_available 标记）仍走三轮重试。"""
    calls = {"n": 0}

    def fake_post(url, headers, json, timeout):
        calls["n"] += 1
        if calls["n"] < 3:
            return FakePostResponse({"error": "upstream busy"}, status_code=503)
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)
    data = openai_image._post_json("https://x/v1/images/generations", "k", {}, timeout=1)

    assert calls["n"] == 3
    assert data["data"][0]["b64_json"] == "aGk="


def test_seedream_min_pixels_differ_per_model():
    """实测：同一把词元跳动 key 下 lite 要 3686400、pro 只要 921600。"""
    assert openai_image._min_pixels_for_seedream("seedream-5.0-lite") == 3_686_400
    assert openai_image._min_pixels_for_seedream("doubao-seedream-4-5-251128") == 3_686_400
    assert openai_image._min_pixels_for_seedream("seedream-5.0-pro") == 921_600


def test_render_tokendance_lite_normalizes_size_but_pro_keeps_it(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """尺寸归一按模型下限：lite 的 1024x1536 要放大，pro 的同尺寸已达标不动。"""
    _add_tokendance_key("td2", [
        {"name": "lite", "id": "seedream-5.0-lite"},
        {"name": "pro", "id": "seedream-5.0-pro"},
    ])
    seen: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        seen[json["model"]] = json["size"]
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    for model in ("seedream-5.0-lite", "seedream-5.0-pro"):
        openai_image.render(
            prompt="fox", model=model, alias="td2",
            output_dir=tmp_path / model, n=1, size="1024x1536",
        )

    assert seen["seedream-5.0-lite"] == "1568x2352"  # 1.57M → 放大过 3686400
    assert seen["seedream-5.0-pro"] == "1024x1536"  # 1.57M 已高于 921600，原样发


def test_render_tokendance_does_not_send_ark_only_params(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    """组图是按 provider 判的 Ark 专有参数，词元跳动这条路不发；出图外观参数则必须发。

    seedream-5.0-pro 实测明确拒收 sequential_image_generation。
    watermark / output_format 与它相反 —— 省略都不是安全默认（实测：这条路我们从没发过
    watermark，出来的图右下角照样有「AI 生成」；产物也是 JPEG），所以按模型族一律显式发。
    """
    _add_tokendance_key("td3", [{"name": "pro", "id": "seedream-5.0-pro"}])
    seen: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        seen.update(json)
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(
        prompt="fox", model="seedream-5.0-pro", alias="td3",
        output_dir=tmp_path, n=2, size="1024x1536",
    )

    assert seen["watermark"] is False
    assert seen["output_format"] == "png"
    assert "sequential_image_generation" not in seen


@pytest.mark.parametrize(
    "provider,base_url,model",
    [
        ("seedream", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seedream-4-5-251128"),
        ("tokendance", "https://tokendance.space/gateway/v1", "seedream-5.0-pro"),
        ("custom", "https://api.tu-zi.com", "doubao-seedream-4-5-251128"),
    ],
)
def test_every_seedream_route_disables_watermark_and_asks_png(
    provider, base_url, model, isolated_data_root, tmp_path, monkeypatch,
):
    """出图外观按【模型族】判，覆盖所有 seedream 路径 —— provider 不参与。

    2026-08-14 实证：三条路的历史产物一张不落全带右下角「AI 生成」水印，其中词元跳动那条
    我们**从没发过 watermark 参数** —— 证明 Ark 默认就是 true，省略不是安全默认。
    """
    keys.add_key(KeySpec(
        alias="k", provider=provider, base_url=base_url, access_key="x",
        capabilities=["portrait"], models=[{"name": "m", "id": model}],
        created_at="2026-08-14T00:00:00Z",
    ))
    seen: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        seen.update(json)
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    monkeypatch.setattr(
        openai_image.tuzi_async,
        "execute_json",
        lambda **kwargs: (
            seen.update(kwargs["payload"]),
            {"data": [{"b64_json": "aGk="}]},
        )[1],
    )
    openai_image.render(prompt="fox", model=model, alias="k", output_dir=tmp_path, size="2048x2048")

    assert seen["watermark"] is False, f"{provider} 这条路没关水印"
    assert seen["output_format"] == "png", f"{provider} 这条路没要 png"


def test_non_seedream_models_never_get_ark_appearance_params(
    isolated_data_root, tmp_path, monkeypatch,
):
    """watermark / output_format 是 Ark 专有：发给 gpt-image 这类模型是噪声，不能顺手带上。"""
    keys.add_key(KeySpec(
        alias="hk", provider="custom", base_url="https://api.openai-hk.com", access_key="x",
        capabilities=["portrait"], models=[{"name": "g", "id": "gpt-image-2"}],
        created_at="2026-08-14T00:00:00Z",
    ))
    seen: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        seen.update(json)
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(prompt="fox", model="gpt-image-2", alias="hk",
                        output_dir=tmp_path, size="1024x1024")

    assert "watermark" not in seen
    assert "output_format" not in seen


# --- 能力矩阵：与前端共读同一张真值表（tests/fixtures/capability-matrix.json）---

def _capability_cases():
    import json as _json
    from pathlib import Path as _Path
    fixture = _Path(__file__).parent / "fixtures" / "capability-matrix.json"
    return _json.loads(fixture.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _capability_cases(), ids=lambda c: f"{c['provider']}:{c['model']}")
def test_capability_matrix_matches_shared_fixture(case):
    """四项能力判据一律按模型族走，provider 不参与。改实现前先改 fixture。"""
    model, provider = case["model"], case["provider"]
    family = openai_image.image_family(model)
    assert family == case["family"], f"{model} 族判定"
    assert openai_image._max_reference_images(provider, model) == case["max_reference_images"]
    assert openai_image.supports_image_quality(model) == case["supports_quality"]
    if case["min_pixels"] is None:
        assert family != "seedream"
    else:
        assert openai_image._min_pixels_for_seedream(model) == case["min_pixels"]
    if case["max_pixels"] is None:
        assert family != "seedream"
    else:
        assert openai_image._max_pixels_for_seedream(model) == case["max_pixels"]


@pytest.mark.parametrize("case", _capability_cases(), ids=lambda c: f"{c['provider']}:{c['model']}")
def test_seedream_size_normalized_into_pixel_range(case):
    """任何 seedream 模型、任何输入尺寸，归一化后都必须落在 [下限, 上限] 内。

    上限这一侧是 2026-08-14 的真 bug：Studio 4K 档发给 seedream-5.0-pro 的
    4096x2304 有 9437184 像素，是它 4624220 上限的两倍，上游当场 400。
    """
    if case["min_pixels"] is None:
        return
    lo, hi = case["min_pixels"], case["max_pixels"]
    # 覆盖 Studio 的 2K/4K 标准档 + 一个远低于下限、一个远高于上限的极端值。
    for raw in ("960x960", "2048x2048", "2560x1440", "4096x2304", "4096x4096", "8192x8192"):
        out = openai_image._normalize_size_for_provider(raw, True, case["model"])
        px = openai_image._size_pixels(out)
        assert lo <= px <= hi, f"{case['model']} {raw} → {out}（{px} 像素）越界 [{lo}, {hi}]"


def test_seedream_pro_4k_is_clamped_but_lite_is_not():
    """回归：上限是模型属性 —— 同一网关同一把 key，pro 要钳、lite 原样通过。"""
    fourk = "4096x2304"
    assert openai_image._normalize_size_for_provider(fourk, True, "seedream-5.0-lite") == fourk
    assert openai_image._normalize_size_for_provider(fourk, True, "doubao-seedream-4-5-251128") == fourk
    clamped = openai_image._normalize_size_for_provider(fourk, True, "seedream-5.0-pro")
    assert clamped != fourk
    assert openai_image._size_pixels(clamped) <= 4_624_220
    # 比例要保住：4096/2304 = 16:9，钳完仍应接近 16:9。
    w, h = (int(v) for v in str(clamped).split("x"))
    assert abs(w / h - 16 / 9) < 0.01


def test_seedream_reference_limit_no_longer_depends_on_provider():
    """回归：旧版按 provider 判，Tuzi / 词元跳动下的 seedream 被砍到 4 张。"""
    for provider in ("seedream", "custom", "tokendance", "openrouter"):
        assert openai_image._max_reference_images(provider, "doubao-seedream-4-5-251128") == 10


def test_tokendance_gateway_detected_by_host_not_provider_name():
    """把词元跳动配成 provider=custom 也要能路由到 Ark 端点，否则复发 503。"""
    base = "https://tokendance.space/gateway/v1"
    assert openai_image.resolve_image_protocol("custom", base, "seedream-5.0-pro") == "ark"
    # 路径里出现 tokendance 不算（旧版是裸子串匹配）
    assert openai_image.resolve_image_protocol(
        "custom", "https://api.example.com/tokendance/v1", "seedream-5.0-pro"
    ) is None


def test_sequential_is_a_model_property_not_a_provider_one():
    """seedream-5.0-pro 拒收 sequential —— 火山直连 / Tuzi 上的同一模型也不能发。"""
    assert openai_image._supports_sequential("doubao-seedream-4-5-251128") is True
    assert openai_image._supports_sequential("seedream-5.0-pro") is False
    assert openai_image._supports_sequential("bytedance-seed/seedream-5.0-pro") is False


def test_render_direct_seedream_pro_omits_sequential(isolated_data_root, tmp_path, monkeypatch):
    """火山直连 + pro + n=2：旧版会发 sequential_image_generation → 上游 400。"""
    keys.add_key(KeySpec(
        alias="ark", provider="seedream", base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="x", capabilities=["portrait"],
        models=[{"name": "pro", "id": "seedream-5.0-pro"}], created_at="2026-08-13T00:00:00Z",
    ))
    seen: list[dict] = []

    def fake_post(url, headers, json, timeout):
        seen.append(json)
        return FakePostResponse({"data": [{"b64_json": "aGk="}]})

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    openai_image.render(prompt="p", model="seedream-5.0-pro", alias="ark",
                        output_dir=tmp_path, n=2, size="1024x1536")
    assert all("sequential_image_generation" not in body for body in seen)
    assert seen[0]["watermark"] is False  # 出图外观：一律显式关水印
    assert seen[0]["output_format"] == "png"
    assert len(seen) == 2  # 补足循环补第二张


def test_render_seedream_layer_decomposition_preserves_ordered_metadata(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    keys.add_key(KeySpec(
        alias="ark-layers",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="test-key",
        models=[{
            "name": "Seedream 5.0 Pro",
            "id": "doubao-seedream-5-0-pro-260628",
            "modality": "image",
        }],
        created_at="2026-09-03T00:00:00Z",
    ))
    source = tmp_path / "source.png"
    source.write_bytes(b"\x89PNG\r\n\x1a\nsource")
    base = base64.b64encode(b"\x89PNG\r\n\x1a\nbase").decode("ascii")
    foreground = base64.b64encode(b"\x89PNG\r\n\x1a\nforeground").decode("ascii")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured.update({"url": url, "payload": json})
        return FakePostResponse({
            "data": [
                {
                    "b64_json": foreground,
                    "size": "512x512",
                    "output_format": "png",
                    "z_index": 1,
                    "name": "角色",
                    "description": "前景角色",
                    "bounding_box": {
                        "absolute": [10, 20, 522, 532],
                        "normalized": [5, 10, 260, 266],
                    },
                },
                {
                    "b64_json": base,
                    "size": "2048x2048",
                    "output_format": "png",
                    "z_index": 0,
                    "name": "",
                    "description": "",
                },
            ],
            "usage": {
                "input_images": 1,
                "generated_images": 2,
                "output_tokens": 32768,
                "total_tokens": 32768,
            },
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    params = {
        "layer_decomposition": True,
        "reference_images": [str(source)],
    }
    persisted: list[bool] = []

    paths = openai_image.render(
        prompt="",
        model="doubao-seedream-5-0-pro-260628",
        alias="ark-layers",
        output_dir=tmp_path / "outputs",
        n=1,
        size="2K",
        params=params,
        on_params_changed=lambda: persisted.append(True),
    )

    assert captured["url"] == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    assert captured["payload"] == {
        "model": "doubao-seedream-5-0-pro-260628",
        "image": "data:image/png;base64," + base64.b64encode(source.read_bytes()).decode(),
        "layer_decomposition": True,
        "size": "2K",
        "output_format": "png",
        "response_format": "b64_json",
        "watermark": False,
    }
    assert [Path(path).read_bytes() for path in paths] == [
        b"\x89PNG\r\n\x1a\nbase",
        b"\x89PNG\r\n\x1a\nforeground",
    ]
    result = params["layer_decomposition_result"]
    assert [item["z_index"] for item in result["outputs"]] == [0, 1]
    assert result["usage"]["output_tokens"] == 32768
    assert persisted == [True]


def test_render_seedream_layer_decomposition_supports_selected_tokendance_ark_model(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    keys.add_key(KeySpec(
        alias="td-layers",
        provider="tokendance",
        base_url="https://tokendance.space/gateway/v1",
        access_key="test-key",
        models=[{
            "name": "Seedream 5.0 Pro",
            "id": "seedream-5.0-pro",
            "modality": "image",
            "protocol": "ark",
        }],
        created_at="2026-09-03T00:00:00Z",
    ))
    source = tmp_path / "source.png"
    source.write_bytes(b"\x89PNG\r\n\x1a\nsource")
    encoded = base64.b64encode(b"\x89PNG\r\n\x1a\noutput").decode("ascii")
    captured: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        captured.update({"url": url, "payload": json})
        return FakePostResponse({
            "data": [
                {"b64_json": encoded, "z_index": 0, "size": "2K", "output_format": "png"},
                {
                    "b64_json": encoded,
                    "z_index": 1,
                    "size": "256x256",
                    "output_format": "png",
                    "bounding_box": {
                        "absolute": [0, 0, 256, 256],
                        "normalized": [0, 0, 125, 125],
                    },
                },
            ],
        })

    monkeypatch.setattr(openai_image.requests, "post", fake_post)
    params = {"layer_decomposition": True, "reference_images": [str(source)]}

    openai_image.render(
        prompt="",
        model="seedream-5.0-pro",
        alias="td-layers",
        output_dir=tmp_path / "outputs",
        size="1.5K",
        params=params,
    )

    assert captured["url"] == (
        "https://tokendance.space/gateway/ark/v3/images/generations"
    )
    assert captured["payload"]["layer_decomposition"] is True
    assert captured["payload"]["size"] == "1.5K"


def test_render_writes_warnings_for_silent_rewrites(isolated_data_root, tmp_path, monkeypatch):
    """尺寸归一 / 参考图截断此前完全静默 —— 现在要回传到 params.warnings。"""
    keys.add_key(KeySpec(
        alias="td-w", provider="tokendance", base_url="https://tokendance.space/gateway/v1",
        access_key="x", capabilities=["portrait"],
        models=[{"name": "lite", "id": "seedream-5.0-lite"}], created_at="2026-08-13T00:00:00Z",
    ))
    refs = []
    for i in range(12):
        p = tmp_path / f"r{i}.png"
        p.write_bytes(b"\x89PNG\r\n\x1a\n")
        refs.append(str(p))
    params: dict = {"size": "1024x1024", "reference_images": refs}
    monkeypatch.setattr(openai_image.requests, "post",
                        lambda url, headers, json, timeout: FakePostResponse({"data": [{"b64_json": "aGk="}]}))

    openai_image.render(prompt="p", model="seedream-5.0-lite", alias="td-w",
                        output_dir=tmp_path / "out", n=1, size="1024x1024", params=params)

    warnings = params["warnings"]
    assert any("像素下限" in w for w in warnings)
    assert any("参考图" in w and "10" in w for w in warnings)


def test_model_id_normalization_matches_frontend():
    """两端归一必须一致（前端 web/src/lib/modelFamily.ts 同规则）：尾段 + lower + _ . → -。

    分叉的后果是同一个模型在界面和后端拿到不同的像素下限，又变成静默改写。
    """
    for mid in (
        "seedream-5.0-pro", "seedream-5-0-pro", "doubao-seedream-5-0-pro-260128",
        "bytedance-seed/seedream-5.0-pro", "SEEDREAM_5_0_PRO",
    ):
        assert openai_image._min_pixels_for_seedream(mid) == 921_600, mid
        assert openai_image._supports_sequential(mid) is False, mid
    for mid in ("seedream-5.0-lite", "doubao-seedream-4-5-251128"):
        assert openai_image._min_pixels_for_seedream(mid) == 3_686_400, mid
        assert openai_image._supports_sequential(mid) is True, mid
