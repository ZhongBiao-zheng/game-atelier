from __future__ import annotations

import pytest
import requests

from character_workflow.lib.callers import tuzi_async


class Response:
    def __init__(self, status_code=200, **payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


@pytest.mark.parametrize("size", ["auto", "1024x1536"])
@pytest.mark.parametrize("reference_count", [0, 1, 2])
def test_native_image_task_multipart_poll_and_result(monkeypatch, size, reference_count):
    events = []
    files = [("image", (f"ref{i}.png", b"png", "image/png")) for i in range(reference_count)]

    def post(url, **kwargs):
        assert url == "https://api.tu-zi.com/v1/videos"
        assert "json" not in kwargs and "data" not in kwargs
        parts = kwargs["files"]
        assert dict(parts[:3]) == {
            "model": (None, "gpt-image-2"), "prompt": (None, "architecture"),
            "size": (None, size),
        }
        assert parts[3:] == [("input_reference", part) for _, part in files]
        events.append("submit")
        return Response(id="paid/1", status="queued")

    def get(url, **kwargs):
        assert url == "https://api.tu-zi.com/v1/videos/paid%2F1"
        assert events == ["submit", "paid/1"]
        return Response(status="completed", video_url="https://cdn.example/image.jpg")

    monkeypatch.setattr(tuzi_async.requests, "post", post)
    monkeypatch.setattr(tuzi_async.requests, "get", get)
    result = tuzi_async.execute_multipart(
        url="https://api.tu-zi.com/v1/images/edits", api_key="test",
        fields={"model": "gpt-image-2", "prompt": "architecture", "size": size,
                "n": 4, "response_format": "b64_json"},
        files=files, on_task_id=events.append, poll_interval=0,
    )
    assert result == {"data": [{"url": "https://cdn.example/image.jpg"}]}


def test_resume_retries_poll_transport_without_post(monkeypatch):
    calls = []
    monkeypatch.setattr(tuzi_async.requests, "post", lambda *a, **k: pytest.fail("paid POST"))
    def get(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            raise requests.ConnectionError("reset")
        if len(calls) == 2:
            return Response(503)
        return Response(status="completed", video_url="https://cdn.example/image.png")
    monkeypatch.setattr(tuzi_async.requests, "get", get)
    result = tuzi_async.execute_json(
        url="https://api.tu-zi.com/v1/images/generations", api_key="test",
        payload={}, task_id="saved-1", poll_interval=0,
    )
    assert len(calls) == 3 and len(set(calls)) == 1
    assert result["data"][0]["url"].endswith("image.png")


@pytest.mark.parametrize("payload,match", [
    ({"status": "failed", "error": {"message": "rejected"}}, "rejected"),
    ({"status": "mystery"}, "未知状态"),
    ({"status": "completed"}, "没有有效图片地址"),
    ({"status": "completed", "video_url": "file:///private/a.png"}, "没有有效图片地址"),
])
def test_invalid_terminal_result_is_not_an_empty_image(monkeypatch, payload, match):
    monkeypatch.setattr(tuzi_async.requests, "get", lambda *a, **k: Response(**payload))
    with pytest.raises(tuzi_async.TuziAsyncError, match=match):
        tuzi_async.execute_json(url="https://api.tu-zi.com", api_key="test", payload={},
                                task_id="paid-1", poll_interval=0)


def test_pending_and_cancel_preserve_order_without_resubmit(monkeypatch):
    monkeypatch.setattr(tuzi_async.requests, "post", lambda *a, **k: pytest.fail("paid POST"))
    monkeypatch.setattr(tuzi_async.requests, "get", lambda *a, **k: Response(status="in_progress"))
    with pytest.raises(tuzi_async.TuziAsyncPendingError, match="paid-1"):
        tuzi_async.execute_json(url="https://api.tu-zi.com", api_key="test", payload={},
                                task_id="paid-1", poll_interval=0, max_polls=1)
    with pytest.raises(tuzi_async.TuziAsyncPendingError, match="停止"):
        tuzi_async.execute_json(url="https://api.tu-zi.com", api_key="test", payload={},
                                task_id="paid-1", should_cancel=lambda: True)


@pytest.mark.parametrize("response,match", [
    (Response(410, error={"message": "retired; please use /v1/videos"}), "HTTP 410"),
    (Response(id="x" * 513), "任务 ID 过长"),
    (Response(status="queued"), "未返回任务 ID"),
])
def test_submit_failure_never_retries_or_polls(monkeypatch, response, match):
    count = []
    def post(*args, **kwargs):
        count.append(1)
        return response
    monkeypatch.setattr(tuzi_async.requests, "post", post)
    monkeypatch.setattr(tuzi_async.requests, "get", lambda *a, **k: pytest.fail("no task"))
    with pytest.raises(tuzi_async.TuziAsyncError, match=match):
        tuzi_async.execute_json(url="https://api.tu-zi.com", api_key="test",
                                payload={"model": "gpt-image-2", "prompt": "x"})
    assert count == [1]


@pytest.mark.parametrize("fields,files", [
    ({"model": "gpt-image-2-1k"}, []),
    ({"model": "gpt-image-2", "background": "transparent"}, []),
    ({"model": "gpt-image-2", "quality": "high"}, []),
    ({"model": "gpt-image-2"}, [("mask", ("m.png", b"png", "image/png"))]),
])
def test_unsupported_native_fields_rejected_before_billing(monkeypatch, fields, files):
    monkeypatch.setattr(tuzi_async.requests, "post", lambda *a, **k: pytest.fail("paid POST"))
    with pytest.raises(tuzi_async.TuziAsyncError):
        tuzi_async.execute_multipart(url="https://api.tu-zi.com", api_key="test",
                                     fields=fields, files=files)
