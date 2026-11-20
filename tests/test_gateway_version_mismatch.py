"""第 7 批：主机与成员版本不一致时的行为。

- 旧版成员「使用」网关（连接、出图、看额度）不受影响：新主机的 /me 仍回旧形状的 limits。
- 远程管理（成员管理员经本机代理管主机）要求两边同版本：本机代理带版本请求头；新主机对不带的请求
  回一个旧版能照常显示的错误，而不是旧版解析不了的 scope / quota。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, keys
from character_workflow.lib.callers import atelier_gateway
from viewer_server import gateway_routes
from viewer_server.gateway_admin_proxy import router as proxy_router
from viewer_server.gateway_app import create_gateway_app

HOST = "http://192.0.2.10:5180"
OLD_LIMIT_FIELDS = {"period", "cap_cny", "used_cny", "reserved_cny", "left_cny", "resets_at"}


class _Relay:
    """把本机发往主机的 requests 调用转给同进程里的主机应用；old=True 模拟旧版本机代理（不带版本头）。"""

    def __init__(self, host: TestClient, old: bool = False):
        self.host, self.old = host, old

    def request(self, method, url, params=None, data=None, headers=None, **_kwargs):
        headers = dict(headers or {})
        if self.old:
            headers.pop(atelier_gateway.ADMIN_API_HEADER, None)
        return self.host.request(method, url.removeprefix(HOST), params=params, content=data, headers=headers)

    def get(self, url, headers=None, **_kwargs):
        return self.request("GET", url, headers=headers)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


@pytest.fixture
def member(isolated_data_root, monkeypatch):
    """同一隔离目录里既是主机（网关密钥）也是成员（Remote Atelier 供应商指向主机）。"""
    gateway_routes._me_cache.clear()
    gateway_keys.update_settings(enabled=True)
    _admin, token = gateway_keys.create_key("管理员", role="admin")
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key=token, base_url=HOST,
                              created_at="test", models=[]))
    host = TestClient(create_gateway_app())
    app = FastAPI()
    app.include_router(proxy_router)
    app.include_router(gateway_routes.gateway_router)

    def connect(old=False):
        monkeypatch.setattr(atelier_gateway, "_session", lambda: _Relay(host, old))
        return TestClient(app)
    yield connect
    gateway_routes._me_cache.clear()


def test_same_version_remote_admin_reads_and_writes_the_new_shapes(member):
    client = member()
    listed = client.get("/api/gateway/providers/Hub/admin/keys")
    assert listed.status_code == 200 and listed.json()["keys"][0]["scope"] is None
    created = client.post("/api/gateway/providers/Hub/admin/keys", json={
        "name": "小王", "quota": {"cap_cny": 5, "period": "week"}})
    assert created.status_code == 201 and created.json()["key"]["quota"]["period"] == "week"
    assert "providers" in client.get("/api/gateway/providers/Hub/admin/options").json()


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/keys"), ("POST", "/keys"), ("PATCH", "/keys/x"), ("POST", "/keys/x/reset"),
    ("POST", "/keys/x/revoke"), ("GET", "/options"),
])
def test_old_remote_admin_gets_an_error_it_can_show_instead_of_new_shapes(member, method, path):
    client = member(old=True)
    response = client.request(method, "/api/gateway/providers/Hub/admin" + path, json={"name": "小王"})
    assert response.status_code == 426
    assert "同一版本" in response.json()["detail"]  # 旧版设置页把 detail 原样显示成报错


def test_old_remote_admin_keeps_endpoints_whose_shape_did_not_change(member):
    client = member(old=True)
    assert client.get("/api/gateway/providers/Hub/admin/usage").status_code == 200
    assert client.get("/api/gateway/providers/Hub/admin/tasks").status_code == 200


def test_unauthenticated_request_is_still_401_before_the_version_check(isolated_data_root):
    response = TestClient(create_gateway_app()).get("/gateway/v1/admin/keys")
    assert response.status_code == 401


@pytest.mark.parametrize("quota", [{"cap_cny": 5, "period": "day"}, {"cap_cny": 5, "period": "none"}, None])
def test_old_member_reads_quota_from_a_new_host(member, quota):
    """成员端读额度的代理在第 7 批前后没变：它只认 `limits` 列表。新主机得回它认得的形状。"""
    _record, token = gateway_keys.create_key("小王", quota)
    keys.patch_key("Hub", {"access_key": token})
    body = member().get("/api/gateway/providers/Hub/me").json()
    assert body is not None and isinstance(body["limits"], list)
    for item in body["limits"]:  # 旧版 web/src/api/gateway.ts 的 LimitStatus
        assert set(item) == OLD_LIMIT_FIELDS and item["period"] in {"day", "week", "month"}
        assert isinstance(item["resets_at"], str)
    assert [item["period"] for item in body["limits"]] == (["day"] if quota and quota["period"] == "day" else [])
