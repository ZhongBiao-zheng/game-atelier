"""Subscription configuration contains references, never Codex credentials."""
import pytest
from pydantic import ValidationError

from character_workflow.lib import keys
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


def test_subscription_add_list_and_route(client):
    response = client.post("/api/keys", json={
        "alias": "subscription", "provider": "chatgpt", "auth_source": "codex-cli",
    })
    assert response.status_code == 201, response.text
    key = keys.find_by_alias("subscription")
    assert key.auth_source == "codex-cli"
    assert key.access_key == ""
    assert key.models[0].name == "GPT Image"
    assert key.models[0].id == "gpt-image-2"
    row = client.get("/api/keys").json()["keys"][0]
    assert row["auth_source"] == "codex-cli"
    assert row["provider"] == "chatgpt"
    from character_workflow.lib import model_routes
    assert any(member.alias == "subscription"
               for route in model_routes.list_routes()
               for member in route.members)


@pytest.mark.parametrize("patch", [
    {"access_key": "must-not-persist"}, {"secret_key": "must-not-persist"},
    {"base_url": "https://example.test"},
    {"models": [{"id": "gpt-image-2.5", "name": "Unproven"}]},
])
def test_subscription_rejects_credentials_and_arbitrary_models(client, patch):
    payload = {"alias": "subscription", "provider": "chatgpt", "auth_source": "codex-cli"}
    assert client.post("/api/keys", json={**payload, **patch}).status_code == 422
    assert client.post("/api/keys", json=payload).status_code == 201
    assert client.patch("/api/keys/subscription", json=patch).status_code == 422
    assert keys.find_by_alias("subscription").access_key == ""


def test_subscription_status_is_local_and_never_cached(client, monkeypatch):
    from character_workflow.lib import chatgpt_auth
    status = {"available": True, "email": "test@example.test", "plan": "plus"}
    monkeypatch.setattr(chatgpt_auth, "get_auth_status", lambda: status)
    response = client.get("/api/subscriptions/chatgpt")
    assert response.status_code == 200
    assert response.json() == status
    assert response.headers["cache-control"] == "no-store"
    from viewer_server.connection_capabilities import local_capability
    assert local_capability("GET", "/api/subscriptions/chatgpt") == "manage"
    from fastapi.testclient import TestClient
    anonymous = TestClient(build_app(), base_url="http://127.0.0.1")
    assert anonymous.get("/api/subscriptions/chatgpt").status_code == 401


def test_other_providers_cannot_reference_codex_login():
    with pytest.raises(ValidationError):
        keys.KeySpec(alias="other", provider="openai", access_key="key",
                     auth_source="codex-cli", created_at="2026-10-27")
