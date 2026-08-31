import http.client
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from character_workflow.lib import data_root
from viewer_server import connection_status
from viewer_server.connection_status import (
    INSTANCE_ENV,
    STATUS_PATH,
    LocalConnectionStatus,
    create_connection_status,
    probe_connection_status,
)
from viewer_server.server_app import build_app


INSTANCE_ID = "a" * 32


def payload(**overrides):
    return {
        "service": "game-atelier",
        "instance_id": INSTANCE_ID,
        "app_version": "5.33.2",
        "protocol": "atelier-local/1",
        **overrides,
    }


@contextmanager
def status_server(body, *, status=200, content_type="application/json", location=None):
    paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if location:
                self.send_header("Location", location)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield httpd.server_port, paths
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def test_status_is_minimal_uncached_and_does_not_read_user_configuration(tmp_path, monkeypatch):
    def forbidden():
        raise AssertionError("discovery must not read data root or user configuration")

    monkeypatch.setattr(data_root, "resolve_data_root", forbidden)
    client = TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "no-dist", instance_id=INSTANCE_ID))
    response = client.get(STATUS_PATH)

    manifest = Path(__file__).resolve().parents[1] / ".claude-plugin" / "plugin.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    assert response.status_code == 200
    assert response.json() == payload(app_version=version)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in response.headers


def test_instance_is_stable_in_one_app_and_changes_between_apps(tmp_path, monkeypatch):
    monkeypatch.delenv(INSTANCE_ENV, raising=False)
    first = TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path))
    second = TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path))
    first_id = first.get(STATUS_PATH).json()["instance_id"]
    assert first.get(STATUS_PATH).json()["instance_id"] == first_id
    assert second.get(STATUS_PATH).json()["instance_id"] != first_id


def test_launcher_passes_instance_without_exposing_an_access_token(monkeypatch):
    monkeypatch.setenv(INSTANCE_ENV, INSTANCE_ID)
    assert create_connection_status().instance_id == INSTANCE_ID
    assert create_connection_status("b" * 32).instance_id == "b" * 32
    monkeypatch.setenv(INSTANCE_ENV, "invalid")
    with pytest.raises(ValidationError):
        create_connection_status()
    with pytest.raises(ValidationError):
        create_connection_status("")


def test_probe_only_requests_the_status_endpoint_and_ignores_system_proxy(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")
    with status_server(json.dumps(payload()).encode()) as (port, paths):
        result = probe_connection_status(port)
    assert result == LocalConnectionStatus(**payload())
    assert paths == [STATUS_PATH]


@pytest.mark.parametrize("port", [0, -1, 65536, True, "5174", None])
def test_invalid_port_does_not_make_a_request(port):
    assert probe_connection_status(port) is None


@pytest.mark.parametrize("overrides", [
    {"service": "other-app"}, {"instance_id": ""}, {"instance_id": "../secret"},
    {"app_version": 123}, {"protocol": "unimplemented/99"}, {"unexpected": "value"},
])
def test_probe_rejects_another_service_or_invalid_schema(overrides):
    with status_server(json.dumps(payload(**overrides)).encode()) as (port, _):
        assert probe_connection_status(port) is None


@pytest.mark.parametrize("field", ["service", "instance_id", "app_version", "protocol"])
def test_probe_requires_all_identity_fields(field):
    body = payload()
    del body[field]
    with status_server(json.dumps(body).encode()) as (port, _):
        assert probe_connection_status(port) is None


@pytest.mark.parametrize("body", [b"not json", b"[]", b"x" * 4097])
def test_probe_rejects_malformed_or_oversized_response(body):
    with status_server(body) as (port, _):
        assert probe_connection_status(port) is None


@pytest.mark.parametrize("status,content_type", [(503, "application/json"), (200, "text/html")])
def test_probe_does_not_accept_a_spa_or_error_page(status, content_type):
    with status_server(
        json.dumps(payload()).encode(), status=status, content_type=content_type,
    ) as (port, _):
        assert probe_connection_status(port) is None


def test_probe_does_not_follow_redirects_even_to_another_local_server():
    with status_server(json.dumps(payload()).encode()) as (target_port, target_paths):
        with status_server(
            b"", status=302, location=f"http://127.0.0.1:{target_port}/api/config",
        ) as (port, paths):
            assert probe_connection_status(port) is None
    assert paths == [STATUS_PATH]
    assert target_paths == []


def test_invalid_http_response_is_not_treated_as_a_running_server(monkeypatch):
    class BrokenOpener:
        def open(self, *_args, **_kwargs):
            raise http.client.BadStatusLine("not-http")

    monkeypatch.setattr(connection_status.urllib.request, "build_opener", lambda *args: BrokenOpener())
    assert probe_connection_status(5174) is None


def test_connection_status_shape_matches_typescript_contract():
    schema_path = Path(__file__).resolve().parents[1] / "web/src/schema/connection.ts"
    schema = schema_path.read_text(encoding="utf-8")
    for field in LocalConnectionStatus.model_fields:
        assert f"  {field}:" in schema
    assert "protocol: 'atelier-local/1'" in schema
    assert "service: 'game-atelier'" in schema
