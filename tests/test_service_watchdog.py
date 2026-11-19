"""第 4 批 4-2：常驻模式看护（bootstrap --service）。

前几条用假子进程驱动判定逻辑；`test_real_hung_service_*` 起真实子进程：一个会卡住的假服务（命令行带
viewer_server），外加一个同样带 viewer_server 的旁路进程，验证只结束自己启动的那一个、旁路进程不受影响。
Windows CI 跑的是 TerminateProcess 路径。全部本机，不碰正在运行的服务。
"""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta, timezone

import pytest

from character_workflow.lib import data_root, gateway_stats, host_lifecycle


@pytest.fixture
def boot():
    from viewer_server.update_routes import bootstrap
    return bootstrap()


class _Child:
    def __init__(self, pid: int, *, exits_after: int | None = None, code: int = 0):
        self.pid, self.exits_after, self.code = pid, exits_after, code
        self.waits, self.killed = 0, False

    def wait(self, timeout=None):
        if self.killed:
            return -9
        self.waits += 1
        if self.exits_after is not None and self.waits > self.exits_after:
            return self.code
        raise subprocess.TimeoutExpired("server", timeout)

    def kill(self):
        self.killed = True


def _popen(children):
    started = []

    def popen(command, *, env):
        child = children[len(started)]
        started.append(child)
        return child
    return popen, started


def _run(boot, children, *, responds=lambda pid: False, updating=lambda: False,
         owned=lambda pid: True, failures=3, grace=0.0):
    popen, started = _popen(children)
    runtime = data_root.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    code = boot.supervise_service(["server"], {}, runtime, interval=0, failures=failures,
                                  grace=grace, responds=responds, updating=updating, owned=owned,
                                  popen=popen)
    return code, started


def test_hung_service_is_killed_after_consecutive_misses_and_restarted(boot):
    hung, fresh = _Child(101), _Child(102, exits_after=0, code=0)
    code, started = _run(boot, [hung, fresh])
    assert code == 0 and started == [hung, fresh] and hung.killed and hung.waits == 3
    [stop] = [e for e in host_lifecycle.read_events() if e["event"] == "stop"]
    assert stop["reason"] == "unresponsive" and stop["pid"] == 101 and stop["source"] == "watchdog"
    assert stop["unresponsive_since"] <= stop["time"]


def test_a_service_that_exits_by_itself_is_not_restarted(boot):
    """正常停止、更新执行器停掉旧版本、崩溃：退出码照旧交回计划任务。"""
    child = _Child(101, exits_after=2, code=3)
    code, started = _run(boot, [child], responds=lambda pid: True)
    assert code == 3 and started == [child] and not child.killed


def test_a_single_answer_resets_the_count(boot):
    answers = iter([False, False, True, False, False, True, False, False, True])
    child = _Child(101, exits_after=9)
    code, _ = _run(boot, [child], responds=lambda pid: next(answers))
    assert code == 0 and not child.killed


def test_no_judging_while_an_update_is_running(boot):
    child = _Child(101, exits_after=10)
    _run(boot, [child], updating=lambda: True)
    assert not child.killed


def test_startup_grace_before_the_first_answer(boot):
    child = _Child(101, exits_after=10)
    _run(boot, [child], grace=3600)
    assert not child.killed


def test_a_process_that_cannot_be_verified_is_left_alone(boot):
    child = _Child(101, exits_after=10)
    _run(boot, [child], owned=lambda pid: False)
    assert not child.killed
    assert not [e for e in host_lifecycle.read_events() if e["event"] == "stop"]


def test_unresponsive_stretch_is_not_counted_as_online(isolated_data_root):
    base = datetime(2026, 11, 19, 0, 0, tzinfo=timezone.utc)
    hour = timedelta(hours=1)
    rows = [
        {"event": "start", "time": base.isoformat(), "previous": "first", "service_mode": True},
        {"event": "stop", "time": (base + 3 * hour).isoformat(), "reason": "unresponsive",
         "pid": 1, "source": "watchdog", "unresponsive_since": (base + hour).isoformat()},
    ]
    path = host_lifecycle.lifecycle_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    summary = gateway_stats.summarize(base, base + 4 * hour, now=base + 5 * hour)
    assert summary["host"]["online_hours"] == 1.0
    assert summary["watchdog"] == {"unresponsive_restarts": 1}


_FAKE_SERVICE = textwrap.dedent('''
    import http.server, json, os, sys, time, uuid
    from pathlib import Path

    runtime = Path(sys.argv[1])
    marker = runtime / "fake-service-ran"
    if marker.exists():
        sys.exit(0)  # 看护重启后的第二个子进程：正常退出，结束用例
    marker.write_text("1")
    instance = uuid.uuid4().hex
    answered = {"n": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            answered["n"] += 1
            if answered["n"] > 2:
                time.sleep(3600)  # 卡住：连接收下、不应答
            body = json.dumps({"service": "game-atelier", "instance_id": instance,
                               "app_version": "test", "protocol": "atelier-local/1"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    (runtime / "server.port").write_text(str(server.server_address[1]))
    (runtime / "server.instance").write_text(instance)
    (runtime / "server.pid").write_text(str(os.getpid()))
    server.serve_forever()
''')


def test_real_hung_service_is_terminated_without_touching_other_processes(boot, tmp_path):
    folder = tmp_path / "viewer_server"
    folder.mkdir()
    script = folder / "fake_service.py"
    script.write_text(_FAKE_SERVICE, encoding="utf-8")
    sibling_script = folder / "sibling.py"
    sibling_script.write_text("import time\ntime.sleep(120)\n", encoding="utf-8")
    # Windows 的 venv python.exe 是转发器（再起一个真解释器），PID 对不上；用基础解释器直接跑脚本。
    python = getattr(sys, "_base_executable", sys.executable)
    runtime = data_root.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    sibling = subprocess.Popen([python, str(sibling_script)])
    started = []

    def popen(command, *, env):
        child = subprocess.Popen(command)
        started.append(child)
        return child

    try:
        code = boot.supervise_service([python, str(script), str(runtime)], {}, runtime,
                                      interval=0.2, timeout=0.3, failures=2, grace=30,
                                      updating=lambda: False, popen=popen)
        assert code == 0 and len(started) == 2
        assert started[0].poll() is not None  # 卡住的那个被结束了
        assert sibling.poll() is None  # 同样带 viewer_server 的旁路进程没被碰
        [stop] = [e for e in host_lifecycle.read_events(runtime) if e["event"] == "stop"]
        assert stop["reason"] == "unresponsive" and stop["pid"] == started[0].pid
    finally:
        sibling.kill()
        sibling.wait(10)
        for child in started:
            if child.poll() is None:
                child.kill()
                child.wait(10)
