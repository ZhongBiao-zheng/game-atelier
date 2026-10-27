"""Owner-only token reveal and one-time reissue of historical gateway credentials."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_audit, gateway_keys
from character_workflow.lib.private_json import read_private_json, write_private_json
from tests.local_client import LocalTestClient
from viewer_server.connection_capabilities import local_capability
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app


def legacy_config():
    active, old_token = gateway_keys.create_key(
        "设计师", role="admin", limits=[gateway_keys.GatewayLimit(period="month", cap_cny=25)],
        allowed_models=["gpt-image-2"], allowed_aliases=["upstream"],
    )
    revoked, revoked_token = gateway_keys.create_key("已撤销")
    gateway_keys.revoke_key(revoked.id)
    raw = read_private_json(gateway_keys.gateway_file())
    for key in raw["keys"]:
        key.pop("token")
    write_private_json(gateway_keys.gateway_file(), raw)
    return active, old_token, revoked, revoked_token


def test_legacy_active_key_reissued_once_preserving_identity_and_permissions():
    active, old_token, revoked, revoked_token = legacy_config()
    config = gateway_keys.read_config()
    current = config.keys[0]
    assert current.token and current.token != old_token
    assert current.token_sha256 == gateway_keys.digest(current.token)
    assert current.model_dump(exclude={"token", "token_sha256"}) == active.model_dump(
        exclude={"token", "token_sha256"})
    stored = gateway_keys.gateway_file().read_bytes()
    assert gateway_keys.read_config().keys[0].token == current.token
    assert gateway_keys.gateway_file().read_bytes() == stored
    assert gateway_keys.authenticate(old_token) is None
    assert gateway_keys.authenticate(current.token).id == active.id
    assert config.keys[1].token == ""
    assert config.keys[1].token_sha256 == revoked.token_sha256
    assert gateway_keys.authenticate(revoked_token) is None
    if os.name != "nt":
        assert gateway_keys.gateway_file().stat().st_mode & 0o777 == 0o600


def test_concurrent_reads_share_the_same_reissued_token():
    legacy_config()
    with ThreadPoolExecutor(max_workers=8) as executor:
        tokens = list(executor.map(lambda _: gateway_keys.read_config().keys[0].token, range(16)))
    assert len(set(tokens)) == 1
    assert gateway_keys.authenticate(tokens[0]) is not None


def test_reissue_and_updates_hold_one_lock_without_nested_acquisition(monkeypatch):
    active, _, _, _ = legacy_config()
    original_lock, original_write = gateway_keys._lock, gateway_keys._write
    held = False

    @contextmanager
    def checked_lock():
        nonlocal held
        assert not held
        with original_lock():
            held = True
            try:
                yield
            finally:
                held = False

    def checked_write(config):
        assert held
        original_write(config)

    monkeypatch.setattr(gateway_keys, "_lock", checked_lock)
    monkeypatch.setattr(gateway_keys, "_write", checked_write)
    gateway_keys.update_key(active.id, name="新名字")
    gateway_keys.update_settings(name="网关")
    gateway_keys.create_key("新成员")
    gateway_keys.read_config()
    gateway_keys.revoke_key(active.id)


def test_reveal_is_local_management_only_and_general_views_hide_secrets():
    app = build_app()
    local = LocalTestClient(app, base_url="http://127.0.0.1")
    record, token = gateway_keys.create_key("成员")
    path = f"/api/gateway/keys/{record.id}/token"
    assert local_capability("GET", path) == "manage"
    anonymous = TestClient(app, base_url="http://127.0.0.1")
    assert anonymous.get(path).status_code == 401
    assert anonymous.get(path, headers={"Authorization": f"Bearer {token}"}).status_code == 401
    response = local.get(path)
    assert response.json() == {"token": token}
    assert response.headers["cache-control"] == "no-store"
    for response in (local.get("/api/gateway"), local.patch(
        f"/api/gateway/keys/{record.id}", json={"name": "改名"})):
        assert token not in response.text and record.token_sha256 not in response.text
        assert '"token"' not in response.text
    assert token not in gateway_audit.audit_file().read_text()
    assert local.get("/api/gateway/keys/missing/token").status_code == 404
    gateway_keys.revoke_key(record.id)
    assert local.get(path).status_code == 404
    with pytest.raises(gateway_keys.NoSuchGatewayKeyError):
        gateway_keys.reveal_token(record.id)


def test_remote_admin_and_proxy_do_not_offer_token_reveal():
    _, admin_token = gateway_keys.create_key("管理员", role="admin")
    member, token = gateway_keys.create_key("成员")
    remote = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {admin_token}"})
    assert remote.get(f"/gateway/v1/admin/keys/{member.id}/token").status_code == 404
    assert remote.get(f"/api/gateway/keys/{member.id}/token").status_code == 404
    assert token not in remote.get("/gateway/v1/admin/keys").text
    proxy_path = f"/api/gateway/providers/hub/admin/keys/{member.id}/token"
    assert local_capability("GET", proxy_path) is None
    local = LocalTestClient(build_app(), base_url="http://127.0.0.1")
    assert local.get(proxy_path).status_code == 403
