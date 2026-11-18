"""坏落盘文件不拖垮网关：坏任务文件隔离、坏 gateway.json 让网关停在明确的错误状态、坏用量行跳过。"""
from __future__ import annotations

import json
import logging
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_tasks
from tests.test_gateway import _seed_keys, _submit
from viewer_server.gateway_app import create_gateway_app

ORIGIN = "http://127.0.0.1:5174"
_REAL_PUMP = gateway_tasks.pump


@pytest.fixture
def client(isolated_data_root, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    _seed_keys()
    record, token = gateway_keys.create_key("小王", limits=[{"period": "day", "cap_cny": 5}])
    test_client = TestClient(create_gateway_app())
    test_client.headers["Authorization"] = f"Bearer {token}"
    test_client.record = record  # type: ignore[attr-defined]
    return test_client


def _tasks_dir():
    return gateway_tasks._root() / "tasks"


def _quarantined():
    folder = gateway_tasks.quarantine_dir()
    return sorted(path.name for path in folder.iterdir()) if folder.is_dir() else []


_BAD_TASKS = {
    "not-json": b"{\"task_id\": ",
    "empty": b"",
    "not-utf8": b"\xff\xfe\x00garbage",
    "schema": json.dumps({"task_id": "x"}).encode(),
}


def _plant(name: str, body: bytes) -> str:
    task_id = (name.encode().hex() + "0" * 32)[:32]
    _tasks_dir().mkdir(parents=True, exist_ok=True)
    (_tasks_dir() / f"{task_id}.json").write_bytes(body)
    return task_id


@pytest.mark.parametrize("kind", sorted(_BAD_TASKS))
def test_bad_task_file_is_quarantined_and_admission_continues(client, kind, caplog):
    task_id = _plant(kind, _BAD_TASKS[kind])
    with caplog.at_level(logging.ERROR):
        response = _submit(client)
    assert response.status_code == 202, response.text
    assert not (_tasks_dir() / f"{task_id}.json").exists()
    [kept] = _quarantined()
    assert kept.startswith(task_id) and kept.endswith(".json")
    assert (gateway_tasks.quarantine_dir() / kept).read_bytes() == _BAD_TASKS[kind]
    assert any(task_id in record.getMessage() for record in caplog.records)


def test_bad_task_file_does_not_stop_scheduling_cleanup_or_recovery(client, monkeypatch):
    good = _submit(client, key="g").json()["task_id"]
    _plant("schema", _BAD_TASKS["schema"])
    started: list[str] = []

    class _Thread:
        def __init__(self, target, args, **_kwargs):
            self.args = args

        def start(self):
            started.append(self.args[0])

    # 跑真实调度但不起线程。
    monkeypatch.setattr(gateway_tasks.threading, "Thread", _Thread)
    try:
        _REAL_PUMP()
        assert started == [good]
    finally:
        gateway_tasks._running.clear()

    gateway_tasks.recover_after_restart()
    assert gateway_tasks.get_task(client.record.id, good).status == "failed"
    assert gateway_tasks.cleanup(gateway_tasks._now() + timedelta(hours=25)) == 1
    assert len(_quarantined()) == 1


def test_task_with_unparseable_timestamp_is_quarantined_not_crashing_cleanup(client):
    good = _submit(client).json()["task_id"]
    raw = json.loads((_tasks_dir() / f"{good}.json").read_text(encoding="utf-8"))
    bad_id = "f" * 32
    (_tasks_dir() / f"{bad_id}.json").write_text(
        json.dumps({**raw, "task_id": bad_id, "idempotency_key": "other", "created_at": "昨天"}),
        encoding="utf-8")
    assert gateway_tasks.cleanup(gateway_tasks._now() + timedelta(hours=25)) == 1
    assert [name[:32] for name in _quarantined()] == [bad_id]


def test_bad_usage_lines_do_not_block_settlement_or_quota(client):
    path = gateway_tasks.usage_file(gateway_tasks._now().astimezone().strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe broken\n[1, 2]\n\"text\"\n"
                     + json.dumps({"time": gateway_tasks._now().isoformat(), "key_id": client.record.id,
                                   "charged_cny": "abc"}).encode() + b"\n")
    pending = _submit(client).json()["task_id"]
    gateway_tasks.recover_after_restart()
    assert gateway_tasks.get_task(client.record.id, pending).status == "failed"
    assert _submit(client, key="again").status_code == 202


# ---- gateway.json ----

def _corrupt_config(body: bytes = b"{\"enabled\": true, \"keys\": [") -> bytes:
    from character_workflow.lib.private_json import write_private_json

    # 先按正常流程建出权限正确的文件，再原地写坏内容：只模拟「内容损坏」。
    if not gateway_keys.gateway_file().exists():
        write_private_json(gateway_keys.gateway_file(), {})
    gateway_keys.gateway_file().write_bytes(body)
    return body


def test_main_service_starts_with_corrupt_gateway_config(isolated_data_root, tmp_path):
    from tests.local_client import LocalTestClient
    from viewer_server.gateway_app import gateway_server
    from viewer_server.server_app import build_app

    body = _corrupt_config()
    with LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN) as local:
        view = local.get("/api/gateway")
        assert view.status_code == 200
        state = view.json()
        assert state["config_error"] and "gateway.json" in state["config_error"]
        assert state["enabled"] is False and state["keys"] == []
        assert not gateway_server.running and gateway_server.status()["error"]
        refused = local.put("/api/gateway", json={"enabled": True})
        assert refused.status_code == 500 and "损坏" in refused.json()["detail"]
    assert gateway_keys.gateway_file().read_bytes() == body


def test_schema_invalid_gateway_config_never_leaks_tokens(isolated_data_root, caplog):
    from viewer_server.gateway_app import GatewayServer

    secret = "atg_" + "s" * 40
    body = _corrupt_config(json.dumps({"keys": [{"id": "k", "token": secret}]}).encode())
    server = GatewayServer(host="127.0.0.1")
    with caplog.at_level(logging.INFO):
        server.apply_saved()
    assert not server.running and "损坏" in server.status()["error"]
    assert secret not in caplog.text and secret not in server.status()["error"]
    with pytest.raises(gateway_keys.GatewayConfigCorruptError) as raised:
        gateway_keys.update_settings(enabled=True)
    assert secret not in str(raised.value) and raised.value.__cause__ is None
    assert gateway_keys.gateway_file().read_bytes() == body


def test_running_task_fails_as_unavailable_when_config_turns_corrupt(client):
    task = gateway_tasks.get_task(client.record.id, _submit(client).json()["task_id"])
    _corrupt_config()
    done = gateway_tasks.run_task(task)
    assert (done.status, done.error_kind) == ("failed", "unavailable")
    assert "损坏" in done.error


def test_quarantined_count_is_reported_on_the_settings_view(client, tmp_path):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    _plant("empty", b"")
    gateway_tasks._all_tasks()
    local = LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    state = local.get("/api/gateway").json()
    assert state["quarantined_tasks"] == 1 and state["config_error"] is None
