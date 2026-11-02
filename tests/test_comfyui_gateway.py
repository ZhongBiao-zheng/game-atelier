"""ComfyUI 经网关暴露与执行：真实 HTTP 假服务，不调用外部厂商。"""
import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import atelier_gateway
from tests.test_comfyui import host, imported  # noqa: F401 — 共用隔离假 ComfyUI fixture
from viewer_server.gateway_app import create_gateway_app


@pytest.fixture
def client(host, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    model_routes._cooldowns.clear()
    record, token = gateway_keys.create_key("成员", None)
    client = TestClient(create_gateway_app())
    client.headers["Authorization"] = f"Bearer {token}"
    client.record = record
    yield client
    model_routes._cooldowns.clear()


def test_catalog_snapshot_and_permissions(client, monkeypatch):
    workflow = imported()
    routes = client.get("/gateway/v1/models").json()["models"]
    assert routes[0]["workflow_inputs"] == [item.model_dump() for item in workflow.inputs]
    assert "api_workflow" not in json.dumps(routes)
    assert client.get("/gateway/v1/info").json()["protocol"] == 2
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key="test-only",
                              base_url="http://127.0.0.1:5180", created_at="test"))
    monkeypatch.setattr(atelier_gateway, "check_gateway", lambda *args: {"models": routes})
    atelier_gateway.sync_gateway_key("Hub")
    assert keys.find_by_alias("Hub").models[0].workflow_inputs == workflow.inputs
    gateway_keys.update_key(client.record.id, allowed_aliases=["other"])
    assert client.get("/gateway/v1/models").json()["models"] == []


def test_empty_declarations_survive_snapshot():
    model = atelier_gateway.gateway_models([{
        "id": "comfyui-empty", "name": "无参数", "modality": "image", "workflow_inputs": [],
        "members": [{"alias": "local", "provider": "comfyui", "model_id": "comfyui-empty",
                     "name": "无参数"}],
    }])[0]
    assert model.model_dump()["workflow_inputs"] == []
