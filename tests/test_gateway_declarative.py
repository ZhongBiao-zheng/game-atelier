"""批次 4：自定义接口模型经局域网网关发布给团队成员（ADR-0036）。"""
import copy
import json

import pytest

from character_workflow.lib import (
    data_root, gateway_keys, gateway_tasks, http_protocols, keys, model_routes,
)
from character_workflow.lib.callers import atelier_gateway, video_poll
from character_workflow.lib.usage_stats import aggregate_usage, team_records
from fastapi.testclient import TestClient

from tests.fake_http_vendor import FakeVendor, png_bytes
from tests.local_client import LocalTestClient
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app

DOC = {
    "version": 1, "name": "同步出图", "kind": "image", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/images/generations",
               "body": {"model": "$model", "prompt": "$prompt", "size": "$size"}},
    "options": {"ratio": ["1:1", "16:9"]},
    "derive": {"size": {"from": "ratio", "map": {"1:1": "1024x1024", "16:9": "1536x1024"}}},
    "result": {"urls": ["data.*.url"]},
}
SECRET = "sk-host-only-0123456789"


@pytest.fixture(autouse=True)
def _sync_runner(monkeypatch):
    model_routes._cooldowns.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    monkeypatch.setattr(video_poll.time, "sleep", lambda _s: None)


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        server.on("GET", "/files/a.png", png_bytes())
        server.on("POST", "/v1/images/generations", {"data": [{"url": server.url + "/files/a.png"}]})
        yield server


def host_setup(vendor) -> tuple[str, str]:
    stored = http_protocols.save_protocol(copy.deepcopy(DOC))
    keys.add_key(keys.KeySpec(
        alias="vendor", provider="custom", base_url=vendor.url, access_key=SECRET,
        models=[keys.ModelSpec(id="m1", name="演示图片", modality="image",
                               protocol="declarative", declarative_id=stored.id)],
        created_at="2026-11-14T00:00:00Z"))
    return stored.id, f"declarative:{stored.id}:m1"


def member_client(*, limits=None) -> tuple[TestClient, object]:
    record, token = gateway_keys.create_key("小王", limits=limits)
    client = TestClient(create_gateway_app())
    client.headers["Authorization"] = f"Bearer {token}"
    return client, record


def submit(client, route_id, params):
    body = {"kind": "image", "model": route_id, "prompt": "一只猫", "n": 1, "params": params}
    return client.post("/gateway/v1/tasks", data={"request": json.dumps(body)},
                       headers={"Idempotency-Key": "k1"})


def test_models_carry_capabilities_but_no_template_or_host_address(vendor):
    _, route_id = host_setup(vendor)
    client, _ = member_client()
    [route] = client.get("/gateway/v1/models").json()["models"]
    assert route["id"] == route_id
    assert route["declared"] == {"kind": "image", "ratios": ["1:1", "16:9"], "resolutions": None,
                                 "durations": None, "max_count": 1, "reference_images": 0,
                                 "frames": 0}
    text = json.dumps(route)
    for leaked in ("/v1/images/generations", "bearer", "derive", SECRET, vendor.url):
        assert leaked not in text
    assert route["members"][0]["base_url"] is None
    assert "declarative_id" not in text


def test_capped_key_cannot_see_or_use_unpriced_routes(vendor):
    _, route_id = host_setup(vendor)
    client, _ = member_client(limits=[{"period": "day", "cap_cny": 5}])
    assert client.get("/gateway/v1/models").json()["models"] == []
    response = submit(client, route_id, {"ratio": "1:1"})
    assert response.status_code == 403
    assert "金额上限" in response.json()["detail"] and "未计价" in response.json()["detail"]
    assert vendor.received == []


def test_broken_template_disappears_from_every_view(vendor):
    identifier, route_id = host_setup(vendor)
    member, _ = member_client()
    local = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    from viewer_server.gateway_admin import route_options

    assert [m["id"] for m in member.get("/gateway/v1/models").json()["models"]] == [route_id]
    assert [(m["id"], m["unpriced"]) for m in local.get("/api/gateway/options").json()["models"]] \
        == [(route_id, True)]
    assert [m["id"] for m in route_options()["models"]] == [route_id]

    (data_root.config_dir() / "http-protocols" / f"{identifier}.json").write_text("{", encoding="utf-8")
    assert member.get("/gateway/v1/models").json()["models"] == []
    assert local.get("/api/gateway/options").json()["models"] == []
    assert route_options()["models"] == []
    assert submit(member, route_id, {"ratio": "1:1"}).status_code == 404


def test_member_task_runs_on_host_and_is_unpriced_on_both_sides(vendor):
    _, route_id = host_setup(vendor)
    client, record = member_client()
    response = submit(client, route_id, {"ratio": "16:9", "size_mode": "ratio"})
    assert response.status_code == 202, response.text
    task_id = response.json()["task_id"]
    gateway_tasks.run_task(gateway_tasks.get_task(record.id, task_id))

    assert vendor.calls("POST")[0].json()["size"] == "1536x1024"
    assert vendor.calls("POST")[0].headers["Authorization"] == f"Bearer {SECRET}"
    status = client.get(f"/gateway/v1/tasks/{task_id}").json()
    assert status["status"] == "done" and status["outputs"] == 1
    assert status["charged_cny"] is None and status["actual_cost_cny"] is None  # 成员侧：未计价
    rows = gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))
    totals = aggregate_usage(team_records(rows, set()), scope="team", period="today",
                             now=gateway_tasks._now().astimezone())["totals"]
    assert totals["unpriced"] == 1 and totals["cost_cny"] == 0  # 主机侧：未计价


def test_host_rejects_parameters_outside_the_current_template(vendor):
    _, route_id = host_setup(vendor)
    client, record = member_client()
    task_id = submit(client, route_id, {"ratio": "4:3"}).json()["task_id"]
    gateway_tasks.run_task(gateway_tasks.get_task(record.id, task_id))
    status = client.get(f"/gateway/v1/tasks/{task_id}").json()
    assert status["status"] == "failed" and "比例 4:3" in status["error"]
    assert vendor.received == []


def test_member_stores_the_snapshot_and_shows_declared_capabilities(vendor):
    _, route_id = host_setup(vendor)
    client, _ = member_client()
    routes = client.get("/gateway/v1/models").json()["models"]
    [model] = atelier_gateway.gateway_models(routes)
    assert model.declared_snapshot["ratios"] == ["1:1", "16:9"]
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", base_url="http://192.0.2.1:5180",
                              access_key="atg_x", models=[model], created_at="test"))
    hub = next(row for row in keys.keys_for_api() if row["alias"] == "Hub")
    declared = hub["models"][0]["declared"]
    assert declared["available"] and declared["ratios"] == ["1:1", "16:9"]
    assert "declarative_id" not in json.dumps(hub)
    # 成员侧画布按快照判断能力（size_channel 带上快照）。
    from character_workflow.lib.canvas_runs import _supports_canvas_image_generation
    stored = keys.find_by_alias("Hub")
    assert _supports_canvas_image_generation(stored, stored.models[0])
