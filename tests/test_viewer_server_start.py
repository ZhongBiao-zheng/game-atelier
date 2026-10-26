import os
import json
import logging
from logging.handlers import TimedRotatingFileHandler
import http.client
import subprocess
import threading
import sys
import time
from pathlib import Path

import pytest

from character_workflow.lib import data_root
from character_workflow.lib.file_lock import try_file_lock
from viewer_server import server
from viewer_server.connection_status import INSTANCE_ENV, LocalConnectionStatus
from viewer_server.pid import (
    read_instance, read_pid, read_port, write_instance, write_pid, write_port,
)


@pytest.fixture
def update_transaction(tmp_path, monkeypatch):
    from viewer_server import bundle_update as update
    from character_workflow.lib.atomic_io import atomic_write_json
    root = tmp_path / "installation"
    runtime = tmp_path / "data/.runtime"
    runtime.mkdir(parents=True)
    for version in ("5.129.0", "5.130.0"):
        payload = root / "versions" / version
        executable = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
        executable.parent.mkdir(parents=True)
        executable.touch()
        (payload / "app/scripts").mkdir(parents=True)
        (payload / "app/scripts/bootstrap.py").touch()
        (payload / "VERSION").write_text(version)
    for name in ("current", "last-good"):
        (root / name).write_text("5.129.0")
    pending = {"update_id": "a" * 32, "from": "5.129.0", "to": "5.130.0",
               "service_mode": False, "started_at": time.time() - 1000,
               "from_instance": "b" * 32}
    atomic_write_json(root / "updates/pending.json", pending)
    (runtime / "maintenance").touch()
    actions = []
    monkeypatch.setattr(update, "_stop", lambda *args, **kwargs: actions.append("stop"))
    monkeypatch.setattr(update, "_start", lambda root, runtime, version, **kwargs:
                        actions.append(("start", version, kwargs)))
    return update, root, runtime, pending, actions


def test_bundle_update_commits_only_after_report_without_holding_start_lock(update_transaction, monkeypatch):
    update, root, runtime, pending, actions = update_transaction
    def ready(runtime, version, **kwargs):
        assert version == "5.130.0"
        assert kwargs["update_id"] == pending["update_id"]
        assert update.update_running(runtime)
        with try_file_lock(runtime / "server.start.lock") as acquired:
            assert acquired
        assert (root / "current").read_text() == "5.129.0"
        assert (root / "last-good").read_text() == "5.129.0"
        activation = runtime / f"update-activate-{pending['update_id']}"
        if kwargs.get("ready"):
            assert activation.read_text() == pending["update_id"]
        else:
            assert not activation.exists()
        return True
    monkeypatch.setattr(update, "_wait_ready", ready)
    assert update.apply_update(root, runtime, "5.130.0", pending["update_id"]) == 0
    assert (root / "current").read_text().strip() == "5.130.0"
    assert (root / "last-good").read_text().strip() == "5.130.0"
    assert (root / "previous").read_text().strip() == "5.129.0"
    assert update.read_json(runtime / "update-result.json")["status"] == "succeeded"
    assert not (root / "updates/pending.json").exists()
    assert not (runtime / "maintenance").exists()
    assert actions[0] == "stop"


@pytest.mark.parametrize("restored", [True, False])
def test_bundle_update_failed_report_restores_old_pointer_and_reports_recovery(update_transaction, monkeypatch, restored):
    update, root, runtime, pending, actions = update_transaction
    monkeypatch.setattr(update, "_wait_ready", lambda runtime, version, **kwargs:
                        restored if version == "5.129.0" else False)
    assert update.apply_update(root, runtime, "5.130.0", pending["update_id"]) == 1
    assert (root / "current").read_text().strip() == "5.129.0"
    assert (root / "last-good").read_text().strip() == "5.129.0"
    result = update.read_json(runtime / "update-result.json")
    assert result["status"] == "failed"
    assert ("旧版尚未恢复" in result["reason"]) == (not restored)
    assert "5.130.0" in update.read_json(root / "updates/blocked.json")
    assert [a[1] for a in actions if isinstance(a, tuple)] == ["5.130.0", "5.129.0"]


def test_bundle_update_initialization_failure_does_not_commit_last_good(update_transaction, monkeypatch):
    update, root, runtime, pending, actions = update_transaction
    phases = []
    def readiness(runtime, version, **kwargs):
        if version == "5.129.0":
            return True
        phases.append(bool(kwargs.get("ready")))
        assert (root / "last-good").read_text() == "5.129.0"
        return not kwargs.get("ready", False)
    monkeypatch.setattr(update, "_wait_ready", readiness)
    assert update.apply_update(root, runtime, "5.130.0", pending["update_id"]) == 1
    assert phases == [False, True]
    assert (root / "last-good").read_text().strip() == "5.129.0"
    assert (root / "current").read_text().strip() == "5.129.0"
    assert update.read_json(runtime / "update-result.json")["reason"] == "新版初始化失败或超时"
    assert [a[1] for a in actions if isinstance(a, tuple)] == ["5.130.0", "5.129.0"]


def test_bundle_update_failed_initialization_marker_ends_wait_immediately(update_transaction, monkeypatch):
    update, root, runtime, pending, actions = update_transaction
    (runtime / f"update-start-failed-{pending['update_id']}").write_text("failed")
    monkeypatch.setattr(update, "_status", lambda runtime: pytest.fail("must fail before probing"))
    assert not update._wait_ready(runtime, "5.130.0", update_id=pending["update_id"],
                                  ready=True, timeout=60)


def test_bundle_update_crash_recovery_stops_survivor_before_restoring_pointer(update_transaction, monkeypatch):
    update, root, runtime, pending, actions = update_transaction
    (root / "current").write_text("5.130.0")
    def stop(*args, **kwargs):
        assert (root / "current").read_text() == "5.130.0"
        actions.append("verified-stop")
    monkeypatch.setattr(update, "_stop", stop)
    update.recover_pending(root, runtime)
    assert actions == ["verified-stop"]
    assert (root / "current").read_text().strip() == "5.129.0"
    assert update.read_json(runtime / "update-result.json")["update_id"] == pending["update_id"]
    assert not (runtime / "maintenance").exists()


def test_bundle_update_recovery_finishes_durable_commit_without_rollback(update_transaction):
    update, root, runtime, pending, actions = update_transaction
    (root / "last-good").write_text("5.130.0")
    update.recover_pending(root, runtime)
    assert actions == []
    assert (root / "current").read_text().strip() == "5.130.0"
    assert update.read_json(runtime / "update-result.json")["status"] == "succeeded"


def test_bundle_update_recovery_does_not_race_a_live_executor(update_transaction):
    update, root, runtime, pending, actions = update_transaction
    with try_file_lock(runtime / "update.lock") as acquired:
        assert acquired
        update.recover_pending(root, runtime)
    assert actions == []
    assert (root / "updates/pending.json").exists()
    assert (runtime / "maintenance").exists()


def test_bundle_update_waiting_crash_finishes_immediately_without_stopping_or_blocking(update_transaction):
    update, root, runtime, pending, actions = update_transaction
    pending.update(phase="waiting", started_at=time.time())
    update.atomic_write_json(root / "updates/pending.json", pending)
    update.recover_pending(root, runtime)
    result = update.read_json(runtime / "update-result.json")
    assert result["status"] == "failed"
    assert result["update_id"] == pending["update_id"]
    assert actions == []
    assert (root / "current").read_text() == "5.129.0"
    assert not (root / "updates/blocked.json").exists()
    assert not (root / "updates/pending.json").exists()
    assert not (runtime / "maintenance").exists()


@pytest.mark.parametrize("probe", ["responding", "unresponsive", "unknown_command"])
def test_bundle_update_waiting_owner_is_not_interrupted_by_another_launcher(update_transaction, monkeypatch, probe):
    from viewer_server import pid as pid_module
    update, root, runtime, pending, actions = update_transaction
    pending.update(phase="waiting", started_at=time.time() - 1000)
    update.atomic_write_json(root / "updates/pending.json", pending)
    write_pid(runtime, os.getpid())
    write_instance(runtime, pending["from_instance"])
    status = LocalConnectionStatus(service="game-atelier", instance_id=pending["from_instance"],
                                   app_version="5.129.0", protocol="atelier-local/2")
    monkeypatch.setattr(update, "_status", lambda runtime: status if probe == "responding" else None)
    monkeypatch.setattr(pid_module, "is_viewer_server_process",
                        lambda pid: None if probe == "unknown_command" else True)
    with pytest.raises(RuntimeError, match="等待任务完成"):
        update.recover_pending(root, runtime)
    assert actions == []
    assert (root / "updates/pending.json").exists()
    assert (runtime / "maintenance").exists()
    assert not (runtime / "update-result.json").exists()


def test_bundle_update_waiting_dead_owner_can_be_recovered(update_transaction, monkeypatch):
    update, root, runtime, pending, actions = update_transaction
    pending.update(phase="waiting", started_at=time.time())
    update.atomic_write_json(root / "updates/pending.json", pending)
    write_pid(runtime, 123456)
    write_instance(runtime, pending["from_instance"])
    monkeypatch.setattr(update, "_status", lambda runtime: None)
    monkeypatch.setattr(update, "_is_alive", lambda pid: False)
    update.recover_pending(root, runtime)
    assert actions == []
    assert update.read_json(runtime / "update-result.json")["status"] == "failed"
    assert not (root / "updates/pending.json").exists()
    assert not (runtime / "maintenance").exists()


def test_bundle_update_rollback_lifespan_recovery_leaves_live_transaction_intact(update_transaction):
    update, root, runtime, pending, actions = update_transaction
    pending["phase"] = "rollback"
    update.atomic_write_json(root / "updates/pending.json", pending)
    with try_file_lock(runtime / "update.lock") as acquired:
        assert acquired
        update.recover_pending(root, runtime)
    assert update.pending_update(root)["phase"] == "rollback"
    assert actions == []
    assert (runtime / "maintenance").exists()
    assert not (runtime / "update-result.json").exists()



@pytest.fixture(autouse=True)
def _records_belong_to_viewer_server(monkeypatch):
    """既有用例用 os.getpid()（pytest 自身）冒充存活的服务进程，按命令行核对会被判成别人的进程。"""
    import viewer_server.pid as pidmod

    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: True)
    monkeypatch.setattr(server, "is_viewer_server_process", lambda pid: True)


def test_bootstrap_gate_decodes_check_output_as_utf8(monkeypatch):
    """父进程读 bootstrap --check 必须显式 encoding=utf-8。

    Windows 默认按 GBK 解码子进程管道，遇中文 reader 线程崩 → stdout=None →
    json.loads(None) TypeError。回归守卫：断言传了 encoding，且中文 JSON 能解析。
    """
    captured = {}

    def fake_run(cmd, **kwargs):
        captured.update(kwargs)
        # 含中文的 ready 状态，确认能被正确解码 + 解析
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"status": "ready", "msg": "依赖就绪"}', stderr=""
        )

    monkeypatch.setattr(server.subprocess, "run", fake_run)

    assert server._bootstrap_gate(background=True) is True
    assert captured.get("encoding") == "utf-8"


def test_bootstrap_gate_fails_cleanly_on_empty_stdout(monkeypatch):
    """stdout 为空/None 时不能 json.loads 崩，应返回 False 给出可读提示。"""
    monkeypatch.setattr(
        server.subprocess, "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="", stderr="boom"),
    )
    assert server._bootstrap_gate(background=True) is False


def test_start_preserves_alive_unverified_server_instead_of_starting_second_writer(
    tmp_path, monkeypatch,
):
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    write_pid(runtime, os.getpid())
    write_port(runtime, 59999)

    monkeypatch.setattr(data_root, "runtime_dir", lambda: runtime)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)

    def unexpected(*args, **kwargs):
        raise AssertionError("must not create another server or open an unverified page")

    monkeypatch.setattr(server, "_spawn_detached", unexpected)
    monkeypatch.setattr(server, "cmd_open_browser", unexpected)

    with pytest.raises(SystemExit) as error:
        server.cmd_start(background=True)
    assert error.value.code == 1
    assert read_pid(runtime) == os.getpid()
    assert read_port(runtime) == 59999


def test_daily_logs_roll_over_and_keep_fourteen_archives(tmp_path):
    from viewer_server.server_logging import log_config

    options = log_config(tmp_path)["handlers"]["daily"].copy()
    options.pop("class")
    options.pop("formatter")
    options.pop("filters")
    handler = TimedRotatingFileHandler(**options)
    try:
        for day in range(1, 17):
            (tmp_path / f"server.log.2025-01-{day:02d}").write_text("history", encoding="utf-8")
        handler.emit(logging.makeLogRecord({"msg": "before rotation", "levelno": logging.INFO}))
        handler.doRollover()
        handler.emit(logging.makeLogRecord({"msg": "after rotation", "levelno": logging.INFO}))
        assert len(list(tmp_path.glob("server.log.*"))) == 14
        assert "after rotation" in (tmp_path / "server.log").read_text()
    finally:
        handler.close()


def test_start_passes_instance_to_child_and_only_opens_after_verification(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    captured = {}
    opened = []

    def spawn(cmd, *, cwd, env, log_path):
        captured["log_path"] = log_path
        captured.update(cmd=cmd, env=env)
        return 43210

    def ready(port, instance):
        assert (port, instance) == (5188, read_instance(runtime))
        assert instance == captured["env"][INSTANCE_ENV]
        captured["verified"] = True
        return True

    monkeypatch.setattr(data_root, "runtime_dir", lambda: runtime)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "_find_free_port", lambda start: 5188)
    monkeypatch.setattr(server, "_spawn_detached", spawn)
    monkeypatch.setattr(server, "_wait_for_server", ready)
    monkeypatch.setattr(server, "cmd_open_browser", lambda: opened.append(captured["verified"]))

    server.cmd_start(background=True)

    assert read_pid(runtime) == 43210
    assert captured["log_path"] == runtime / "server-startup.log"
    config_path = captured["cmd"][captured["cmd"].index("--log-config") + 1]
    config = json.loads(Path(config_path).read_text())
    assert config["handlers"]["daily"]["backupCount"] == 14
    assert read_port(runtime) == 5188
    assert opened == [True]
    assert captured["cmd"][captured["cmd"].index("--host") + 1] == "127.0.0.1"


def test_same_running_instance_is_reused(tmp_path, monkeypatch):
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    opened = []
    monkeypatch.setattr(server.webbrowser, "open", lambda url: opened.append(url))
    monkeypatch.setattr(
        server, "_spawn_detached", lambda *a, **kw: pytest.fail("must reuse the live server"),
    )
    server.cmd_start(background=True)
    assert opened == ["http://127.0.0.1:5188/"]


def test_same_port_different_instance_cannot_be_reused_or_stopped(tmp_path, monkeypatch):
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="b" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    monkeypatch.setattr(server, "_terminate", lambda pid: pytest.fail("wrong process"))
    monkeypatch.setattr(server.webbrowser, "open", lambda url: pytest.fail("wrong service"))
    for command in (server.cmd_start, server.cmd_stop, server.cmd_open_browser):
        with pytest.raises(SystemExit):
            command()
    assert read_instance(tmp_path) == "a" * 32


def test_stop_verified_instance_only(tmp_path, monkeypatch):
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    stopped = []
    monkeypatch.setattr(server, "_terminate", lambda pid: stopped.append(pid) or True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid: True)
    server.cmd_stop()
    assert stopped == [os.getpid()]


def test_startup_timeout_does_not_open_or_erase_the_child_record(tmp_path, monkeypatch):
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "_find_free_port", lambda start: 5188)
    monkeypatch.setattr(server, "_spawn_detached", lambda *a, **kw: 43210)
    monkeypatch.setattr(server, "_wait_for_server", lambda *a: False)
    monkeypatch.setattr(server, "cmd_open_browser", lambda: pytest.fail("not ready"))
    with pytest.raises(SystemExit):
        server.cmd_start(background=True)
    assert read_pid(tmp_path) == 43210
    assert read_instance(tmp_path) is not None


def test_competing_launcher_does_not_touch_startup_records(tmp_path, monkeypatch):
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "_spawn_detached", lambda *a, **kw: pytest.fail("locked"))
    with try_file_lock(tmp_path / "server.start.lock") as acquired:
        assert acquired
        with pytest.raises(SystemExit):
            server.cmd_start(background=True)
        with pytest.raises(SystemExit):
            server.cmd_stop()
    assert read_pid(tmp_path) is None
    assert read_instance(tmp_path) is None


def test_wait_for_server_is_bounded(monkeypatch):
    moments = iter([0.0, 0.0, 0.5, 1.0])
    attempts = []
    monkeypatch.setattr(server.time, "monotonic", lambda: next(moments))
    monkeypatch.setattr(server.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(server, "_server_responds", lambda *args: attempts.append(args) or False)
    assert server._wait_for_server(5188, "a" * 32, timeout=1.0) is False
    assert len(attempts) == 2


def test_foreground_server_uses_recorded_instance_and_releases_launch_lock(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "_find_free_port", lambda start: 5188)
    served = []

    def run(app, **kwargs):
        with try_file_lock(tmp_path / "server.start.lock") as acquired:
            assert acquired
        status = TestClient(base_url="http://127.0.0.1", app=app).get("/api/connection/status").json()
        assert status["instance_id"] == read_instance(tmp_path)
        assert kwargs["host"] == "127.0.0.1"
        assert kwargs["port"] == read_port(tmp_path)
        served.append(True)

    monkeypatch.setattr(server.uvicorn, "run", run)
    server.cmd_start(background=False)
    assert served == [True]


def test_real_local_runtime_can_be_discovered_reused_and_stopped(isolated_data_root):
    """Exercise the actual CLI/app boundary without bootstrap, browser or provider side effects."""
    env = os.environ.copy()
    env.pop(INSTANCE_ENV, None)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    prefix = (
        "from viewer_server import server; "
        "server._bootstrap_gate = lambda background: True; "
        "server.webbrowser.open = lambda url: True; "
    )
    runtime = isolated_data_root / ".runtime"
    # Windows venv's python.exe can be a redirector; Popen.pid then belongs to
    # the launcher, while the service must record the actual interpreter PID.
    process = subprocess.Popen(
        [sys.executable, "-c", "import os; print(os.getpid(), flush=True); "
         + prefix + "server.cmd_start(background=False)"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8",
    )
    try:
        deadline = time.monotonic() + 12
        found = False
        while time.monotonic() < deadline and process.poll() is None:
            port = read_port(runtime)
            if port is not None and server._server_responds(port, read_instance(runtime)):
                found = True
                break
            time.sleep(0.05)
        assert found, "isolated runtime did not complete its real handshake"
        # The owned child printed before starting the now-verified service, so
        # this read is ready; a PID from discovery alone is not proof of ownership.
        runtime_pid = int(process.stdout.readline().strip())
        assert read_pid(runtime) == runtime_pid
        first_instance = read_instance(runtime)

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("GET", "/api/config", headers={"Host": "rebind.example"})
            response = connection.getresponse()
            assert response.status == 421
            response.read()
            connection.request("POST", "/api/projects", body="{}", headers={
                "Origin": "https://unpaired.vercel.app", "Content-Type": "application/json",
            })
            response = connection.getresponse()
            assert response.status == 403
            response.read()
        finally:
            connection.close()

        reused = subprocess.run(
            [sys.executable, "-c", prefix + "server.cmd_start(background=True)"],
            env=env, capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        assert reused.returncode == 0, reused.stderr
        assert read_pid(runtime) == runtime_pid
        assert read_instance(runtime) == first_instance

        # 真实启动器里 stop 与服务不是父子进程；这里 pytest 是父进程，退出后的子进程在被 wait 前是
        # 僵尸（kill(pid, 0) 仍成功），先起线程 wait 掉，stop 的等退出才判得准。
        reaper = threading.Thread(target=process.wait, kwargs={"timeout": 15}, daemon=True)
        reaper.start()
        stopped = subprocess.run(
            [sys.executable, "-c", prefix + "server.cmd_stop()"],
            env=env, capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        assert stopped.returncode == 0, stopped.stderr
        process.wait(timeout=10)
    finally:
        # Only the child created by this test may be terminated, never a discovered user PID.
        if process.poll() is None:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                    capture_output=True, timeout=5,
                )
            else:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stdout.close()


def test_legacy_record_without_instance_can_be_stopped_and_start_points_to_stop(
    tmp_path, monkeypatch, capsys,
):
    # 旧版本只写 pid/port，不写 server.instance；升级后老服务仍在跑，用户必须能从 stop 出去。
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)
    monkeypatch.setattr(server, "_spawn_detached", lambda *a, **k: pytest.fail("second writer"))

    with pytest.raises(SystemExit):
        server.cmd_start(background=True)
    assert "stop" in capsys.readouterr().err

    stopped = []
    monkeypatch.setattr(server, "_terminate", lambda pid: stopped.append(pid) or True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid: True)
    server.cmd_stop()
    assert stopped == [os.getpid()]


def test_stop_waits_for_exit_then_clears_records_so_start_can_follow(tmp_path, monkeypatch):
    """一键启动 = stop 紧接 start：stop 必须等进程退出并清掉记录，否则 start 读到「活着但不应答」的记录就拒启。"""
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    monkeypatch.setattr(server, "_terminate", lambda pid: True)
    alive = {"value": True}
    import viewer_server.pid as pid_module
    monkeypatch.setattr(server, "_is_alive", lambda pid: alive["value"])
    monkeypatch.setattr(pid_module, "_is_alive", lambda pid: alive["value"])
    monkeypatch.setattr(server.time, "sleep", lambda s: alive.update(value=False))
    server.cmd_stop()
    assert not (tmp_path / "server.pid").exists()
    assert not (tmp_path / "server.instance").exists()


def test_stop_keeps_records_when_process_does_not_exit(tmp_path, monkeypatch, capsys):
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: LocalConnectionStatus(
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/2",
    ))
    monkeypatch.setattr(server, "_terminate", lambda pid: True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid, **_kwargs: False)
    forced: list[int] = []
    # 记录里的 pid 是 pytest 自己：强杀必须被拦成记录，否则会把测试进程杀掉。
    monkeypatch.setattr(server, "_force_kill", lambda pid: forced.append(pid) or True)
    with pytest.raises(SystemExit):
        server.cmd_stop()
    assert forced == [os.getpid()]
    assert (tmp_path / "server.pid").exists()
    err = capsys.readouterr().err
    assert "强制结束" in err and "无法结束" in err


def test_start_recovers_from_reused_pid_that_is_not_viewer_server(tmp_path, monkeypatch):
    """同事重启 Windows 后 PID 被复用：旧记录存活但不是自家服务，start 清掉记录后正常启动。"""
    import viewer_server.pid as pidmod

    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    write_pid(runtime, os.getpid())
    write_port(runtime, 5174)
    write_instance(runtime, "a" * 32)
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: False)
    monkeypatch.setattr(server, "is_viewer_server_process", lambda pid: False)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: runtime)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)
    monkeypatch.setattr(server, "_find_free_port", lambda start: 5174)
    spawned = []
    monkeypatch.setattr(server, "_spawn_detached", lambda *a, **k: spawned.append(k) or 4242)
    monkeypatch.setattr(server, "_wait_for_server", lambda port, instance_id: True)
    monkeypatch.setattr(server, "cmd_open_browser", lambda: None)

    server.cmd_start(background=True)

    assert spawned
    assert read_pid(runtime) == 4242


def test_stop_terminates_own_server_that_no_longer_responds(tmp_path, monkeypatch):
    """自家服务卡死（实例探测不过），命令行核对是 viewer-server 就照常发停止信号。"""
    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)
    stopped = []
    monkeypatch.setattr(server, "_terminate", lambda pid: stopped.append(pid) or True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid, **_k: True)
    server.cmd_stop()
    assert stopped == [os.getpid()]


def test_stop_refuses_unverifiable_record_when_command_line_unreadable(tmp_path, monkeypatch):
    import viewer_server.pid as pidmod

    write_pid(tmp_path, os.getpid())
    write_port(tmp_path, 5188)
    write_instance(tmp_path, "a" * 32)
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: None)
    monkeypatch.setattr(server, "is_viewer_server_process", lambda pid: None)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)
    monkeypatch.setattr(server, "_terminate", lambda pid: pytest.fail("must not touch unverified pid"))
    with pytest.raises(SystemExit):
        server.cmd_stop()
    assert read_pid(tmp_path) == os.getpid()


def test_start_points_to_stop_when_own_server_is_alive_but_silent(tmp_path, monkeypatch, capsys):
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    write_pid(runtime, os.getpid())
    write_port(runtime, 5174)
    write_instance(runtime, "a" * 32)
    monkeypatch.setattr(data_root, "runtime_dir", lambda: runtime)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "probe_connection_status", lambda port: None)
    monkeypatch.setattr(server, "_spawn_detached", lambda *a, **k: pytest.fail("second writer"))
    with pytest.raises(SystemExit):
        server.cmd_start(background=True)
    assert "stop" in capsys.readouterr().err
    assert read_pid(runtime) == os.getpid()
