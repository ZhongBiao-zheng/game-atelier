from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from viewer_server.request_boundary import DEV_ORIGIN_ENV, LocalRequestBoundary, development_origin
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>Atelier</html>", encoding="utf-8")
    return TestClient(build_app(dist_dir=dist), base_url="http://127.0.0.1:5174")


@pytest.mark.parametrize("host", [
    "attacker.example:5174", "localhost:5174", "127.0.0.1:5175", "127.0.0.1",
    "127.0.0.1:5174.attacker.example", "127.0.0.1.:5174", "2130706433:5174",
    "127.0.0.1:05174", "127.0.0.1:5174 ", "[::1]:5174",
])
def test_rebinding_or_wrong_port_host_is_rejected_before_routing(client, host):
    response = client.get("/api/connection/status", headers={"Host": host})
    assert response.status_code == 421
    assert response.json()["error"]["code"] == "HOST_DENIED"
    assert "instance_id" not in response.text


@pytest.mark.parametrize("path", [
    "/api/connection/status", "/api/config", "/api/raw", "/api/gallery/image", "/api/keys",
    "/api/creation-assets/a/content", "/api/canvas/projects/a/export", "/events",
    "/docs", "/redoc", "/openapi.json", "/api/not-registered", "/", "/assets/main.js",
])
def test_foreign_origins_cannot_reach_api_media_sse_docs_or_static_routes(client, path):
    response = client.get(path, headers={"Origin": "https://attacker.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_DENIED"
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("origin", [
    "null", "file://", "http://localhost:5174", "http://127.0.0.1:5175",
    "http://127.0.0.1:5174/", "https://127.0.0.1:5174", "http://127.0.0.1:5174@evil.test",
    "http://127.0.0.1:5174 https://evil.test", "",
])
def test_origin_must_match_exactly(client, origin):
    assert client.post("/api/projects", json={}, headers={"Origin": origin}).status_code == 403


@pytest.mark.parametrize("site", ["cross-site", "same-site", "none", "unknown"])
def test_fetch_metadata_blocks_originless_browser_requests_to_private_routes(client, site):
    response = client.get("/api/config", headers={"Sec-Fetch-Site": site})
    assert response.status_code == 403


@pytest.mark.parametrize("metadata", [
    {"Sec-Fetch-Mode": "no-cors"},
    {"Sec-Fetch-Dest": "image"},
    {"Sec-Fetch-User": "?1"},
    {"Sec-Fetch-Storage-Access": "none"},
    {"Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image"},
])
@pytest.mark.parametrize("origin", [None, "http://127.0.0.1:5174"])
def test_incomplete_metadata_is_not_treated_as_a_native_client(client, metadata, origin):
    headers = dict(metadata)
    if origin is not None:
        headers["Origin"] = origin
    assert client.get("/api/raw", headers=headers).status_code == 403


def test_public_status_advertises_protocol_without_granting_a_session(client):
    for headers in ({}, {"Origin": "http://127.0.0.1:5174", "Sec-Fetch-Site": "same-origin"}):
        response = client.get("/api/connection/status", headers=headers)
        assert response.status_code == 200
        assert response.json()["protocol"] == "atelier-local/1"
        assert "set-cookie" not in response.headers
        assert "access-control-allow-origin" not in response.headers


def test_links_can_open_the_local_page_but_cannot_navigate_to_private_data(client):
    headers = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
    assert client.get("/studio", headers=headers).status_code == 200
    for path in ("/api", "/api/config", "/api/raw", "/events", "/docs", "/openapi.json"):
        assert client.get(path, headers=headers).status_code == 403
    assert client.post("/api/projects", headers=headers, json={}).status_code == 403


def test_cross_site_iframes_and_images_cannot_use_navigation_exception(client):
    for dest in ("iframe", "image", "empty"):
        headers = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest}
        assert client.get("/", headers=headers).status_code == 403


def test_options_does_not_enable_cross_origin_requests(client):
    response = client.options("/api/projects", headers={
        "Origin": "https://test.vercel.app", "Access-Control-Request-Method": "POST",
    })
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_forwarded_headers_cannot_replace_socket_identity(client):
    response = client.get("/api/config", headers={
        "Host": "evil.test", "X-Forwarded-Host": "127.0.0.1:5174",
        "Forwarded": 'host="127.0.0.1:5174";proto=http',
    })
    assert response.status_code == 421


@pytest.mark.parametrize("name,value", [
    ("Host", "127.0.0.1:5174"), ("Origin", "http://127.0.0.1:5174"),
    ("Sec-Fetch-Site", "same-origin"),
    ("Sec-Fetch-Mode", "cors"), ("Sec-Fetch-Dest", "empty"),
    ("Sec-Fetch-User", "?1"),
])
def test_duplicate_security_headers_are_not_coalesced_into_a_trusted_value(client, name, value):
    response = client.get("/api/config", headers=[(name, value), (name, value)])
    assert response.status_code == 403


def test_dev_origin_requires_explicit_registration_and_exact_match(client, monkeypatch, tmp_path):
    headers = {"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-origin"}
    assert client.get("/api/config", headers=headers).status_code == 403
    monkeypatch.setenv(DEV_ORIGIN_ENV, "http://localhost:5173")
    dev = TestClient(build_app(dist_dir=tmp_path), base_url="http://127.0.0.1:5174")
    assert dev.get("/api/connection/status", headers=headers).status_code == 200
    assert dev.get("/api/connection/status", headers={
        **headers, "Origin": "http://localhost:5176",
    }).status_code == 403
    # Vite must rewrite Host but preserve the browser's Origin.
    assert dev.get("/api/connection/status", headers={**headers, "Host": "localhost:5173"}).status_code == 421


@pytest.mark.parametrize("origin", [
    "", "*", "https://test.vercel.app", "http://localhost", "http://localhost:5173/",
    "http://localhost:0", "http://localhost:65536", "http://user@localhost:5173",
    "http://127.0.0.1:5173?x=1", "http://localhost:5173#x", "null", "http://[::1]:5173",
])
def test_invalid_dev_allowlist_fails_at_startup(monkeypatch, origin):
    monkeypatch.setenv(DEV_ORIGIN_ENV, origin)
    with pytest.raises(ValueError, match="exact loopback"):
        development_origin()


@pytest.mark.parametrize("path", ["/api/uploads", "/api/canvas/projects/a/document"])
async def test_rejection_precedes_body_reads_and_any_inner_side_effects(path):
    async def forbidden(*_args):
        pytest.fail("untrusted request reached a body reader or business handler")

    messages = []

    async def send(message):
        messages.append(message)

    app = LocalRequestBoundary(forbidden)
    await app({
        "type": "http", "method": "PUT", "path": path, "server": ("127.0.0.1", 5174),
        "headers": [(b"host", b"127.0.0.1:5174"), (b"origin", b"https://evil.test")],
    }, forbidden, send)
    assert messages[0]["status"] == 403
    assert json.loads(messages[1]["body"])["error"]["code"] == "ORIGIN_DENIED"


async def test_middleware_order_rejects_before_canvas_body_limit(tmp_path):
    app = build_app(dist_dir=tmp_path)
    messages = []

    async def receive():
        pytest.fail("body limit should not read untrusted upload")

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "scheme": "http",
        "method": "PUT", "path": "/api/canvas/projects/a/document", "query_string": b"",
        "server": ("127.0.0.1", 5174), "client": ("127.0.0.1", 50000),
        "headers": [(b"host", b"127.0.0.1:5174"), (b"origin", b"https://evil.test")],
    }, receive, send)
    assert messages[0]["status"] == 403


async def test_unknown_socket_address_fails_closed():
    messages = []

    async def forbidden(*_args):
        pytest.fail("invalid socket reached inner application")

    async def send(message):
        messages.append(message)

    await LocalRequestBoundary(forbidden)({
        "type": "http", "server": None, "headers": [(b"host", b"127.0.0.1:5174")],
    }, forbidden, send)
    assert messages[0]["status"] == 421


async def test_websocket_is_not_an_unreviewed_bypass():
    messages = []

    async def forbidden(*_args):
        pytest.fail("WebSocket reached application without a defined connection contract")

    async def send(message):
        messages.append(message)

    await LocalRequestBoundary(forbidden)({"type": "websocket"}, forbidden, send)
    assert messages == [{"type": "websocket.close", "code": 1008}]


def test_boundary_error_shape_matches_typescript_contract(client):
    from pathlib import Path

    response = client.get("/api/config", headers={"Origin": "https://evil.test"})
    assert set(response.json()) == {"error"}
    error = response.json()["error"]
    assert set(error) == {"code", "message", "request_id"}
    schema = (Path(__file__).parents[1] / "web/src/schema/connection.ts").read_text(encoding="utf-8")
    for field in error:
        assert f"    {field}:" in schema
    assert "'HOST_DENIED' | 'ORIGIN_DENIED'" in schema


def test_localhost_document_navigation_redirects_to_loopback_address(client):
    # 手输 / 收藏 http://localhost:<port> 的用户应被送到 127.0.0.1，而不是看到 JSON 错误页。
    response = client.get("/canvas/abc?x=1", headers={
        "Host": "localhost:5174", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
    }, follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "http://127.0.0.1:5174/canvas/abc?x=1"
    # API 与非导航请求照旧拒绝：不给 localhost 来源任何数据。
    api = client.get("/api/connection/status", headers={"Host": "localhost:5174"})
    assert api.status_code == 421
    fetch = client.get("/", headers={"Host": "localhost:5174", "Sec-Fetch-Mode": "cors",
                                     "Sec-Fetch-Dest": "empty"})
    assert fetch.status_code == 421
