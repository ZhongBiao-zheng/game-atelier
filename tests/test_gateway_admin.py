"""管理员授权、撤权竞态、审计与本机代理边界。所有凭据为隔离测试生成。"""
import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_audit, gateway_keys, gateway_live, keys, model_routes
from viewer_server.connection_capabilities import local_capability
from viewer_server.gateway_admin_proxy import ENDPOINTS, router as proxy_router
from viewer_server.gateway_app import create_gateway_app


@pytest.fixture
def admin():
    gateway_keys.update_settings(enabled=True)
    record, token = gateway_keys.create_key("管理员", role="admin")
    client = TestClient(create_gateway_app())
    client.headers["Authorization"] = f"Bearer {token}"
    return client, record, token


@pytest.mark.parametrize("method,path", ENDPOINTS)
def test_member_rejected_for_every_admin_endpoint(method, path):
    _, token = gateway_keys.create_key("成员")
    path = path.format(key_id="member", member_alias="upstream")
    client = TestClient(create_gateway_app())
    response = client.request(method, "/gateway/v1/admin" + path,
                              headers={"Authorization": f"Bearer {token}"}, json={})
    assert response.status_code == 403
    assert "管理员" in response.json()["detail"]


def test_members_lifecycle_and_audit_never_contain_credentials(admin):
    client, actor, actor_token = admin
    response = client.post("/gateway/v1/admin/keys", json={"name": "设计师", "role": "admin"})
    assert response.status_code == 201
    created = response.json()
    key_id, token = created["key"]["id"], created["token"]
    response = client.patch(f"/gateway/v1/admin/keys/{key_id}", json={
        "role": "member", "limits": [{"period": "month", "cap_cny": 30}]})
    assert response.status_code == 200
    assert response.json()["limits"][0]["cap_cny"] == 30
    assert client.post(f"/gateway/v1/admin/keys/{key_id}/revoke").status_code == 200
    assert gateway_keys.authenticate(token) is None
    listed = client.get("/gateway/v1/admin/keys").text
    audit = client.get("/gateway/v1/admin/audit").json()["entries"]
    raw = gateway_audit.audit_file().read_text()
    for secret in (token, actor_token, gateway_keys.digest(token), actor.token_sha256):
        assert secret not in listed and secret not in raw
    assert [row["action"] for row in audit[:3]] == ["member.revoke", "member.update", "member.create"]
    assert all(row["actor_id"] == actor.id for row in audit[:3])
    assert audit[0]["summary"]["before"]["revoked_at"] is None
    assert audit[0]["summary"]["after"]["revoked_at"]
    assert audit[-1]["actor_name"] == "local"
    assert all(row["time"].endswith("+00:00") for row in audit)


def test_self_revoke_and_demotion_denied_but_local_can_remove_last_admin(admin):
    client, actor, token = admin
    assert client.patch(f"/gateway/v1/admin/keys/{actor.id}", json={"role": "member"}).status_code == 403
    response = client.post(f"/gateway/v1/admin/keys/{actor.id}/revoke")
    assert response.status_code == 403 and "自己" in response.json()["detail"]
    gateway_keys.revoke_key(actor.id)
    assert client.get("/gateway/v1/admin/keys").status_code == 401
    assert gateway_keys.authenticate(token) is None


def test_actor_rechecked_inside_mutation_lock(admin):
    _, actor, _ = admin
    member, _ = gateway_keys.create_key("成员")
    gateway_keys.update_key(actor.id, role="member")
    with pytest.raises(gateway_keys.GatewayAdminError):
        gateway_keys.update_key(member.id, name="非法变更", actor_id=actor.id)
    with pytest.raises(gateway_keys.GatewayAdminError):
        gateway_keys.create_key("非法新增", role="admin", actor_id=actor.id)
    assert next(k for k in gateway_keys.read_config().keys if k.id == member.id).name == "成员"


def test_admin_cannot_send_paths_or_unknown_roles(admin):
    client, _, _ = admin
    for body in ({"name": "bad", "path": "/tmp/secret"}, {"name": "bad", "role": "owner"}):
        assert client.post("/gateway/v1/admin/keys", json=body).status_code == 422
    assert client.get("/gateway/v1/admin/keys/missing/reveal").status_code == 404
    assert client.get("/gateway/v1/admin/raw?path=/tmp/secret").status_code == 404
    assert client.get("/gateway/v1/me").json()["role"] == "admin"


def test_upstream_status_restore_and_order_are_audited_without_keys(admin):
    client, _, _ = admin
    for alias in ("A", "B"):
        keys.add_key(keys.KeySpec(alias=alias, provider="openai", access_key="upstream-secret",
            modalities=["image"], models=[keys.ModelSpec(id="gpt-image-2", name="图片", modality="image")],
            created_at="test"))
    model_routes.cool_down("image", "A", "insufficient_balance")
    response = client.get("/gateway/v1/admin/members")
    assert response.json()["members"][0]["alias"] == "A"
    assert client.post("/gateway/v1/admin/members/A/restore", json={"modality": "image"}).status_code == 200
    assert not model_routes.balance_blocked("image", "A")
    response = client.put("/gateway/v1/admin/routes/order", json={"modality": "image", "id": "gpt-image-2", "aliases": ["B", "A"]})
    assert response.status_code == 200
    assert response.json()["models"][0]["aliases"] == ["B", "A"]
    for path in ("/routes", "/options", "/members", "/audit", "/usage", "/usage/tasks", "/tasks"):
        response = client.get("/gateway/v1/admin" + path)
        assert response.status_code == 200
        assert "upstream-secret" not in response.text and "access_key" not in response.text
    entries = gateway_audit.read()
    assert entries[0]["action"] == "route.reorder"
    assert entries[1]["action"] == "upstream.restore"


@pytest.mark.parametrize("method,path", ENDPOINTS)
def test_every_proxy_route_is_management_only(method, path):
    path = path.format(key_id="member", member_alias="upstream")
    assert local_capability(method, "/api/gateway/providers/relay/admin" + path) == "manage"


def test_proxy_rejects_unknown_routes_and_disabled_connections():
    app = FastAPI()
    app.include_router(proxy_router)
    client = TestClient(app)
    assert client.get("/api/gateway/providers/missing/admin/keys").status_code == 404
    assert client.get("/api/gateway/providers/missing/admin/raw").status_code == 404
    assert local_capability("GET", "/api/gateway/providers/missing/admin/raw") is None
    assert local_capability("GET", "/api/gateway/audit") == "manage"


def test_live_sends_events_and_ends_after_revocation(admin, monkeypatch):
    client, actor, token = admin
    endpoint = next(route.endpoint for route in client.app.routes if route.path == "/gateway/v1/admin/live")
    read_config = gateway_keys.read_config
    reads = []

    def read_off_event_loop():
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        reads.append(True)
        return read_config()

    monkeypatch.setattr(gateway_keys, "read_config", read_off_event_loop)

    class Request:
        headers = {"authorization": f"Bearer {token}"}

        async def is_disconnected(self):
            return False

    async def exercise():
        response = await endpoint(Request(), actor)
        stream = response.body_iterator
        assert "connected" in await anext(stream)
        gateway_live.notify({"task_id": "safe", "status": "running"})
        event = await anext(stream)
        assert json.loads(event.split("data: ")[1])["task_id"] == "safe"
        gateway_keys.revoke_key(actor.id)
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
    asyncio.run(exercise())
    assert not gateway_live.listeners
    assert len(reads) == 3  # Before waiting, before emitting, and after revocation.


def test_gateway_startup_reads_config_off_event_loop(monkeypatch):
    from viewer_server import server_app
    read_config = gateway_keys.read_config
    reads = []

    def read_off_event_loop():
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        reads.append(True)
        return read_config()

    monkeypatch.setattr(gateway_keys, "read_config", read_off_event_loop)
    monkeypatch.setattr(server_app.gateway_server, "apply", lambda config: None)
    with TestClient(server_app.build_app()):
        assert reads


def test_remote_reorder_preserves_nested_gateway_positions(admin):
    client, _, _ = admin
    for alias, provider in (("A", "openai"), ("Hub", "atelier"), ("B", "openai")):
        keys.add_key(keys.KeySpec(alias=alias, provider=provider, access_key="test-only",
            modalities=["image"], base_url="http://127.0.0.1:59999" if provider == "atelier" else None,
            models=[keys.ModelSpec(id="gpt-image-2", name="图片", modality="image")], created_at="test"))
    model_routes.set_route_order("image", "gpt-image-2", ["A", "Hub", "B"])
    result = client.put("/gateway/v1/admin/routes/order", json={"modality": "image", "id": "gpt-image-2", "aliases": ["B", "A"]})
    assert result.status_code == 200
    assert [m.alias for m in model_routes.find_route("image", "gpt-image-2").members] == ["B", "Hub", "A"]


@pytest.mark.parametrize("method,suffix", [
    ("GET", "/state"), ("GET", "/result?id=anything"),
    ("POST", "/check"), ("POST", "/apply"), ("POST", "/cancel"),
])
@pytest.mark.parametrize("prefix", ["/api/update", "/gateway/v1/update", "/gateway/v1/admin/update"])
def test_remote_admin_cannot_reach_local_update_endpoints(admin, method, suffix, prefix):
    client, _, _ = admin
    response = client.request(method, prefix + suffix, json={})
    assert response.status_code == 404


@pytest.mark.parametrize("path", ["/gateway/v1/tasks", "/gateway/v1/openai/chat/completions",
                                  "/gateway/v1/openai/responses"])
def test_gateway_maintenance_blocks_new_work_but_preserves_health_and_admin(admin, path):
    from viewer_server.update_routes import admission
    client, _, _ = admin
    gate = admission()
    with gate.lock:
        gate.maintenance = True
    try:
        response = client.post(path, json={})
        assert response.status_code == 503
        assert "正在更新" in response.text
        assert client.get("/gateway/v1/health").status_code == 200
        assert client.get("/gateway/v1/admin/keys").status_code == 200
        assert gate.requests == 0
    finally:
        with gate.lock:
            gate.maintenance = False
