import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import keys
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app())


def _make_payload(alias: str = "lov") -> dict:
    return {
        "alias": alias, "provider": "lovart",
        "access_key": "ak", "secret_key": "sk",
        "capabilities": ["portrait"], "models": ["gpt_image_2"],
        "notes": "test", "created_at": "2026-05-22T00:00:00+08:00",
    }


def test_list_keys_returns_empty_initially(client):
    resp = client.get("/api/keys")
    assert resp.status_code == 200
    assert resp.json() == {"keys": [], "default_alias": None}


def test_create_then_list_masks_secrets(client):
    r1 = client.post("/api/keys", json=_make_payload())
    assert r1.status_code == 201, r1.text
    # POST response MUST include the raw secret_revealed exactly once.
    post_body = r1.json()
    assert "secret_revealed" in post_body
    assert post_body["secret_revealed"] == "ak"
    body = client.get("/api/keys").json()
    assert len(body["keys"]) == 1
    k = body["keys"][0]
    assert k["alias"] == "lov"
    assert k["access_key"] != "ak"
    assert k["secret_key"] is None
    # GET response must NEVER leak the raw secret.
    for row in body["keys"]:
        assert "secret_revealed" not in row


def test_create_duplicate_alias_409(client):
    client.post("/api/keys", json=_make_payload())
    r = client.post("/api/keys", json=_make_payload())
    assert r.status_code == 409


def test_patch_key_updates_notes(client):
    client.post("/api/keys", json=_make_payload())
    r = client.patch("/api/keys/lov", json={"notes": "updated"})
    assert r.status_code == 200
    found = next(k for k in client.get("/api/keys").json()["keys"] if k["alias"] == "lov")
    assert found["notes"] == "updated"


def test_patch_preserves_secret_when_not_provided(client):
    client.post("/api/keys", json=_make_payload())
    client.patch("/api/keys/lov", json={"notes": "x"})
    k = keys.find_by_alias("lov")
    assert k.access_key == "ak"
    assert k.secret_key == "sk"


def test_patch_missing_alias_404(client):
    r = client.patch("/api/keys/missing", json={"notes": "x"})
    assert r.status_code == 404


def test_delete_key(client):
    client.post("/api/keys", json=_make_payload())
    r = client.delete("/api/keys/lov")
    assert r.status_code == 204
    assert client.get("/api/keys").json()["keys"] == []


def test_set_default(client):
    client.post("/api/keys", json=_make_payload())
    r = client.post("/api/keys/lov/default")
    assert r.status_code == 200
    assert client.get("/api/keys").json()["default_alias"] == "lov"


def test_set_default_nonexistent_404(client):
    r = client.post("/api/keys/missing/default")
    assert r.status_code == 404
