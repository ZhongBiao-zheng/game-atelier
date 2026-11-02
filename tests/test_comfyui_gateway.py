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


def submit(client, workflow, *, prompt="cat", params=None, files=None):
    response = client.post("/gateway/v1/tasks", headers={"Idempotency-Key": "test"},
                           data={"request": json.dumps({"kind": "image", "model": workflow.id,
                                 "prompt": prompt, "n": 1, "params": params or {}})}, files=files)
    assert response.status_code == 202, response.text
    return gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, response.json()["task_id"]))


def test_values_ordered_images_mask_and_task_prefix(client, host):
    from character_workflow.lib import comfyui_workflows as workflows
    from character_workflow.lib.comfyui_schema import WorkflowInput

    workflow = imported("inpaint")
    graph = workflow.api_workflow
    graph["12"] = {"class_type": "LoadImage", "inputs": {"image": "second.png"}}
    inputs = [*workflow.inputs, WorkflowInput(id="second", label="第二张", type="image",
               node_id="12", class_type="LoadImage", field="image", required=True)]
    workflow = workflows.save_workflow("local", name=workflow.name, api_workflow=graph,
                                       inputs=inputs, identifier=workflow.id)
    strength = next(i for i in inputs if i.type == "float")
    task = submit(client, workflow, params={"workflow_inputs": {strength.id: 0.25}}, files=[
        ("ref_1", ("second.png", b"second-image")), ("mask", ("mask.png", b"mask-data")),
        ("ref_0", ("first.png", b"first-image")),
    ])
    assert task.status == "done", task.error
    graph = host.prompts["prompt-1"]["prompt"]
    assert graph["10"]["inputs"]["image"] == "uploaded-1.png"
    assert graph["12"]["inputs"]["image"] == "uploaded-2.png"
    assert graph["11"]["inputs"]["image"] == "uploaded-3.png"
    assert b"first-image" in host.uploads[0] and b"second-image" in host.uploads[1]
    assert b"mask-data" in host.uploads[2]
    assert graph["2"]["inputs"]["strength_model"] == 0.25
    assert graph["9"]["inputs"]["filename_prefix"] == f"atelier/{task.task_id}"


def test_old_member_uses_defaults(client, host):
    workflow = imported()
    task = submit(client, workflow)
    assert task.status == "done", task.error
    assert host.prompts["prompt-1"]["prompt"]["2"]["inputs"]["strength_model"] == 0.8


def test_no_prompt_workflow_and_required_image(client, host):
    workflow = imported("upscale")
    task = submit(client, workflow, prompt="", files={"ref_0": ("ref.png", host.png)})
    assert task.status == "done", task.error


def test_old_member_missing_required_image_fails_clearly(client, host):
    task = submit(client, imported("upscale"), prompt="")
    assert task.status == "failed" and "参考图" in task.error
    assert not host.prompts


@pytest.mark.parametrize("values", [{"api_workflow": "malicious"}, {"image": "/etc/passwd"}])
def test_undeclared_values_cannot_submit_graph_or_paths(client, host, values):
    task = submit(client, imported(), params={"workflow_inputs": values})
    assert task.status == "failed" and "未声明" in task.error
    assert not host.prompts


def test_gateway_rejects_raw_workflow(client, host):
    workflow = imported()
    response = client.post("/gateway/v1/tasks", headers={"Idempotency-Key": "test"}, data={
        "request": json.dumps({"model": workflow.id, "prompt": "cat", "params": {
            "api_workflow": workflow.api_workflow}})})
    assert response.status_code == 422 and not host.prompts


def test_offline_is_unavailable(client, host):
    from tests.test_gateway_client import _free_port

    workflow = imported()
    keys.patch_key("local", {"base_url": f"http://127.0.0.1:{_free_port()}"})
    task = submit(client, workflow)
    assert (task.status, task.error_kind, task.error) == (
        "failed", "unavailable", "主机的 ComfyUI 未启动")
    assert not host.prompts


def test_connection_lost_after_submission_is_not_safe_to_retry(client, host, monkeypatch):
    import requests

    workflow = imported()
    real_request = requests.Session.request

    def disconnected(session, method, url, **kwargs):
        if "/history/" in url:
            raise requests.ConnectionError("connection lost")
        return real_request(session, method, url, **kwargs)

    monkeypatch.setattr(requests.Session, "request", disconnected)
    task = submit(client, workflow)
    assert task.status == "failed" and task.error_kind == "unconfirmed"
    assert "未确认" in task.error and len(host.prompts) == 1
