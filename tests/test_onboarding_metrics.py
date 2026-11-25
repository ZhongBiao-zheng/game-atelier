import json
from pathlib import Path

import pytest
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib import onboarding_metrics
from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    assert client.post("/api/connection/local-session", json={}).status_code == 200
    assert client.post("/api/connection/editor-lease", json={
        "client_id": client.headers["X-Atelier-Client"],
    }).status_code == 200
    return client


@pytest.fixture(autouse=True)
def reset_first_seen(monkeypatch):
    monkeypatch.setattr(onboarding_metrics, "_first_seen_at", None)


def _state(root: Path) -> dict:
    return json.loads((root / ".runtime" / "onboarding.json").read_text(encoding="utf-8"))


def _job(job_id: str, status: JobStatus, completed_at: str | None) -> None:
    save_job(Job(
        job_id=job_id, character_id="studio", prompt="fox", submitted_at="2026-11-17T00:00:00+00:00",
        model="gpt-image-2", params=JobParams(size="1024x1024", n=1), output_paths=[],
        status=status, error=None, kind=JobKind.IMAGE, namespace="studio", completed_at=completed_at,
    ))


def test_data_root_set_records_first_seen_once(isolated_data_root, monkeypatch):
    monkeypatch.setattr(onboarding_metrics, "_first_seen_at", "2026-11-17T00:00:00+00:00")
    onboarding_metrics.record_data_root_set(isolated_data_root)
    first = _state(isolated_data_root)
    assert first["first_seen_at"] == "2026-11-17T00:00:00+00:00"
    assert first["data_root_set_at"] and first["events"] == []

    monkeypatch.setattr(onboarding_metrics, "_first_seen_at", "2026-12-01T00:00:00+00:00")
    onboarding_metrics.record_data_root_set(isolated_data_root)
    assert _state(isolated_data_root) == first


def test_events_accept_only_enumerated_values(client, isolated_data_root):
    assert client.post("/api/onboarding/events", json={"event": "path_selected", "path": "key"}).status_code == 204
    assert client.post("/api/onboarding/events", json={"event": "path_selected", "path": "https://x"}).status_code == 422
    assert client.post("/api/onboarding/events", json={"event": "typed", "text": "sk-secret"}).status_code == 422
    assert client.post("/api/onboarding/events", json={"event": "path_selected", "path": "key", "vendor": "acme"}).status_code == 422
    events = _state(isolated_data_root)["events"]
    assert [(e["event"], e["path"]) for e in events] == [("path_selected", "key")]


def test_events_keep_only_latest(client, isolated_data_root, monkeypatch):
    monkeypatch.setattr(onboarding_metrics, "MAX_EVENTS", 3)
    for count in range(5):
        client.post("/api/onboarding/events", json={"event": "models_detected", "count": count})
    assert [e["count"] for e in _state(isolated_data_root)["events"]] == [2, 3, 4]


def test_skip_is_reported_by_status(client, isolated_data_root):
    assert client.get("/api/onboarding/status").json()["onboarding_skipped"] is False
    client.post("/api/onboarding/events", json={"event": "skipped"})
    assert client.get("/api/onboarding/status").json()["onboarding_skipped"] is True


def test_metrics_derive_first_generation_from_jobs(client, isolated_data_root, monkeypatch):
    monkeypatch.setattr(onboarding_metrics, "_first_seen_at", "2026-11-17T01:00:00+00:00")
    onboarding_metrics.record_data_root_set(isolated_data_root)
    state = _state(isolated_data_root)
    (isolated_data_root / ".runtime" / "onboarding.json").write_text(json.dumps(
        {**state, "data_root_set_at": "2026-11-17T01:01:00+00:00"}), encoding="utf-8")
    _job("old-done", JobStatus.DONE, "2026-11-01T00:00:00+00:00")
    _job("failed", JobStatus.FAILED, "2026-11-17T01:03:00+00:00")
    _job("first-done", JobStatus.DONE, "2026-11-17T01:08:20+00:00")
    _job("later-done", JobStatus.DONE, "2026-11-17T02:00:00+00:00")
    client.post("/api/onboarding/events", json={"event": "path_selected", "path": "chatgpt"})
    client.post("/api/onboarding/events", json={"event": "path_selected", "path": "key", "vendor": "tokendance"})
    client.post("/api/onboarding/events", json={"event": "provider_saved", "path": "key", "vendor": "tokendance"})

    body = client.get("/api/onboarding/metrics").json()
    assert body["first_generation"]["completed_at"] == "2026-11-17T01:08:20+00:00"
    assert body["seconds_to_first_generation"] == 500
    assert body["paths_tried"] == ["chatgpt", "key:tokendance"]
    assert body["completed_path"] == "key:tokendance"
    assert body["last_event"]["event"] == "provider_saved"


class _Resp:
    def __init__(self, status: int, body: object):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


@pytest.mark.parametrize(("status", "body", "expected"), [
    (200, {"object": "billing_subscription"}, "ok"),
    (401, {"message": "Invalid token"}, "invalid"),
    (200, {"data": None, "error": 113}, "invalid"),
    (502, {}, "unknown"),
    (200, ValueError("not json"), "unknown"),
])
@pytest.mark.parametrize("preset", ["tuzi", "tokendance"])
def test_key_probe_classifies_responses(client, monkeypatch, preset, status, body, expected):
    calls = []

    def fake_get(url, headers, timeout, allow_redirects):
        assert allow_redirects is False
        calls.append(url)
        return _Resp(status, body)

    monkeypatch.setattr("requests.get", fake_get)
    resp = client.post("/api/onboarding/key-probe", json={"preset": preset, "access_key": "sk-test",
                                                         "base_url": onboarding_metrics.PROBE_BASE_URLS[preset]})
    assert resp.json() == {"result": expected}
    assert calls == [onboarding_metrics.KEY_PROBES[preset]]


def test_key_probe_does_not_follow_redirects(client, monkeypatch):
    import requests
    from requests.adapters import HTTPAdapter

    sent = []

    def fake_adapter_send(self, request, **kwargs):
        # 替换传输层，requests 自己的跟随重定向逻辑仍然生效：跟了就会出现第二个请求。
        sent.append(request.url)
        resp = requests.Response()
        resp.status_code = 302 if len(sent) == 1 else 200
        resp.headers["Location"] = "https://redirect.example/collect"
        resp._content = b"{}"
        resp.url = request.url
        resp.request = request
        resp.raw = None
        return resp

    monkeypatch.setattr(HTTPAdapter, "send", fake_adapter_send)
    resp = client.post("/api/onboarding/key-probe", json={"preset": "tuzi", "access_key": "sk-test",
                                                         "base_url": "https://api.tu-zi.com"})
    assert resp.json() == {"result": "unknown"}
    assert sent == [onboarding_metrics.KEY_PROBES["tuzi"]]


def test_key_probe_skips_vendors_without_probe(client, monkeypatch):
    monkeypatch.setattr("requests.get", lambda *a, **k: pytest.fail("no request expected"))
    resp = client.post("/api/onboarding/key-probe", json={"preset": "evolink", "access_key": "sk-test",
                                                         "base_url": "https://api.evolink.ai/v1"})
    assert resp.json() == {"result": "unknown"}
