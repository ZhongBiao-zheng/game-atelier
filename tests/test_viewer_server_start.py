import os

from character_workflow.lib import data_root
from viewer_server import server
from viewer_server.pid import read_pid, read_port, write_pid, write_port


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
