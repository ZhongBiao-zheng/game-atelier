import os
import subprocess

from character_workflow.lib import data_root
from viewer_server import server
from viewer_server.pid import read_pid, read_port, write_pid, write_port


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


def test_start_ignores_alive_pid_when_server_port_does_not_respond(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    write_pid(runtime, os.getpid())
    write_port(runtime, 59999)

    opened = []

    monkeypatch.setattr(data_root, "runtime_dir", lambda: runtime)
    monkeypatch.setattr(server, "_bootstrap_gate", lambda background: True)
    monkeypatch.setattr(server, "_find_free_port", lambda start: 5188)
    monkeypatch.setattr(server, "_spawn_detached", lambda cmd, cwd, env: 43210)
    monkeypatch.setattr(server.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(server, "cmd_open_browser", lambda: opened.append(True))

    server.cmd_start(background=True)

    assert read_pid(runtime) == 43210
    assert read_port(runtime) == 5188
    assert opened == [True]
