"""网站配对：本机页面签发一次性配对码，网站换取 bearer 会话与只读媒体令牌。"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from viewer_server.connection_auth import (
    COOKIE_NAME, ConnectionError, ConnectionStore, validate_site_origin,
)
from viewer_server.server_app import build_app

ORIGIN = "http://127.0.0.1:5174"
LOCAL_HEADERS = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}
SITE = "https://atelier.example"
SITE_HEADERS = {"Origin": SITE, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"}
IMG_HEADERS = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image"}


@pytest.fixture
def app(tmp_path):
    return build_app(dist_dir=tmp_path)


@pytest.fixture
def local(app):
    client = TestClient(app, base_url=ORIGIN)
    client.headers.update(LOCAL_HEADERS)
    assert client.post("/api/connection/local-session", json={}).status_code == 200
    return client


@pytest.fixture
def site(app):
    """网站客户端：不带本机 cookie，只带跨源 Origin 与 Fetch Metadata。"""
    client = TestClient(app, base_url=ORIGIN)
    client.headers.update(SITE_HEADERS)
    return client


def create_code(local, origin=SITE):
    response = local.post("/api/connection/pairings", json={"origin": origin})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["origin"] == origin and len(body["pairing_code"]) >= 24
    return body


def pair(local, site, origin=SITE):
    code = create_code(local, origin)
    response = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["capabilities"] == ["edit", "read"]
    site.headers["Authorization"] = f"Bearer {body['session_token']}"
    return body


@pytest.mark.parametrize("origin", [
    "https://atelier.example", "https://atelier.example:8443", "http://localhost:4173",
    "http://127.0.0.1:4173",
])
def test_exact_site_origins_are_accepted(origin):
    assert validate_site_origin(origin) == origin


@pytest.mark.parametrize("origin", [
    "null", "file://", "http://atelier.example", "https://atelier.example/", "https://atelier.example/app",
    "https://user:pw@atelier.example", "https://*.vercel.app", "https://Atelier.example",
    "https://atelier.example:443", "http://localhost", "https://atelier.example?x=1", "ws://x",
])
def test_loose_site_origins_are_rejected(origin):
    with pytest.raises(ConnectionError) as error:
        validate_site_origin(origin)
    assert error.value.status == 422


def test_pairing_requires_local_management_session(app, local):
    anonymous = TestClient(app, base_url=ORIGIN)
    assert anonymous.post("/api/connection/pairings", json={"origin": SITE},
                          headers=LOCAL_HEADERS).status_code == 401
    assert local.post("/api/connection/pairings", json={"origin": "http://evil.example"}).status_code == 422
    create_code(local)


def test_unregistered_site_stays_blocked_and_registered_site_gets_exact_cors(local, site):
    assert site.get("/api/connection/status").status_code == 403
    assert site.options("/api/connection/status", headers={
        "Access-Control-Request-Method": "GET",
    }).status_code == 403
    create_code(local)
    preflight = site.options("/api/connection/pair", headers={
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
    })
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == SITE
    assert "Authorization" in preflight.headers["access-control-allow-headers"]
    assert preflight.headers["access-control-allow-private-network"] == "true"
    assert preflight.headers["vary"] == "Origin"
    status = site.get("/api/connection/status")
    assert status.status_code == 200
    assert status.headers["access-control-allow-origin"] == SITE
    assert status.json()["protocol"] == "atelier-local/2"
    other = TestClient(local.app, base_url=ORIGIN)
    response = other.get("/api/connection/status", headers={**SITE_HEADERS, "Origin": "https://other.example"})
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_pair_consumes_code_once_and_binds_origin_and_instance(local, site):
    code = create_code(local)
    wrong_instance = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": "f" * 32,
    })
    assert wrong_instance.status_code == 409
    bogus = site.post("/api/connection/pair", json={
        "pairing_code": "x" * 32, "instance_id": code["instance_id"],
    })
    assert bogus.status_code == 403 and bogus.json()["error"]["code"] == "SESSION_REVOKED"
    assert bogus.headers["access-control-allow-origin"] == SITE
    # 另一个已登记来源拿着这枚码也换不到会话。
    create_code(local, "https://second.example")
    stolen = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    }, headers={"Origin": "https://second.example"})
    assert stolen.status_code == 403
    ok = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    })
    assert ok.status_code == 200
    assert "set-cookie" not in ok.headers
    again = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    })
    assert again.status_code == 403


def test_pairing_code_expires(local, site, monkeypatch):
    code = create_code(local)
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 6 * 60)
    assert site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    }).status_code == 403
    # 待配对来源随码一起失效，跨源请求回到 403。
    assert site.get("/api/connection/status").status_code == 403


def test_pair_attempts_are_rate_limited(local, site):
    code = create_code(local)
    for _ in range(30):
        site.post("/api/connection/pair", json={"pairing_code": "y" * 32, "instance_id": code["instance_id"]})
    limited = site.post("/api/connection/pair", json={
        "pairing_code": code["pairing_code"], "instance_id": code["instance_id"],
    })
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"


def test_site_session_edits_with_lease_and_never_manages(local, site):
    pair(local, site)
    assert site.get("/api/projects").status_code == 200
    assert site.get("/api/projects").headers["access-control-allow-origin"] == SITE
    # 写入先要编辑租约，且带页面 client id。
    site.headers["X-Atelier-Client"] = "site-tab"
    assert site.post("/api/projects", json={"name": "网站项目"}).status_code == 409
    assert site.post("/api/connection/editor-lease", json={"client_id": "site-tab"}).status_code == 200
    assert site.post("/api/projects", json={"name": "网站项目"}).status_code == 200
    keys = site.get("/api/keys")
    assert keys.status_code == 200 and "secret_key" not in str(keys.json().get("keys"))
    for method, path in [
        ("GET", "/api/config"), ("POST", "/api/keys"), ("GET", "/api/keys/x/reveal"),
        ("POST", "/api/keys/models-preview"), ("POST", "/api/onboarding/data-root"),
        ("GET", "/api/onboarding/status"), ("POST", "/api/folder-picker"),
        ("POST", "/api/connection/pairings"), ("GET", "/api/connection/agent-grants"),
        ("POST", "/api/connection/agent-grants"), ("GET", "/api/connection/sessions"),
        ("POST", "/api/connection/local-session"), ("POST", "/api/workshop/requests/r1/approve"),
        ("POST", "/api/workshop/list-projects"),
    ]:
        response = site.request(method, path, json={} if method == "POST" else None)
        assert response.status_code == 403, (method, path, response.text)
        assert response.json()["error"]["code"] in {"CAPABILITY_DENIED", "ORIGIN_DENIED"}, (method, path)
    assert site.get("/api/connection/sessions").json()["error"]["message"] == "此操作只能在本机页面进行"


def test_site_token_cannot_be_replayed_as_agent_or_from_another_origin(local, site, app):
    pair(local, site)
    token = site.headers["Authorization"]
    native = TestClient(app, base_url=ORIGIN)
    # 没有 Origin 的 bearer 走 Agent 入口；网站会话在那里是错误身份，不是匿名。
    assert native.get("/api/projects", headers={"Authorization": token}).status_code == 403
    assert native.get("/api/projects", headers={
        "Authorization": token, **SITE_HEADERS, "Origin": "https://other.example",
    }).status_code == 403
    # 本机 cookie 不能被网站来源借用。
    cookie = local.cookies.get(COOKIE_NAME)
    assert native.get("/api/projects", headers={**SITE_HEADERS, "Cookie": f"{COOKIE_NAME}={cookie}"}).status_code == 403


def test_media_token_only_opens_media_routes_and_dies_with_the_session(local, site, app):
    pair(local, site)
    issued = site.post("/api/connection/media-token", json={})
    assert issued.status_code == 200
    token = issued.json()["media_token"]
    browser = TestClient(app, base_url=ORIGIN)
    browser.headers.update(IMG_HEADERS)
    # 令牌鉴权通过后到达媒体白名单（404），不是连接拒绝。
    assert browser.get("/api/raw", params={"path": "missing.png", "media_token": token}).status_code == 404
    # 图库路由自己校验 path（400），说明请求已越过连接层。
    assert browser.get("/api/gallery/image", params={"path": "missing.png", "media_token": token}).status_code == 400
    assert browser.get("/api/raw", params={"path": "missing.png", "media_token": "z" * 43}).status_code == 401
    assert browser.get("/api/raw", params={"path": "missing.png"}).status_code == 403
    assert browser.get("/api/raw", params=[("path", "a"), ("media_token", token), ("media_token", token)]).status_code == 403
    # 非媒体路由带令牌：边界层就按未登记跨源拒绝，令牌根本不参与鉴权。
    denied = browser.get("/api/projects", params={"media_token": token})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "ORIGIN_DENIED"
    assert browser.get("/api/connection/agent-grants", params={"media_token": token}).status_code == 403
    mixed = site.get("/api/raw", params={"path": "missing.png", "media_token": token})
    assert mixed.status_code == 403
    assert local.post("/api/connection/media-token", json={}).status_code == 403
    session_id = site.headers["Authorization"] and [
        s for s in local.get("/api/connection/sessions").json()["sessions"] if s["kind"] == "site"
    ][0]
    assert session_id["origin"] == SITE and session_id["capabilities"] == ["edit", "read"]
    assert local.delete(f"/api/connection/sessions/{session_id['session_id']}",
                        headers={"Content-Type": "application/json"}).status_code == 204
    assert browser.get("/api/raw", params={"path": "missing.png", "media_token": token}).status_code == 401
    assert site.get("/api/projects").status_code == 403


def test_media_tokens_per_session_are_bounded():
    store = ConnectionStore("a" * 32)
    code, _ = store.create_pairing(SITE)
    session, _ = store.pair(code, "a" * 32, SITE)
    tokens = [store.issue_media_token(session)[0] for _ in range(6)]
    assert len(store.media_tokens) == 4
    for stale in tokens[:2]:
        with pytest.raises(ConnectionError):
            store.authenticate_media(stale)
    assert store.authenticate_media(tokens[-1]) is session


def test_site_can_revoke_only_itself(local, site, app):
    pair(local, site)
    own = [s for s in local.get("/api/connection/sessions").json()["sessions"] if s["kind"] == "site"][0]
    local_session = [s for s in local.get("/api/connection/sessions").json()["sessions"] if s["kind"] == "local"][0]
    json_headers = {"Content-Type": "application/json"}
    assert site.delete(f"/api/connection/sessions/{local_session['session_id']}", headers=json_headers).status_code == 403
    assert site.delete(f"/api/connection/sessions/{own['session_id']}", headers=json_headers).status_code == 204
    # 撤销后来源本身也不再登记：连接层直接 403，不再进入身份判断。
    assert site.get("/api/projects").status_code == 403
    # 会话消失后来源不再登记，连预检都不再放行。
    assert site.options("/api/projects", headers={"Access-Control-Request-Method": "GET"}).status_code == 403


def test_pairing_and_media_endpoints_are_registered_control_routes(app):
    from viewer_server.connection_middleware import _CONTROL_ROUTES
    assert {("POST", "/api/connection/pairings"), ("POST", "/api/connection/pair"),
            ("POST", "/api/connection/media-token")} <= _CONTROL_ROUTES
