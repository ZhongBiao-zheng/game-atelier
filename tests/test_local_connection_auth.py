from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.private_json import read_private_json, write_private_json
from character_workflow.lib.projects import create_project
from viewer_server.connection_auth import COOKIE_NAME, ConnectionError, ConnectionStore
from viewer_server.connection_capabilities import local_capability
from viewer_server.connection_middleware import ConnectionMiddleware
from viewer_server.server_app import build_app

ORIGIN = "http://127.0.0.1:5174"
LOCAL_HEADERS = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def client(tmp_path):
    return TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)


def bootstrap(client, client_id="page-one"):
    client.headers.update(LOCAL_HEADERS)
    response = client.post("/api/connection/local-session", json={})
    assert response.status_code == 200, response.text
    assert client.post("/api/connection/editor-lease", json={"client_id": client_id}).status_code == 200
    client.headers["X-Atelier-Client"] = client_id
    return response


@pytest.mark.parametrize("path", [
    "/api/projects", "/api/config", "/api/keys", "/api/keys/example/reveal", "/api/jobs",
    "/api/raw?path=private.png", "/api/gallery/image?path=private.png", "/events",
    "/docs", "/openapi.json", "/api/canvas/projects/example/document", "/api/unknown",
])
def test_anonymous_private_reads_never_reach_routes(client, path):
    response = client.get(path)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "CONNECTION_REQUIRED"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("headers", [
    {}, {"Origin": ORIGIN}, {"Sec-Fetch-Site": "same-origin"},
    {"Origin": "https://evil.test", "Sec-Fetch-Site": "same-origin"},
    {"Origin": ORIGIN, "Sec-Fetch-Site": "same-site"},
])
def test_bootstrap_requires_real_local_browser_metadata(client, headers):
    response = client.post("/api/connection/local-session", json={}, headers=headers)
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_local_bootstrap_is_idempotent_and_cookie_is_private(client):
    response = bootstrap(client)
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie
    again = client.post("/api/connection/local-session", json={})
    assert again.json() == response.json()
    assert "set-cookie" not in again.headers
    assert client.get("/api/projects").status_code == 200
    assert client.post("/api/projects", json={"name": "授权项目"}).status_code == 200


def test_workshop_body_is_bounded_before_parsing_and_accepts_only_json(client):
    bootstrap(client)
    oversized = client.post("/api/workshop/list-projects", content=b" " * (1024 * 1024 + 1),
                            headers={"Content-Type": "application/json"})
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "REQUEST_TOO_LARGE"
    streamed = client.post("/api/workshop/list-projects", content=iter([b" " * 600000] * 2),
                           headers={"Content-Type": "application/json"})
    assert streamed.status_code == 413
    multipart = client.post("/api/workshop/list-projects", files={"file": ("x", b"x")})
    assert multipart.status_code == 415


def test_media_cookie_get_does_not_need_origin_header(client):
    bootstrap(client)
    client.headers.pop("Origin")
    # An invalid resource reaches the media whitelist (404), not a connection rejection.
    assert client.get("/api/raw", params={"path": "not-registered.png"}).status_code == 404


def test_business_write_requires_lease_and_origin(client):
    bootstrap(client)
    for header in ("X-Atelier-Client", "Origin"):
        value = client.headers.pop(header)
        response = client.post("/api/projects", json={"name": "不应写入"})
        assert response.status_code in {403, 409}
        client.headers[header] = value
    assert client.get("/api/projects").json()["projects"] == []


def test_duplicate_or_mixed_credentials_fail_closed(client):
    bootstrap(client)
    token = client.cookies.get(COOKIE_NAME)
    assert client.get("/api/projects", headers={
        "Cookie": f"{COOKIE_NAME}={token}; {COOKIE_NAME}={token}",
    }).status_code == 401
    assert client.get("/api/projects", headers=[
        ("Authorization", "Bearer one"), ("Authorization", "Bearer two"),
    ]).status_code == 401


def test_readonly_agent_cannot_create_grants_or_bootstrap_a_browser(client):
    bootstrap(client)
    native, _, _, credential = create_grant(client)
    response = native.post("/api/connection/local-session", json={}, headers=LOCAL_HEADERS)
    assert response.status_code == 403
    response = native.post("/api/connection/agent-grants", json={
        "name": "逃逸", "project_ids": ["other"], "capabilities": ["read"],
    })
    assert response.status_code == 403
    credential_path = client.app.state.connection_store._grants_path()
    persisted = read_private_json(credential_path, 128 * 1024)
    assert credential["grant_token"] not in json.dumps(persisted)
    assert credential_path.is_file()


def test_explicit_takeover_blocks_old_tab_without_revoking_management(client):
    bootstrap(client)
    conflict = client.post("/api/connection/editor-lease", json={"client_id": "page-two"})
    assert conflict.status_code == 409
    assert client.post("/api/connection/editor-lease", json={
        "client_id": "page-two", "takeover": True,
    }).status_code == 200
    assert client.post("/api/projects", json={"name": "旧页"}).status_code == 409
    assert client.get("/api/connection/agent-grants").status_code == 200
    assert client.post("/api/projects", json={"name": "新页"}, headers={
        "X-Atelier-Client": "page-two",
    }).status_code == 200


def test_lease_expiry_and_session_revocation(client):
    result = bootstrap(client).json()
    store = client.app.state.connection_store
    with store.lock:
        store.lease = (*store.lease[:2], time.time() - 1)
    assert client.post("/api/projects", json={"name": "过期"}).status_code == 409
    session = store.sessions[result["session_id"]]
    assert client.request("DELETE", f"/api/connection/sessions/{result['session_id']}", json={},
                          headers={"Content-Type": "application/json"}).status_code == 204
    assert session.revoked.is_set()
    assert client.get("/api/projects").status_code == 401


def test_control_size_content_type_and_extra_fields(client):
    bootstrap(client)
    assert client.post("/api/connection/editor-lease", data={"client_id": "a"}).status_code == 415
    assert client.post("/api/connection/editor-lease", json={
        "client_id": "a", "confirmed": True,
    }).status_code == 422
    assert client.post("/api/connection/editor-lease", content=b"x" * 16385,
                       headers={"Content-Type": "application/json"}).status_code == 413


def create_grant(client):
    project = create_project("本机授权测试")
    response = client.post("/api/connection/agent-grants", json={
        "name": "Codex 测试", "project_ids": [project.id], "capabilities": ["read"], "days": 7,
    })
    assert response.status_code == 201, response.text
    grant = response.json()
    assert "token" not in json.dumps(grant)
    credential = read_private_json(Path(grant["credential_path"]))
    native = TestClient(client.app, base_url=ORIGIN)
    exchange = native.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": client.get("/api/connection/status").json()["instance_id"],
    })
    assert exchange.status_code == 200, exchange.text
    native.headers["Authorization"] = "Bearer " + exchange.json()["session_token"]
    return native, project, grant, credential


def test_grant_exchange_tool_scoping_and_immediate_revocation(client):
    bootstrap(client)
    native, project, grant, credential = create_grant(client)
    response = native.post("/api/workshop/list-projects", json={})
    assert response.status_code == 200, response.text
    assert project.id in response.text
    for method, path in [
        ("GET", "/api/projects"), ("GET", "/api/keys"), ("GET", "/api/raw"),
        ("GET", "/events"), ("GET", "/api/connection/agent-grants"),
        ("POST", "/api/workshop/requests/unknown/approve"), ("POST", "/api/studio/jobs"),
    ]:
        assert native.request(method, path, json={}).status_code == 403
    assert credential["grant_token"] not in client.get("/api/connection/sessions").text
    assert client.request("DELETE", f"/api/connection/agent-grants/{grant['grant_id']}",
                          json={}).status_code == 204
    assert native.post("/api/workshop/list-projects", json={}).status_code in {401, 403}


def test_agent_credentials_never_become_browser_or_local_management_identity(client):
    bootstrap(client)
    native, _, _, _ = create_grant(client)
    assert native.get("/api/projects", headers=LOCAL_HEADERS).status_code == 403
    assert client.get("/api/projects", headers={
        "Authorization": native.headers["Authorization"],
    }).status_code == 403


def test_grants_survive_restart_but_runtime_sessions_do_not(client, tmp_path):
    bootstrap(client)
    native, project, grant, credential = create_grant(client)
    restarted = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    assert restarted.get("/api/projects", headers=native.headers).status_code == 401
    status = restarted.get("/api/connection/status").json()
    exchange = restarted.post("/api/connection/agent-sessions", json={
        "grant_id": grant["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": status["instance_id"],
    })
    assert exchange.status_code == 200 and exchange.json()["project_ids"] == [project.id]


def test_change_data_root_revokes_existing_sessions(client, monkeypatch, tmp_path):
    bootstrap(client)
    root = tmp_path / "another-root"
    root.mkdir()
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(root))
    assert client.get("/api/projects").status_code == 401


def test_unknown_registered_app_route_fails_closed(client):
    @client.app.get("/api/unreviewed-plugin-data")
    def unsafe():
        pytest.fail("unregistered capability reached handler")
    bootstrap(client)
    assert client.get("/api/unreviewed-plugin-data").status_code == 403


def test_all_existing_data_routes_are_explicitly_registered(tmp_path):
    # 扫整个 app 而非单个 router：canvas batch 等独立 router 漏登记会静默 403。
    handled_elsewhere = ("/api/connection/", "/api/workshop/")
    for route in build_app(dist_dir=tmp_path).routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/") or path.startswith(handled_elsewhere):
            continue
        if path == "/api/connection/status" or not getattr(route, "methods", None):
            continue
        for method in route.methods:
            sample = route.path
            for name in route.param_convertors:
                sample = sample.replace("{" + name + "}", "example")
            assert local_capability(method, sample) is not None, (method, route.path)


async def test_missing_auth_rejects_before_body_read(tmp_path):
    async def forbidden(*_):
        pytest.fail("unauthenticated request reached body or route")
    messages = []

    async def send(message):
        messages.append(message)
    await ConnectionMiddleware(forbidden, store=ConnectionStore("a" * 32))({
        "type": "http", "method": "POST", "path": "/api/uploads",
        "server": ("127.0.0.1", 5174), "headers": [],
    }, forbidden, send)
    assert messages[0]["status"] == 401


def test_private_credentials_are_bounded_and_owner_only(tmp_path):
    path = tmp_path / "credential.json"
    write_private_json(path, {"token": "test-only"})
    assert read_private_json(path) == {"token": "test-only"}
    with pytest.raises(ValueError, match="size"):
        read_private_json(path, 2)
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
        path.chmod(0o644)
        with pytest.raises(PermissionError):
            read_private_json(path)


def test_agent_auth_attempts_are_bounded(client):
    for _ in range(30):
        response = client.post("/api/connection/agent-sessions", json={
            "grant_id": "unknown", "grant_token": "x" * 43,
            "instance_id": client.get("/api/connection/status").json()["instance_id"],
        })
        assert response.status_code == 403
    assert client.post("/api/connection/agent-sessions", json={
        "grant_id": "unknown", "grant_token": "x" * 43,
        "instance_id": client.get("/api/connection/status").json()["instance_id"],
    }).status_code == 429


def test_session_limit_prevents_unbounded_growth():
    store = ConnectionStore("b" * 32)
    for _ in range(64):
        store.local_session(ORIGIN, None)
    with pytest.raises(ConnectionError) as error:
        store.local_session(ORIGIN, None)
    assert error.value.status == 429
