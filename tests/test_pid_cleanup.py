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
