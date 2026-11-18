"""团队主机的测量：网关任务用量行的时间字段、生命周期日志、主机启停记录与只读汇总。"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_stats, gateway_tasks, host_lifecycle
from tests.test_gateway import _dispatch, _seed_keys, _submit
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


class _NoThread:
    def __init__(self, target, args, **_kwargs):
        pass

    def start(self):
        pass


def _start_all(monkeypatch) -> None:
    monkeypatch.setattr(gateway_tasks.threading, "Thread", _NoThread)
    try:
        _REAL_PUMP()
    finally:
        gateway_tasks._running.clear()


def _usage_rows():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))


def test_usage_row_records_queue_and_execution_time(client, monkeypatch, caplog):
    from character_workflow.lib import callers

    task_id = _submit(client).json()["task_id"]
    _start_all(monkeypatch)
    started = gateway_tasks.get_task(client.record.id, task_id)
    assert started.status == "running" and started.started_at

    def dispatch(**kwargs):
        kwargs["on_task_id"]("up-1")
        return _dispatch([])(**kwargs)

    monkeypatch.setattr(callers, "dispatch", dispatch)
    with caplog.at_level(logging.INFO, logger="character_workflow.lib.gateway_tasks"):
        done = gateway_tasks.run_task(started)
    assert done.status == "done"
    [row] = _usage_rows()
    assert row["queued_at"] == done.created_at and row["started_at"] == done.started_at
    assert row["finished_at"] == row["time"]
    assert row["queue_s"] >= 0 and row["duration_s"] >= 0
    assert row["sent_to_upstream"] is True and row["sent_at"] == done.sent_at
    assert row["upstream_task_ids"] == ["up-1"]
    assert f"网关任务发往上游 task={task_id}" in caplog.text
    assert "网关任务拿到上游订单" in caplog.text and "up-1" in caplog.text
    assert f"网关任务结束 task={task_id} status=done" in caplog.text


def test_lifecycle_logs_cover_admission_start_cancel_and_restart_without_prompt(client, monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="character_workflow.lib.gateway_tasks"):
        first = _submit(client, key="a").json()["task_id"]
        second = _submit(client, key="b").json()["task_id"]
        _start_all(monkeypatch)
        gateway_tasks.cancel(client.record.id, first)
        gateway_tasks.recover_after_restart()
    text = caplog.text
    assert f"网关任务受理 task={first}" in text and f"网关任务开始 task={second}" in text
    assert f"网关任务请求取消 task={first}" in text
    assert f"网关任务因重启中断 task={second} 原状态=running" in text
    assert "error_kind=unconfirmed" in text
    assert "一只猫" not in text and client.headers["Authorization"].split()[1] not in text


def test_ended_before_start_has_queue_time_but_no_execution_time(client):
    # 第 2 批起重启不再结束排队任务；没开始就结束的任务改用取消来造。
    task_id = _submit(client).json()["task_id"]
    gateway_tasks.cancel(client.record.id, task_id)
    [row] = _usage_rows()
    assert row["started_at"] is None and row["duration_s"] is None and row["queue_s"] >= 0
    assert row["sent_to_upstream"] is False and row["sent_at"] is None


def test_old_task_files_and_usage_rows_without_timing_still_read(client, tmp_path):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    task_id = _submit(client).json()["task_id"]
    path = gateway_tasks._task_file(task_id)
    legacy = json.loads(path.read_text(encoding="utf-8"))
    legacy.pop("started_at")
    path.write_text(json.dumps(legacy), encoding="utf-8")
    assert gateway_tasks.get_task(client.record.id, task_id).started_at is None
    usage = gateway_tasks.usage_file(gateway_tasks._now().astimezone().strftime("%Y-%m"))
    usage.parent.mkdir(parents=True, exist_ok=True)
    usage.write_text(json.dumps({"time": gateway_tasks._now().isoformat(), "task_id": "old",
                                 "key_id": client.record.id, "status": "done", "kind": "image",
                                 "charged_cny": 0.1}) + "\n", encoding="utf-8")
    gateway_keys.update_settings(enabled=True)
    local = LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    assert local.get("/api/usage?scope=team").json()["totals"]["count"] == 1
    summary = gateway_stats.summarize(gateway_tasks._now() - timedelta(days=1), gateway_tasks._now())
    assert summary["tasks"]["count"] == 1 and summary["tasks"]["rows_without_timing"] == 1
    assert summary["tasks"]["duration"]["samples"] == 0


# ---- 主机启停记录 ----

def test_host_lifecycle_tells_clean_stop_from_abnormal_end(isolated_data_root):
    first = host_lifecycle.record_start(version="1.0", service_mode=True, pid=1, instance_id="a")
    assert first["previous"] == "first"
    host_lifecycle.record_stop(reason="normal", pid=1, source="cli")
    host_lifecycle.record_stop(reason="normal", pid=1, source="server")  # 命令行已记，服务端不重复
    assert host_lifecycle.record_start(version="1.0", service_mode=True, pid=2,
                                       instance_id="b")["previous"] == "clean"
    abnormal = host_lifecycle.record_start(version="1.1", service_mode=False, pid=3, instance_id="c")
    assert abnormal["previous"] == "abnormal" and abnormal["previous_last_alive_at"]
    assert [event["event"] for event in host_lifecycle.read_events()] == [
        "start", "stop", "start", "start"]


def test_host_lifecycle_rotates_and_skips_bad_lines(isolated_data_root, monkeypatch):
    monkeypatch.setattr(host_lifecycle, "MAX_BYTES", 400)
    path = host_lifecycle.lifecycle_file()
    path.write_bytes(b"\xff broken\n[1]\n")
    for pid in range(6):
        host_lifecycle.record_start(version="1.0", service_mode=False, pid=pid, instance_id=None)
        host_lifecycle.record_stop(reason="normal", pid=pid, source="cli")
    assert path.stat().st_size < 400 + 300
    assert host_lifecycle._rotated_file().exists()
    events = host_lifecycle.read_events()
    assert events and all(event["event"] in ("start", "stop") for event in events)


def test_stop_cli_records_update_reason(tmp_path, monkeypatch):
    from viewer_server import server

    host_lifecycle_rows: list[dict] = []
    monkeypatch.setattr(host_lifecycle, "_append", lambda row, runtime=None: host_lifecycle_rows.append(
        {**row, "runtime": runtime}))
    server._record_stop(tmp_path, 42, "update")
    server._record_stop(tmp_path, 43, "normal")
    assert [(row["reason"], row["pid"], row["source"], row["runtime"]) for row in host_lifecycle_rows] == [
        ("update", 42, "cli", tmp_path), ("normal", 43, "cli", tmp_path)]


def test_bundle_update_stops_with_update_reason(tmp_path, monkeypatch):
    from viewer_server import bundle_update, server

    reasons: list[str] = []
    monkeypatch.setattr(server, "_stop_locked", lambda runtime, *, reason="normal": reasons.append(reason))
    bundle_update._stop(tmp_path)
    assert reasons == ["update"]


def test_server_lifespan_records_start_and_stop(isolated_data_root, tmp_path):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    with LocalTestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN) as local:
        local.get("/api/gateway")
        for _ in range(50):
            if host_lifecycle.read_events():
                break
            import time
            time.sleep(0.02)
    events = host_lifecycle.read_events()
    assert [event["event"] for event in events] == ["start", "stop"]
    assert events[0]["pid"] == os.getpid() and events[0]["service_mode"] is False
    assert events[1]["source"] == "server" and events[1]["reason"] == "normal"


# ---- 汇总 ----

def _row(at: datetime, status: str, *, queue: float, duration: float | None, error_kind=None,
         kind="image") -> dict:
    return {"time": at.isoformat(), "task_id": f"t{at.timestamp()}", "status": status, "kind": kind,
            "error_kind": error_kind, "queue_s": queue, "duration_s": duration,
            "queued_at": at.isoformat(), "started_at": at.isoformat(), "finished_at": at.isoformat()}


def _write_events(rows: list[dict]) -> None:
    path = host_lifecycle.lifecycle_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def test_summary_counts_failures_percentiles_and_uptime(isolated_data_root):
    base = datetime(2026, 11, 10, tzinfo=timezone.utc)
    rows = [_row(base + timedelta(minutes=i), "done", queue=float(i), duration=float(10 + i))
            for i in range(17)]
    rows += [{**_row(base + timedelta(hours=1), "failed", queue=1, duration=2, error_kind="unavailable"),
              "sent_to_upstream": False},
             {**_row(base + timedelta(hours=2), "failed", queue=1, duration=None, error_kind="unconfirmed"),
              "sent_to_upstream": True, "actual_cost_cny": None},
             _row(base + timedelta(hours=3), "canceled", queue=0, duration=None)]
    usage = gateway_tasks.usage_file("2026-11")
    usage.parent.mkdir(parents=True, exist_ok=True)
    usage.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    hour = timedelta(hours=1)
    _write_events([
        {"event": "start", "time": base.isoformat(), "previous": "first", "service_mode": True},
        {"event": "stop", "time": (base + 10 * hour).isoformat(), "reason": "update"},
        {"event": "start", "time": (base + 10.5 * hour).isoformat(), "previous": "clean", "service_mode": True},
        {"event": "start", "time": (base + 20 * hour).isoformat(), "previous": "abnormal",
         "previous_last_alive_at": (base + 15.5 * hour).isoformat(), "service_mode": True},
        {"event": "stop", "time": (base + 24 * hour).isoformat(), "reason": "normal"},
    ])
    summary = gateway_stats.summarize(base, base + 24 * hour, now=base + 30 * hour)
    tasks, host = summary["tasks"], summary["host"]
    assert tasks["count"] == 20 and tasks["by_status"] == {"done": 17, "failed": 2, "canceled": 1}
    assert tasks["failure_rate"] == round(2 / 19, 4)
    assert tasks["failures_by_error_kind"] == {
        "unavailable": {"count": 1, "rate": round(1 / 19, 4)},
        "unconfirmed": {"count": 1, "rate": round(1 / 19, 4)}}
    assert tasks["duration"] == {"samples": 18, "median_s": 17.0, "p95_s": 26.0}
    assert tasks["failed_sent_without_actual_cost"] == 1
    assert tasks["queue"]["samples"] == 20 and tasks["queue"]["p95_s"] == 15.0
    assert host == {"starts": 3, "abnormal_ends": 1, "update_restarts": 1, "service_mode_starts": 3,
                    "online_hours": 19.0, "range_hours": 24.0}


def test_summary_cli_prints_text_and_json(isolated_data_root, capsys):
    assert gateway_stats.main(["--days", "1"]) == 0
    assert "失败率" in capsys.readouterr().out
    assert gateway_stats.main(["--since", "2026-11-01", "--until", "2026-11-02", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["tasks"]["count"] == 0


def test_stop_command_writes_the_stop_record_before_terminating(tmp_path, monkeypatch):
    from character_workflow.lib import data_root
    from viewer_server import server
    from viewer_server.connection_status import LocalConnectionStatus
    from viewer_server.pid import write_instance, write_pid, write_port

    import viewer_server.pid as pidmod

    # 用 pytest 自身的 pid 冒充存活的服务进程（同 test_viewer_server_start 的做法）。
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: True)
    monkeypatch.setattr(server, "is_viewer_server_process", lambda pid: True)
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    seen: list[list[dict]] = []
    monkeypatch.setattr(server, "_terminate", lambda pid: seen.append(host_lifecycle.read_events(tmp_path)) or True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid: True)
    server.cmd_stop()
    assert [(row["event"], row["reason"], row["pid"]) for row in seen[0]] == [("stop", "normal", os.getpid())]


def test_coarse_filesystem_clock_does_not_lose_the_last_alive_time(isolated_data_root):
    """Linux 的文件时间戳取自粗粒度时钟，可能早于紧挨着之前的 Python 时间（CI 3000 次里 290 次）。

    心跳时间必须和启停记录同一个时钟：这里把 .alive 的修改时间压到启动记录之前 2 ms，模拟 Linux。
    """
    start = host_lifecycle.record_start(version="1.0", service_mode=False, pid=1, instance_id=None)
    before = datetime.fromisoformat(start["time"]).timestamp() - 0.002
    os.utime(host_lifecycle.alive_file(), (before, before))
    abnormal = host_lifecycle.record_start(version="1.0", service_mode=False, pid=2, instance_id=None)
    assert abnormal["previous"] == "abnormal"
    assert abnormal["previous_last_alive_at"] is not None
    assert abnormal["previous_last_alive_at"] >= start["time"]


def test_empty_alive_file_from_older_versions_falls_back_to_its_mtime(isolated_data_root):
    start = host_lifecycle.record_start(version="0.9", service_mode=False, pid=1, instance_id=None)
    later = datetime.fromisoformat(start["time"]).timestamp() + 60
    host_lifecycle.alive_file().write_text("", encoding="utf-8")  # 旧版本只 touch，不写内容
    os.utime(host_lifecycle.alive_file(), (later, later))
    abnormal = host_lifecycle.record_start(version="1.0", service_mode=False, pid=2, instance_id=None)
    assert abnormal["previous_last_alive_at"] == datetime.fromtimestamp(later, timezone.utc).isoformat()


def test_summary_counts_an_abnormal_session_without_last_alive_as_zero_hours(isolated_data_root):
    base = datetime(2026, 11, 10, tzinfo=timezone.utc)
    _write_events([
        {"event": "start", "time": base.isoformat(), "previous": "first"},
        {"event": "start", "time": (base + timedelta(hours=5)).isoformat(), "previous": "abnormal",
         "previous_last_alive_at": None},
        {"event": "stop", "time": (base + timedelta(hours=6)).isoformat(), "reason": "normal"},
    ])
    host = gateway_stats.summarize(base, base + timedelta(hours=6), now=base + timedelta(hours=7))["host"]
    # 不知道异常结束前活到几点：那一段按 0 计，只算有据可查的第二段 1 小时。
    assert (host["abnormal_ends"], host["online_hours"]) == (1, 1.0)
