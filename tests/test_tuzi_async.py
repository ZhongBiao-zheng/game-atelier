from __future__ import annotations

import json

import pytest
import requests

from character_workflow.lib.callers import tuzi_async


class _Response:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload


def test_submit_persists_task_id_then_polls_completed_json(monkeypatch):
    posted: dict[str, object] = {}
    seen_ids: list[str] = []
    polls = iter([
        _Response(200, {"id": "async-1", "status": "in_progress"}),
        _Response(200, {
            "id": "async-1",
            "status": "completed",
            "status_code": 200,
            "result": {"data": [{"url": "https://cdn.example/out.png"}]},
        }),
    ])

    def fake_post(url, headers, json, timeout):
        posted.update(url=url, headers=headers, json=json, timeout=timeout)
        return _Response(202, {"id": "async-1", "status": "queued"})

    monkeypatch.setattr(tuzi_async.requests, "post", fake_post)
    monkeypatch.setattr(tuzi_async.requests, "get", lambda *args, **kwargs: next(polls))
    monkeypatch.setattr(tuzi_async.video_poll.time, "sleep", lambda _seconds: None)

    result = tuzi_async.execute_json(
        url="https://api.tu-zi.com/v1/images/generations",
        api_key="secret",
        payload={"model": "gpt-image-2", "prompt": "fox"},
        on_task_id=seen_ids.append,
        poll_interval=0,
    )

    assert posted["url"] == "https://api.tu-zi.com/async/v1/images/generations"
    assert seen_ids == ["async-1"]
    assert result == {"data": [{"url": "https://cdn.example/out.png"}]}


def test_resume_existing_task_never_submits_again(monkeypatch):
    monkeypatch.setattr(
        tuzi_async.requests,
        "post",
        lambda *args, **kwargs: pytest.fail("resume must not create another billed task"),
    )
    monkeypatch.setattr(
        tuzi_async.requests,
        "get",
        lambda *args, **kwargs: _Response(200, {
            "id": "async-existing",
            "status": "completed",
            "result": {"data": [{"b64_json": "aGVsbG8="}]},
        }),
    )

    result = tuzi_async.execute_json(
        url="https://api.tu-zi.com/v1/images/generations",
        api_key="secret",
        payload={},
        task_id="async-existing",
        poll_interval=0,
    )

    assert result["data"][0]["b64_json"] == "aGVsbG8="


def test_completed_http_envelope_unwraps_json_body(monkeypatch):
    monkeypatch.setattr(
        tuzi_async.requests,
        "get",
        lambda *args, **kwargs: _Response(200, {
            "status": "completed",
            "result": {
                "status_code": 200,
                "content_type": "application/json",
                "body": '{"data":[{"url":"https://cdn.example/out.png"}]}',
            },
        }),
    )

    result = tuzi_async.execute_json(
        url="https://api.tu-zi.com/v1/images/generations",
        api_key="secret",
        payload={},
        task_id="async-existing",
        poll_interval=0,
    )

    assert result["data"][0]["url"].endswith("out.png")


def test_poll_connection_drop_retries_same_task(monkeypatch):
    calls = {"get": 0}

    def fake_get(*args, **kwargs):
        calls["get"] += 1
        if calls["get"] == 1:
            raise requests.ConnectionError("connection reset by peer")
        return _Response(200, {
            "status": "completed",
            "result": {"data": [{"url": "https://cdn.example/out.png"}]},
        })

    monkeypatch.setattr(tuzi_async.requests, "get", fake_get)
    monkeypatch.setattr(tuzi_async.video_poll.time, "sleep", lambda _seconds: None)

    result = tuzi_async.execute_json(
        url="https://api.tu-zi.com/v1/images/generations",
        api_key="secret",
        payload={},
        task_id="async-existing",
        poll_interval=0,
    )

    assert calls["get"] == 2
    assert result["data"][0]["url"].endswith("out.png")
