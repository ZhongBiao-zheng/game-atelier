import os
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


def test_start_passes_instance_to_child_and_only_opens_after_verification(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    captured = {}
    opened = []

    def spawn(cmd, *, cwd, env):
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
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/1",
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
        service="game-atelier", instance_id="b" * 32, app_version="5.33.2", protocol="atelier-local/1",
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
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/1",
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
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/1",
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
        service="game-atelier", instance_id="a" * 32, app_version="5.33.2", protocol="atelier-local/1",
    ))
    monkeypatch.setattr(server, "_terminate", lambda pid: True)
    monkeypatch.setattr(server, "_wait_for_exit", lambda pid: False)
    with pytest.raises(SystemExit):
        server.cmd_stop()
    assert (tmp_path / "server.pid").exists()
    assert "没有退出" in capsys.readouterr().err
