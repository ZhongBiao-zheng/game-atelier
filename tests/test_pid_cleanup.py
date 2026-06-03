import os

import pytest

from viewer_server.pid import (
    cleanup_stale_pid, read_pid, read_port, write_pid, write_port, _is_alive,
)


@pytest.fixture
def runtime(tmp_path):
    return tmp_path


def test_cleanup_when_no_pid_file_noop(runtime):
    cleanup_stale_pid(runtime)
    assert not (runtime / "server.pid").exists()


def test_cleanup_removes_dead_pid(runtime):
    (runtime / "server.pid").write_text("999999")  # impossibly high pid
    cleanup_stale_pid(runtime)
    assert not (runtime / "server.pid").exists()


def test_cleanup_keeps_alive_pid(runtime):
    write_pid(runtime, os.getpid())
    cleanup_stale_pid(runtime)
    assert read_pid(runtime) == os.getpid()


def test_port_roundtrip(runtime):
    write_port(runtime, 5174)
    assert read_port(runtime) == 5174


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
