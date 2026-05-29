from __future__ import annotations

import base64
from http.client import IncompleteRead
import json
from pathlib import Path
import subprocess

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

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self) -> bytes:
            return json.dumps({
                "data": [{
                    "b64_json": "data:image/png;base64,"
                    + base64.b64encode(image_bytes).decode("ascii"),
                }],
            }).encode("utf-8")

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return FakeResponse()

    monkeypatch.setattr(openai_image.urllib.request, "urlopen", fake_urlopen)

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


def test_render_openai_hk_posts_to_chat_completions_and_downloads_markdown_image(
    isolated_data_root,
    tmp_path,
    monkeypatch,
):
    _add_key(alias="openai-hk", provider="custom", base_url="https://api.openai-hk.com")
    image_bytes = b"\x89PNG\r\n\x1a\nchat"
    captured: dict[str, object] = {}

    class FakeResponse:
        def __init__(self, body: bytes):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self) -> bytes:
            return self.body

    def fake_urlopen(request, timeout):
        if isinstance(request, str):
            raise AssertionError("expected Request for image downloads")
        if request.full_url == "https://api.openai-hk.com/v1/chat/completions":
            captured["url"] = request.full_url
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(json.dumps({
                "choices": [{
                    "message": {
                        "content": "好了：![image](https://cdn.example.com/out.png)",
                    },
                }],
            }).encode("utf-8"))

    def fake_get(url, headers, timeout, stream):
        assert url == "https://cdn.example.com/out.png"
        captured["download_user_agent"] = headers.get("User-Agent")
        captured["download_stream"] = stream
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image.render(
        prompt="pixel dog",
        model="gpt-image-2",
        alias="openai-hk",
        output_dir=tmp_path,
        n=2,
        size="2048x2048",
    )

    assert captured["url"] == "https://api.openai-hk.com/v1/chat/completions"
    assert captured["payload"]["model"] == "gpt-image-2"
    assert captured["payload"]["messages"][-1]["content"].startswith("pixel dog")
    assert "Generate 2 images." in captured["payload"]["messages"][-1]["content"]
    assert "2048x2048" in captured["payload"]["messages"][-1]["content"]
    assert "Mozilla" in captured["download_user_agent"]
    assert captured["download_stream"] is False
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
