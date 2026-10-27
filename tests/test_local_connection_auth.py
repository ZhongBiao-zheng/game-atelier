from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import data_root
from character_workflow.lib.private_json import read_private_json, write_private_json
from character_workflow.lib.canvas_projects import create_canvas_project as create_project
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
    "/api/canvas/projects", "/api/config", "/api/keys", "/api/keys/example/reveal", "/api/jobs",
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
    assert client.get("/api/canvas/projects").status_code == 200
    assert client.post("/api/canvas/projects", json={"name": "授权项目"}).status_code == 201


def test_workshop_body_is_bounded_before_parsing_and_accepts_only_json(client):
    bootstrap(client)
    oversized = client.post("/api/canvas-agent/list-projects", content=b" " * (1024 * 1024 + 1),
                            headers={"Content-Type": "application/json"})
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "REQUEST_TOO_LARGE"
    streamed = client.post("/api/canvas-agent/list-projects", content=iter([b" " * 600000] * 2),
                           headers={"Content-Type": "application/json"})
    assert streamed.status_code == 413
    multipart = client.post("/api/canvas-agent/list-projects", files={"file": ("x", b"x")})
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
        response = client.post("/api/canvas/projects", json={"name": "不应写入"})
        assert response.status_code in {403, 409}
        client.headers[header] = value
    assert client.get("/api/canvas/projects").json()["projects"] == []


def test_duplicate_or_mixed_credentials_fail_closed(client):
    bootstrap(client)
    token = client.cookies.get(COOKIE_NAME)
    assert client.get("/api/canvas/projects", headers={
        "Cookie": f"{COOKIE_NAME}={token}; {COOKIE_NAME}={token}",
    }).status_code == 401
    assert client.get("/api/canvas/projects", headers=[
        ("Authorization", "Bearer one"), ("Authorization", "Bearer two"),
    ]).status_code == 401


def test_agent_cannot_reissue_its_grant_or_bootstrap_a_browser(client):
    bootstrap(client)
    native, _, _, credential = create_grant(client)
    response = native.post("/api/connection/local-session", json={}, headers=LOCAL_HEADERS)
    assert response.status_code == 403
    assert native.put("/api/connection/agent", json={}).status_code == 403
    assert native.request("DELETE", "/api/connection/agent", json={}).status_code == 403
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
    assert client.post("/api/canvas/projects", json={"name": "旧页"}).status_code == 409
    assert client.get("/api/connection/agent").status_code == 200
    assert client.post("/api/canvas/projects", json={"name": "新页"}, headers={
        "X-Atelier-Client": "page-two",
    }).status_code == 201


def test_lease_expiry_and_session_revocation(client):
    result = bootstrap(client).json()
    store = client.app.state.connection_store
    with store.lock:
        store.lease = (*store.lease[:2], time.time() - 1)
    assert client.post("/api/canvas/projects", json={"name": "过期"}).status_code == 409
    session = store.sessions[result["session_id"]]
    store.revoke_session(result["session_id"])
    assert session.revoked.is_set()
    assert client.get("/api/canvas/projects").status_code == 401


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
    response = client.put("/api/connection/agent", json={})
    assert response.status_code == 200, response.text
    assert "token" not in response.text
    credential_path = data_root.agent_credential_file()
    credential = read_private_json(credential_path)
    grant = {"grant_id": credential["grant_id"], "credential_path": str(credential_path)}
    native = TestClient(client.app, base_url=ORIGIN)
    exchange = native.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": client.get("/api/connection/status").json()["instance_id"],
    })
    assert exchange.status_code == 200, exchange.text
    native.headers["Authorization"] = "Bearer " + exchange.json()["session_token"]
    return native, project, grant, credential


def test_credential_store_failure_is_reported_with_reason(client, monkeypatch):
    """Windows ACL / pywin32 / 磁盘不支持权限时写凭据会抛 OSError；页面要看到原因，不是裸 500。"""
    bootstrap(client)
    from viewer_server import connection_auth

    def broken(path, value):
        raise PermissionError("Credential ACL grants another principal access")

    monkeypatch.setattr(connection_auth, "write_private_json", broken)
    response = client.put("/api/connection/agent", json={})
    assert response.status_code == 500
    body = response.json()["error"]
    assert body["code"] == "CREDENTIAL_STORE_FAILED"
    assert "PermissionError" in body["message"] and "pywin32" in body["message"]
    assert client.get("/api/connection/agent").json()["enabled"] is False


def test_grant_exchange_tool_scoping_and_immediate_revocation(client):
    bootstrap(client)
    native, project, grant, credential = create_grant(client)
    response = native.post("/api/canvas-agent/list-projects", json={})
    assert response.status_code == 200, response.text
    assert project.project_id in response.text
    for method, path in [
        ("GET", "/api/canvas/projects"), ("GET", "/api/keys"), ("GET", "/api/raw"),
        ("GET", "/events"), ("GET", "/api/connection/agent"),
        ("POST", "/api/workshop/requests/unknown/approve"), ("POST", "/api/studio/jobs"),
    ]:
        assert native.request(method, path, json={}).status_code == 403
    assert credential["grant_token"] not in client.get("/api/connection/sessions").text
    assert client.request("DELETE", "/api/connection/agent", json={}).json()["enabled"] is False
    assert native.post("/api/canvas-agent/list-projects", json={}).status_code in {401, 403}


def test_agent_credentials_never_become_browser_or_local_management_identity(client):
    bootstrap(client)
    native, _, _, _ = create_grant(client)
    assert native.get("/api/canvas/projects", headers=LOCAL_HEADERS).status_code == 403
    assert native.get("/api/gateway/keys/any-member/token", headers=LOCAL_HEADERS).status_code == 403
    assert client.get("/api/canvas/projects", headers={
        "Authorization": native.headers["Authorization"],
    }).status_code == 403


def test_grants_survive_restart_but_runtime_sessions_do_not(client, tmp_path):
    bootstrap(client)
    native, project, grant, credential = create_grant(client)
    restarted = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    assert restarted.get("/api/canvas/projects", headers=native.headers).status_code == 401
    status = restarted.get("/api/connection/status").json()
    exchange = restarted.post("/api/connection/agent-sessions", json={
        "grant_id": grant["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": status["instance_id"],
    })
    assert exchange.status_code == 200


def test_agent_grant_never_expires_and_reenabling_replaces_it(client):
    bootstrap(client)
    # 范围、能力、有效期参数都已删除：旧页面带它们会被拒，而不是悄悄忽略。
    assert client.put("/api/connection/agent", json={"days": 7}).status_code == 422
    assert client.put("/api/connection/agent", json={}).json()["enabled"] is True
    credential_path = data_root.agent_credential_file()
    old_credential = read_private_json(credential_path)
    client.put("/api/connection/agent", json={})
    new_credential = read_private_json(credential_path)
    assert set(new_credential) == {"service", "base_url", "grant_id", "grant_token"}
    instance_id = client.get("/api/connection/status").json()["instance_id"]
    native = TestClient(client.app, base_url=ORIGIN)

    def exchange(credential):
        return native.post("/api/connection/agent-sessions", json={
            "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
            "instance_id": instance_id,
        }).status_code

    assert exchange(old_credential) == 403
    assert exchange(new_credential) == 200


def test_agent_sees_projects_created_after_enabling(client):
    bootstrap(client)
    native, first, _grant, _credential = create_grant(client)
    later = create_project("开关打开之后新建")
    listed = native.post("/api/canvas-agent/list-projects", json={}).json()
    assert {first.project_id, later.project_id} <= {item["project_id"] for item in listed["projects"]}


def test_legacy_multi_grant_file_is_ignored(client):
    """旧版 grants.json 里的授权（含按项目限范围的自定义授权）升级后一律失效。"""
    bootstrap(client)
    legacy = data_root.agent_credential_file().parent / "grants.json"
    write_private_json(legacy, {"g-old": {"grant_id": "g-old", "token_hash": "0" * 64,
                                          "project_ids": [], "capabilities": ["read"]}})
    status = client.get("/api/connection/agent").json()
    assert status["enabled"] is False and status["connections"] == {}


def test_change_data_root_revokes_existing_sessions(client, monkeypatch, tmp_path):
    bootstrap(client)
    root = tmp_path / "another-root"
    root.mkdir()
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(root))
    assert client.get("/api/canvas/projects").status_code == 401


def test_unknown_registered_app_route_fails_closed(client):
    @client.app.get("/api/unreviewed-plugin-data")
    def unsafe():
        pytest.fail("unregistered capability reached handler")
    bootstrap(client)
    assert client.get("/api/unreviewed-plugin-data").status_code == 403


def test_all_existing_data_routes_are_explicitly_registered(tmp_path):
    # 扫整个 app 而非单个 router：canvas batch 等独立 router 漏登记会静默 403。
    handled_elsewhere = ("/api/connection/", "/api/workshop/", "/api/canvas-agent/")
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


def test_hot_path_reads_grants_file_only_when_it_changes(client, monkeypatch):
    # authenticate 跑在事件循环上、SSE 每 0.5s 刷一次：授权文件必须按 stat 缓存，不能每次都读盘。
    bootstrap(client)
    native, _project, grant, _credential = create_grant(client)
    import viewer_server.connection_auth as auth
    reads: list[Path] = []
    original = auth.read_private_json
    monkeypatch.setattr(auth, "read_private_json", lambda path, *a, **k: reads.append(path) or original(path, *a, **k))
    for _ in range(5):
        assert native.post("/api/canvas-agent/list-projects", json={}).status_code == 200
        assert client.get("/api/connection/agent").status_code == 200
    assert len(reads) <= 1
    grants_path = Path(grant["credential_path"]).parent / "agent-grant.json"
    write_private_json(grants_path, read_private_json(grants_path, 128 * 1024))
    before = len(reads)
    assert native.post("/api/canvas-agent/list-projects", json={}).status_code == 200
    assert len(reads) == before + 1


def test_agent_status_paths_and_tool_catalog_for_all_control_responses(client, tmp_path, monkeypatch):
    from viewer_server.codex_config import codex_config_path
    from character_workflow.mcp.tool_catalog import TOOL_DEFINITIONS

    codex_home = tmp_path / "codex-config"
    codex_home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    bootstrap(client)
    expected_paths = {"claude-code": str(data_root.agent_credential_file()), "codex": str(codex_config_path())}
    expected_tools = [{"name": tool.name, "billable": tool.billable} for tool in TOOL_DEFINITIONS]
    for method, enabled in (("GET", False), ("PUT", True), ("DELETE", False)):
        response = client.request(method, "/api/connection/agent", **({} if method == "GET" else {"json": {}}))
        assert response.status_code == 200
        status = response.json()
        assert status["enabled"] is enabled
        assert status["config_paths"] == expected_paths
        assert status["tools"] == expected_tools
        assert [tool["name"] for tool in status["tools"] if tool["billable"]] == ["canvas_run"]
        assert "grant_token" not in response.text and ".claude.json" not in response.text
        if enabled:
            assert data_root.agent_credential_file().exists()
            assert codex_config_path().exists()


@pytest.fixture
def update_client(tmp_path, monkeypatch):
    """Keep a single event loop for background update waiting, without starting real services."""
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from viewer_server import update_routes

    root = tmp_path / "bundle"
    root.mkdir()
    monkeypatch.setattr(update_routes, "bootstrap", lambda: SimpleNamespace(
        bundle_root=lambda: root, _current_version=lambda: "5.129.0", is_bundle=lambda: True))
    monkeypatch.setattr(update_routes, "active_work", lambda: {
        "jobs": 1, "agents": 0, "approvals": 0, "gateway": 0,
    })
    app = build_app(dist_dir=tmp_path / "web")
    service = app.state.update_controller
    service.downloader = SimpleNamespace(
        state=lambda: {"status": "ready", "to": "5.130.0", "version": "5.130.0"},
        check=lambda **kwargs: None,
    )
    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await service.close()
    app.router.lifespan_context = lifespan
    with TestClient(app, base_url=ORIGIN) as connection:
        bootstrap(connection)
        yield connection, service


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/update/state"), ("GET", "/api/update/result?id=example"),
    ("POST", "/api/update/check"), ("POST", "/api/update/apply"), ("POST", "/api/update/cancel"),
])
def test_update_endpoints_require_local_management_session(client, method, path):
    assert client.request(method, path, json={}).status_code == 401
    assert local_capability(method, path.split("?")[0]) == "manage"
    bootstrap(client)
    native, _, _, _ = create_grant(client)
    assert native.request(method, path, json={}).status_code == 403


def test_source_mode_cannot_apply_bundle_update(client):
    bootstrap(client)
    assert client.get("/api/update/state").json()["runtime_mode"] == "source"
    assert client.post("/api/update/apply", json={}).status_code == 400
    assert client.post("/api/update/check", json={}).status_code == 400


def test_update_apply_is_single_flight_and_cancel_clears_maintenance(update_client):
    connection, service = update_client
    first = connection.post("/api/update/apply", json={})
    assert first.status_code == 202
    update_id = first.json()["update_id"]
    assert len(update_id) == 32 and service.gate.blocked()
    assert connection.post("/api/update/apply", json={}).status_code == 409
    assert connection.post("/api/update/check", json={}).status_code == 409
    cancelled = connection.post("/api/update/cancel", json={})
    assert cancelled.status_code == 200
    assert not service.gate.blocked()
    assert not (service.gate.runtime / "maintenance").exists()
    result = connection.get("/api/update/result", params={"id": update_id}).json()
    assert result["status"] == "cancelled"
    assert connection.get("/api/update/result", params={"id": "another-update"}).json() is None
    assert connection.post("/api/update/cancel", json={}).status_code == 409


def test_update_existing_transaction_lock_rejects_apply(update_client):
    from character_workflow.lib.file_lock import try_file_lock
    connection, service = update_client
    with try_file_lock(service.gate.runtime / "update.lock") as acquired:
        assert acquired
        assert connection.post("/api/update/apply", json={}).status_code == 409
    assert not service.gate.blocked()


@pytest.mark.parametrize("path", [
    "/api/studio/jobs", "/api/canvas-agent/run", "/api/jobs/example/confirm",
    "/api/canvas/projects/example/runs", "/api/canvas/projects/example/runs/angle",
    "/api/canvas/projects/example/batch-runs/batch/start",
    "/api/canvas/projects/example/agent/sessions/session/messages",
])
def test_maintenance_rejects_new_generation_before_payload_or_provider(update_client, path):
    connection, service = update_client
    assert connection.post("/api/update/apply", json={}).status_code == 202
    response = connection.post(path, json={})
    assert response.status_code == 503
    assert response.json()["reason"] == "正在更新，请稍后"
    assert service.gate.requests == 0
    assert connection.post("/api/update/cancel", json={}).status_code == 200


def test_every_route_that_starts_background_work_is_blocked_during_maintenance(tmp_path):
    """work_request 是手写白名单：新增会起后台任务的 POST 路由却忘了登记，维护期间就拦不住。"""
    import ast
    import inspect
    import textwrap
    from viewer_server.update_routes import work_request
    def starts_work(endpoint) -> bool:
        tree = ast.parse(textwrap.dedent(inspect.getsource(endpoint)))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
                if name == "add_task" or name.startswith("submit_"):
                    return True
        return False
    starting = [route.path for route in build_app(dist_dir=tmp_path).routes
                if "POST" in (getattr(route, "methods", None) or set()) and starts_work(route.endpoint)]
    assert len(starting) >= 10
    concrete = {path: path.replace("{", "x").replace("}", "x") for path in starting}
    assert [path for path, sample in concrete.items() if not work_request(sample, "POST")] == []


def test_maintenance_allows_existing_task_cancel_and_approval_routes(update_client):
    from viewer_server.update_routes import work_request
    connection, _ = update_client
    assert connection.post("/api/update/apply", json={}).status_code == 202
    for path in ("/api/jobs/existing/cancel", "/api/canvas/projects/p/runs/r/cancel",
                 "/api/canvas/projects/p/agent/sessions/s/approvals",
                 "/api/canvas/projects/p/agent/sessions/s/cancel"):
        assert not work_request(path, "POST")
        assert connection.post(path, json={}).status_code != 503
    assert connection.post("/api/update/cancel", json={}).status_code == 200


def test_update_spawn_failure_records_result_and_releases_maintenance(update_client, monkeypatch):
    from viewer_server import update_routes
    connection, service = update_client
    monkeypatch.setattr(update_routes, "active_work", lambda: {
        "jobs": 0, "agents": 0, "approvals": 0, "gateway": 0,
    })
    attempts = []
    def fail(command, **kwargs):
        attempts.append((command, kwargs))
        raise OSError("cannot create child")
    monkeypatch.setattr(update_routes.subprocess, "Popen", fail)
    result = connection.post("/api/update/apply", json={})
    assert result.status_code == 202
    update_id = result.json()["update_id"]
    deadline = time.monotonic() + 3
    while service.phase != "idle" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert attempts and service.phase == "idle"
    command, options = attempts[0]
    assert "--apply-update" in command
    assert options["stdin"] == update_routes.subprocess.DEVNULL
    assert options["stdout"] is options["stderr"]
    if os.name == "nt":
        assert options["creationflags"] & update_routes.subprocess.DETACHED_PROCESS
        assert options["creationflags"] & update_routes.subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        assert options["start_new_session"] is True
    assert not service.gate.blocked()
    assert not (service.root / "updates/pending.json").exists()
    assert connection.get("/api/update/result", params={"id": update_id}).json()["status"] == "failed"


@pytest.mark.asyncio
async def test_update_admission_race_never_loses_registered_requests():
    import asyncio
    from viewer_server.update_routes import UpdateAdmissionMiddleware, admission

    gate = admission()
    release = asyncio.Event()
    admitted = []
    statuses = []
    async def application(scope, receive, send):
        admitted.append(scope["request_index"])
        await release.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"done"})
    middleware = UpdateAdmissionMiddleware(application)
    async def send(message):
        if message["type"] == "http.response.start":
            statuses.append(message["status"])
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    def request(index):
        return asyncio.create_task(middleware({"type": "http", "path": "/api/studio/jobs",
                                               "method": "POST", "request_index": index}, receive, send))
    running = [request(i) for i in range(20)]
    await asyncio.sleep(0)
    with gate.lock:
        gate.maintenance = True
        assert gate.requests == len(admitted) == 20
    running += [request(i) for i in range(20, 40)]
    await asyncio.sleep(0)
    assert gate.requests == 20
    release.set()
    await asyncio.gather(*running)
    assert gate.requests == 0
    assert statuses.count(200) == 20 and statuses.count(503) == 20
    gate.maintenance = False


def test_update_snapshot_keeps_finishing_request_count_until_work_read_completes(update_client, monkeypatch):
    import threading
    from viewer_server import update_routes
    _, service = update_client
    reading = threading.Event()
    trying_to_finish = threading.Event()
    deregistered = threading.Event()
    service.gate.requests = 1
    def persistent_work():
        # The persistent snapshot predates this request's newly registered job.
        reading.set()
        assert trying_to_finish.wait(timeout=2)
        assert deregistered.wait(timeout=2)
        return {"jobs": 0, "agents": 0, "approvals": 0, "gateway": 0}
    def finish_request():
        assert reading.wait(timeout=2)
        trying_to_finish.set()
        with service.gate.lock:
            service.gate.requests -= 1
            deregistered.set()
    monkeypatch.setattr(update_routes, "active_work", persistent_work)
    worker = threading.Thread(target=finish_request)
    worker.start()
    _, waiting = service.snapshot_work()
    worker.join(timeout=2)
    assert not worker.is_alive()
    assert waiting == 1
    assert deregistered.is_set() and service.gate.requests == 0


def test_update_cancel_during_work_snapshot_never_launches_executor(update_client, monkeypatch):
    import threading
    from viewer_server import update_routes
    connection, service = update_client
    reading = threading.Event()
    release = threading.Event()
    spawned = []
    responses = []
    def persistent_work():
        reading.set()
        assert release.wait(timeout=3)
        return {"jobs": 0, "agents": 0, "approvals": 0, "gateway": 0}
    def forbidden_spawn(*args, **kwargs):
        spawned.append(True)
        raise OSError("must not spawn after cancel")
    monkeypatch.setattr(update_routes, "active_work", persistent_work)
    monkeypatch.setattr(update_routes.subprocess, "Popen", forbidden_spawn)
    started = connection.post("/api/update/apply", json={})
    assert started.status_code == 202
    assert reading.wait(timeout=2)
    worker = threading.Thread(target=lambda: responses.append(connection.post("/api/update/cancel", json={})))
    worker.start()
    try:
        deadline = time.monotonic() + 2
        while not service.cancelled.is_set() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert service.cancelled.is_set()
        worker.join(timeout=1)
        assert not worker.is_alive(), "cancellation must not wait for the file read"
        assert not service.gate.blocked()
        assert service.waiting == 0
    finally:
        release.set()
        worker.join(timeout=3)
    assert not worker.is_alive()
    assert responses[0].status_code == 200
    assert not spawned
    assert not service.gate.blocked()
    result = connection.get("/api/update/result", params={"id": started.json()["update_id"]}).json()
    assert result["status"] == "cancelled"


def test_update_wait_timeout_returns_to_normal_operation(update_client, monkeypatch):
    from viewer_server import update_routes
    connection, service = update_client
    monkeypatch.setattr(update_routes, "WAIT_SECONDS", 0)
    started = connection.post("/api/update/apply", json={})
    assert started.status_code == 202
    deadline = time.monotonic() + 2
    while service.phase != "idle" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert service.phase == "idle" and not service.gate.blocked()
    result = connection.get("/api/update/result", params={"id": started.json()["update_id"]}).json()
    assert result["status"] == "failed" and "超时" in result["reason"]


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/update/state"), ("GET", "/api/update/result?id=example"),
    ("POST", "/api/update/check"), ("POST", "/api/update/apply"), ("POST", "/api/update/cancel"),
])
def test_gateway_admin_token_does_not_authorize_local_updates(client, method, path):
    from character_workflow.lib.gateway_keys import create_key
    _, token = create_key("remote-admin", role="admin")
    response = client.request(method, path, json={}, headers={"Authorization": "Bearer " + token})
    assert response.status_code == 401


def test_candidate_initialization_blocks_persistent_connection_management(update_client):
    connection, service = update_client
    credential = data_root.agent_credential_file()
    before = credential.read_bytes() if credential.exists() else None
    service.gate.initializing = True
    try:
        assert connection.get("/api/connection/status").status_code == 200
        assert connection.get("/api/update/state").status_code == 200
        assert connection.put("/api/connection/agent", json={}).status_code == 503
        assert connection.request("DELETE", "/api/connection/agent", json={}).status_code == 503
        assert (credential.read_bytes() if credential.exists() else None) == before
    finally:
        service.gate.initializing = False


def test_update_blocked_work_read_times_out_without_late_state_write(update_client, monkeypatch):
    import threading
    from viewer_server import update_routes
    connection, service = update_client
    reading = threading.Event()
    release = threading.Event()
    completed = threading.Event()
    def persistent_work():
        reading.set()
        assert release.wait(timeout=3)
        completed.set()
        return {"jobs": 99}
    monkeypatch.setattr(update_routes, "active_work", persistent_work)
    monkeypatch.setattr(update_routes, "WORK_READ_SECONDS", 0.05)
    started = connection.post("/api/update/apply", json={})
    assert started.status_code == 202
    try:
        assert reading.wait(timeout=1)
        deadline = time.monotonic() + 1
        while service.phase != "idle" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert service.phase == "idle" and not service.gate.blocked()
        result = connection.get("/api/update/result", params={"id": started.json()["update_id"]}).json()
        assert result["status"] == "failed" and "读取任务状态超时" in result["reason"]
    finally:
        release.set()
    assert completed.wait(timeout=1)
    assert service.waiting == 0
    assert service.counts.get("jobs", 0) != 99


@pytest.mark.asyncio
async def test_candidate_lifespan_waits_for_activation_and_reports_initialization_failure(tmp_path, monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from viewer_server import bundle_update, server_app

    update_id = "a" * 32
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    config = tmp_path / "config.json"
    config.write_text('{"original":true}')
    last_good = tmp_path / "last-good"
    last_good.write_text("1.0.0")
    calls = []
    reports = []
    async def close():
        calls.append("closed")
    @asynccontextmanager
    async def failing_initialization(app):
        calls.append("initialize")
        raise RuntimeError("startup failed")
        yield
    monkeypatch.setenv("GAME_ATELIER_UPDATE_ID", update_id)
    monkeypatch.setattr(bundle_update, "report_started", reports.append)
    monkeypatch.setattr(server_app, "normal_lifespan", failing_initialization)
    service = SimpleNamespace(gate=SimpleNamespace(runtime=runtime, initializing=False), close=close)
    app = SimpleNamespace(state=SimpleNamespace(
        update_controller=service, connection_status=SimpleNamespace(instance_id="candidate"),
    ))
    async with server_app.lifespan(app):
        await asyncio.sleep(0.15)
        assert reports == ["candidate"] and calls == []
        assert service.gate.initializing
        assert config.read_text() == '{"original":true}'
        assert last_good.read_text() == "1.0.0"
        (runtime / f"update-activate-{update_id}").write_text(update_id)
        failed = runtime / f"update-start-failed-{update_id}"
        async with asyncio.timeout(2):
            while not failed.exists():
                await asyncio.sleep(0.01)
        assert calls == ["initialize"]
        assert failed.read_text() == "初始化失败"
        assert not (runtime / f"update-ready-{update_id}").exists()
        assert not (runtime / "update-result.json").exists()
        assert last_good.read_text() == "1.0.0"
        assert config.read_text() == '{"original":true}'
        assert service.gate.initializing
    assert calls == ["initialize", "closed"]


@pytest.mark.parametrize("handoff_before_snapshot", [False, True])
def test_update_work_snapshot_cannot_miss_agent_to_job_handoff(monkeypatch, handoff_before_snapshot):
    from types import SimpleNamespace
    from character_workflow.lib import canvas_agent_sessions, canvas_projects, gateway_live, gateway_tasks, jobs
    from viewer_server.update_routes import active_work

    session_status = "idle" if handoff_before_snapshot else "running"
    pending_jobs = [SimpleNamespace(status=SimpleNamespace(value="running"))] if handoff_before_snapshot else []
    def read_sessions(_project_id):
        # Persistent reads return a snapshot, not a mutable view of the running agent.
        return SimpleNamespace(sessions=[SimpleNamespace(status=session_status)])
    def read_jobs():
        nonlocal session_status
        snapshot = list(pending_jobs)
        # The agent schedules a daemon worker and completes its turn just after the
        # jobs snapshot. Reading sessions afterward would see idle and lose both.
        if not handoff_before_snapshot:
            pending_jobs.append(SimpleNamespace(status=SimpleNamespace(value="running")))
            session_status = "idle"
        return snapshot
    monkeypatch.setattr(canvas_projects, "list_canvas_projects", lambda: [SimpleNamespace(project_id="p")])
    monkeypatch.setattr(canvas_agent_sessions, "list_canvas_agent_sessions", read_sessions)
    monkeypatch.setattr(jobs, "list_jobs", read_jobs)
    monkeypatch.setattr(gateway_tasks, "_all_tasks", lambda: [])
    monkeypatch.setattr(gateway_live, "active", lambda: [])
    counts = active_work()
    assert sum(counts.values()) == 1
    assert counts["jobs" if handoff_before_snapshot else "agents"] == 1
