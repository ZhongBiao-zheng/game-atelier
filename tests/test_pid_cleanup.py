import os

import pytest

from viewer_server.pid import (
    cleanup_stale_pid, read_instance, read_pid, read_port,
    write_instance, write_pid, write_port, _is_alive,
)


@pytest.fixture(autouse=True)
def _records_belong_to_viewer_server(request, monkeypatch):
    """既有用例用 os.getpid()（pytest 自身）冒充存活的服务进程，按命令行核对会被判成别人的进程。"""
    import viewer_server.pid as pidmod

    if "is_viewer_server_process" in request.function.__name__:
        return  # 直接测核对函数本身的用例不打桩
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: True)


@pytest.fixture
def runtime(tmp_path):
    return tmp_path


def test_cleanup_when_no_pid_file_noop(runtime):
    cleanup_stale_pid(runtime)
    assert not (runtime / "server.pid").exists()


def test_cleanup_removes_dead_pid(runtime):
    (runtime / "server.pid").write_text("999999")  # impossibly high pid
    write_instance(runtime, "a" * 32)
    cleanup_stale_pid(runtime)
    assert not (runtime / "server.pid").exists()
    assert read_instance(runtime) is None


def test_cleanup_keeps_alive_pid(runtime):
    write_pid(runtime, os.getpid())
    cleanup_stale_pid(runtime)
    assert read_pid(runtime) == os.getpid()


def test_port_roundtrip(runtime):
    write_port(runtime, 5174)
    assert read_port(runtime) == 5174


def test_instance_roundtrip_and_invalid_record(runtime):
    assert read_instance(runtime) is None
    write_instance(runtime, "a" * 32)
    assert read_instance(runtime) == "a" * 32
    (runtime / "server.instance").write_bytes(b"\xff")
    assert read_instance(runtime) is None
    (runtime / "server.instance").write_text("not-an-id")
    assert read_instance(runtime) is None
    with pytest.raises(ValueError):
        write_instance(runtime, "../other")


def test_read_pid_missing_returns_none(runtime):
    assert read_pid(runtime) is None


def test_is_alive_current_process(runtime):
    assert _is_alive(os.getpid()) is True
    assert _is_alive(999999) is False


def test_is_alive_on_win32_never_calls_os_kill(monkeypatch):
    """Windows 上 os.kill(pid, 0) 不是查存在（会 TerminateProcess，报 WinError 11）。

    _is_alive 必须在 win32 走 OpenProcess 分支，绝不碰 os.kill。
    """
    import viewer_server.pid as pidmod

    monkeypatch.setattr(pidmod.sys, "platform", "win32")
    monkeypatch.setattr(pidmod, "_is_alive_windows", lambda pid: pid == 4321)

    def _boom(*_a, **_k):
        raise AssertionError("os.kill 不能在 win32 上被调用")

    monkeypatch.setattr(pidmod.os, "kill", _boom)

    assert pidmod._is_alive(4321) is True
    assert pidmod._is_alive(1) is False
    assert pidmod._is_alive(0) is False  # 非法 pid 提前返回，连 windows 分支都不进


def test_cleanup_removes_alive_pid_that_is_not_viewer_server(runtime, monkeypatch):
    """Windows 重启后 PID 被无关进程复用：存活但不是自家服务，记录按过期清掉。"""
    import viewer_server.pid as pidmod

    write_pid(runtime, os.getpid())
    write_port(runtime, 5174)
    write_instance(runtime, "a" * 32)
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: False)
    assert cleanup_stale_pid(runtime) is True
    assert read_pid(runtime) is None
    assert read_port(runtime) is None
    assert read_instance(runtime) is None


def test_cleanup_keeps_alive_pid_when_command_line_unreadable(runtime, monkeypatch):
    import viewer_server.pid as pidmod

    write_pid(runtime, os.getpid())
    monkeypatch.setattr(pidmod, "is_viewer_server_process", lambda pid: None)
    assert cleanup_stale_pid(runtime) is False
    assert read_pid(runtime) == os.getpid()


def test_is_viewer_server_process_matches_both_launch_forms(monkeypatch):
    import viewer_server.pid as pidmod

    lines = {
        1: r"C:\x\python.exe -m uvicorn viewer_server.server_app:build_app --factory --port 5174",
        2: r"C:\x\python.exe src\viewer_server\server.py start",
        3: "/usr/bin/python3 -m pytest tests",
        4: None,
    }
    monkeypatch.setattr(pidmod, "process_command_line", lambda pid: lines[pid])
    assert pidmod.is_viewer_server_process(1) is True
    assert pidmod.is_viewer_server_process(2) is True
    assert pidmod.is_viewer_server_process(3) is False
    assert pidmod.is_viewer_server_process(4) is None


def test_process_command_line_reads_current_process_and_none_for_dead_pid():
    from viewer_server.pid import process_command_line

    line = process_command_line(os.getpid())
    assert line and "py" in line.lower()
    assert process_command_line(999999) is None
