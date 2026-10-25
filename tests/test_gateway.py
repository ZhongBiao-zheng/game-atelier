"""局域网网关（ADR-0025）：网关密钥、网关接口边界、网关任务的失败切换 / 限额 / 记录 / 清理。"""
from __future__ import annotations

import json
import struct
import zlib
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import callers, gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib import openai_hk_prices
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.callers.openai_image import OpenAIImageError
from viewer_server.gateway_app import create_gateway_app


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    model_routes._cooldowns.clear()
    # 测试里同步调用 run_task，不起后台线程。
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    yield
    model_routes._cooldowns.clear()


def _png(path: Path) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(
            ">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * 2 for _ in range(2))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _seed_keys() -> None:
    atomic_write_json(openai_hk_prices.snapshot_path(), {"models": {
        "gpt-image-2": {"quota_type": 1, "model_price": 0.08, "enable_groups": ["default"]},
    }})
    for alias, provider in (("A", "openai"), ("B", "openai"), ("Hub", "atelier")):
        keys.add_key(keys.KeySpec(
            alias=alias, provider=provider, access_key="test-only", modalities=["image"],
            base_url="http://192.0.2.1:5180" if provider == "atelier" else "https://api.openai-hk.com",
            models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")],
            created_at="test"))
    keys.set_default_alias("Hub")


def _dispatch(calls: list[dict], fail: dict[str, BaseException] | None = None):
    def fake(*, alias, output_dir, params, **_kwargs):
        calls.append({"alias": alias, "params": dict(params)})
        if fail and alias in fail:
            raise fail[alias]
        out = Path(output_dir) / "v1.png"
        _png(out)
        return [str(out)]
    return fake


@pytest.fixture
def client(isolated_data_root):
    _seed_keys()
    record, token = gateway_keys.create_key("小王", limits=[{"period": "day", "cap_cny": 0.24}])
    test_client = TestClient(create_gateway_app())
    test_client.headers["Authorization"] = f"Bearer {token}"
    test_client.record = record  # type: ignore[attr-defined]
    return test_client


def _submit(client, *, key="k1", params=None, n=1, model="gpt-image-2", files=None):
    body = {"kind": "image", "model": model, "prompt": "一只猫", "n": n, "params": params or {}}
    return client.post("/gateway/v1/tasks", data={"request": json.dumps(body)},
                       files=files or {}, headers={"Idempotency-Key": key})


# ---- 网关密钥 ----

def test_key_plaintext_is_shown_once_and_revocation_is_immediate(isolated_data_root):
    record, token = gateway_keys.create_key("小王", None)
    stored = gateway_keys.gateway_file().read_text()
    assert token.startswith("atg_") and token not in stored and record.token_sha256 in stored
    assert gateway_keys.authenticate(token).id == record.id
    gateway_keys.revoke_key(record.id)
    assert gateway_keys.authenticate(token) is None


# ---- 接口边界 ----

def test_gateway_app_only_serves_gateway_routes_with_a_key(client):
    assert client.get("/api/jobs").status_code == 404
    assert client.get("/").status_code == 404
    anonymous = TestClient(create_gateway_app())
    assert anonymous.get("/gateway/v1/info").status_code == 401
    wrong = anonymous.get("/gateway/v1/info", headers={"Authorization": "Bearer atg_nope"})
    assert wrong.status_code == 401
    info = client.get("/gateway/v1/info").json()
    assert info["protocol"] == 2 and info["version"]


def test_models_hide_other_gateways_and_never_include_secrets(client):
    models = client.get("/gateway/v1/models").json()["models"]
    assert [m["id"] for m in models] == ["gpt-image-2"]
    assert [m["alias"] for m in models[0]["members"]] == ["A", "B"]
    assert "test-only" not in json.dumps(models)


@pytest.mark.parametrize("params", [
    {"reference_images": ["/etc/passwd"]}, {"mask_image": "/tmp/x.png"}, {"mj_sref": ["/x"]},
    {"image_edit": {}},
])
def test_path_like_params_are_rejected(client, params):
    response = _submit(client, params=params)
    assert response.status_code == 422


def test_unknown_model_is_404_and_missing_idempotency_key_is_422(client):
    assert _submit(client, model="nope").status_code == 404
    body = {"model": "gpt-image-2", "prompt": "x", "n": 1}
    assert client.post("/gateway/v1/tasks", data={"request": json.dumps(body)}).status_code == 422


def test_same_idempotency_key_returns_the_same_task(client):
    first = _submit(client, key="job-1:0").json()["task_id"]
    assert _submit(client, key="job-1:0").json()["task_id"] == first
    assert _submit(client, key="job-1:1").json()["task_id"] != first


def test_money_limit_returns_429(client):
    gateway_keys.update_key(client.record.id, limits=[{"period": "day", "cap_cny": 0.12}])
    assert _submit(client, key="a", n=1).status_code == 202
    response = _submit(client, key="b", n=1)
    assert response.status_code == 429 and "中转额度已用完：今日" in response.json()["detail"]
    assert int(response.headers["retry-after"]) > 0


def test_tasks_are_private_to_their_key(client):
    task_id = _submit(client).json()["task_id"]
    _other, token = gateway_keys.create_key("小李", None)
    other = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    assert other.get(f"/gateway/v1/tasks/{task_id}").status_code == 404
    assert client.get(f"/gateway/v1/tasks/{task_id}").status_code == 200


# ---- 执行 ----

def test_task_runs_uploads_references_and_serves_outputs(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(calls))
    task_id = _submit(client, files={"ref_0": ("ref.png", b"fake-bytes", "image/png")}).json()["task_id"]

    gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))

    refs = calls[0]["params"]["reference_images"]
    assert calls[0]["alias"] == "A" and Path(refs[0]).read_bytes() == b"fake-bytes"
    status = client.get(f"/gateway/v1/tasks/{task_id}").json()
    assert (status["status"], status["member_alias"], status["outputs"]) == ("done", "A", 1)
    image = client.get(f"/gateway/v1/tasks/{task_id}/outputs/0")
    assert image.status_code == 200 and image.content.startswith(b"\x89PNG")
    [row] = gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))
    assert (row["key_name"], row["member_alias"], row["n"], row["status"]) == ("小王", "A", 1, "done")


def test_task_fails_over_inside_the_gateway(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(
        calls, {"A": OpenAIImageError("image api 401: invalid api key")}))
    task_id = _submit(client).json()["task_id"]

    done = gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))

    assert [c["alias"] for c in calls] == ["A", "B"]
    assert (done.status, done.member_alias) == ("done", "B")
    assert done.warnings == ["A密钥无效或没有权限，已改用 B"]


def test_all_members_refused_is_unavailable_so_the_client_can_switch(client, monkeypatch):
    refused = OpenAIImageError("image api 429: rate limited")
    monkeypatch.setattr(callers, "dispatch", _dispatch([], {"A": refused, "B": refused}))
    task_id = _submit(client).json()["task_id"]
    failed = gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))
    assert (failed.status, failed.error_kind) == ("failed", "unavailable")


def test_failure_that_may_have_run_is_not_switched(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(
        calls, {"A": OpenAIImageError("image api 504: gateway timeout")}))
    task_id = _submit(client).json()["task_id"]
    failed = gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, task_id))
    assert [c["alias"] for c in calls] == ["A"]
    assert (failed.status, failed.error_kind) == ("failed", "failed")


def test_cancel_pending_task(client):
    task_id = _submit(client).json()["task_id"]
    assert client.post(f"/gateway/v1/tasks/{task_id}/cancel").json()["status"] == "canceled"


# ---- 重启与清理 ----

def test_restart_marks_pending_as_not_started_and_running_as_unconfirmed(client):
    pending = _submit(client, key="p").json()["task_id"]
    running = _submit(client, key="r").json()["task_id"]
    gateway_tasks._update(running, status="running")

    gateway_tasks.recover_after_restart()

    key_id = client.record.id
    assert gateway_tasks.get_task(key_id, pending).error_kind == "unavailable"
    unconfirmed = gateway_tasks.get_task(key_id, running)
    assert unconfirmed.error_kind == "unconfirmed" and "未确认" in unconfirmed.error


def test_cleanup_removes_tasks_older_than_a_day(client):
    task_id = _submit(client, files={"ref_0": ("r.png", b"x", "image/png")}).json()["task_id"]
    assert gateway_tasks.cleanup() == 0
    assert gateway_tasks.cleanup(gateway_tasks._now() + timedelta(hours=25)) == 1
    assert client.get(f"/gateway/v1/tasks/{task_id}").status_code == 404
    assert not gateway_tasks._files_dir(task_id).exists()


# ---- 本机管理接口 ----

def test_management_api_creates_keys_toggles_and_reports_usage(isolated_data_root, monkeypatch):
    from tests.local_client import LocalTestClient
    from viewer_server import gateway_routes
    from viewer_server.connection_capabilities import local_capability
    from viewer_server.server_app import build_app

    applied: list[bool] = []
    monkeypatch.setattr(gateway_routes.gateway_server, "apply",
                        lambda config: applied.append(config.enabled))
    local = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    created = local.post("/api/gateway/keys", json={"name": "小王", "limits": [{"period": "day", "cap_cny": 50}]})
    assert created.status_code == 201
    token, key_id = created.json()["token"], created.json()["key"]["id"]
    view = local.get("/api/gateway").json()
    assert token not in json.dumps(view)
    assert view["keys"][0] == {**view["keys"][0], "name": "小王", "month_charged_cny": 0}
    assert local.put("/api/gateway", json={"enabled": True}).json()["enabled"] is True
    assert applied == [True]
    assert local.patch(f"/api/gateway/keys/{key_id}",
                       json={"limits": [{"period": "week", "cap_cny": 10}]}).json()["limits"] == [
                           {"period": "week", "cap_cny": 10}]
    assert local.post(f"/api/gateway/keys/{key_id}/revoke").json()["revoked_at"]
    assert local.get("/api/usage?scope=team").json()["totals"]["count"] == 0
    assert local.get("/api/usage?range=bad").status_code == 422
    assert local_capability("PUT", "/api/gateway") == "manage"
    assert local_capability("GET", "/api/usage") == "manage"


def test_gateway_server_starts_and_stops_in_a_thread(isolated_data_root):
    import socket
    import time

    import httpx

    from viewer_server.gateway_app import GatewayServer

    _record, token = gateway_keys.create_key("小王", None)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = GatewayServer(host="127.0.0.1")  # 测试只绑回环
    server.start(port)
    try:
        for _ in range(50):
            try:
                response = httpx.get(f"http://127.0.0.1:{port}/gateway/v1/info",
                                     headers={"Authorization": f"Bearer {token}"}, timeout=1)
                break
            except httpx.TransportError:
                time.sleep(0.1)
        assert response.status_code == 200 and server.status()["running"]
    finally:
        server.stop()
    assert not server.running


def test_round_robin_submit_freezes_once_and_run_and_idempotence_do_not_advance(client, monkeypatch):
    model_routes.set_route_mode("image", "gpt-image-2", "round_robin")
    calls = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(calls))
    first = _submit(client, key="round-one").json()["task_id"]
    assert _submit(client, key="round-one").json()["task_id"] == first
    task = gateway_tasks.get_task(client.record.id, first)
    assert task.member_alias == "A" and task.route_order == ["A", "B"]
    gateway_tasks.run_task(task)
    second = _submit(client, key="round-two").json()["task_id"]
    task = gateway_tasks.get_task(client.record.id, second)
    assert task.member_alias == "B" and task.route_order == ["B", "A"]
    gateway_tasks.run_task(task)
    assert [call["alias"] for call in calls] == ["A", "B"]
