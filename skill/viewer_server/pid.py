"""PID + port file management with stale cleanup (T4).
viewer-server start 时先调 cleanup_stale_pid() 避免端口冲突。
"""
from __future__ import annotations

import os
from pathlib import Path


def _pid_path(runtime: Path) -> Path:
    return runtime / "server.pid"


def _port_path(runtime: Path) -> Path:
    return runtime / "server.port"


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)  # signal 0 = check existence only
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # process exists, owned by someone else
    return True


def read_pid(runtime: Path) -> int | None:
    p = _pid_path(runtime)
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except ValueError:
        return None


def write_pid(runtime: Path, pid: int) -> None:
    runtime.mkdir(parents=True, exist_ok=True)
    _pid_path(runtime).write_text(str(pid))


def read_port(runtime: Path) -> int | None:
    p = _port_path(runtime)
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except ValueError:
        return None


def write_port(runtime: Path, port: int) -> None:
    runtime.mkdir(parents=True, exist_ok=True)
    _port_path(runtime).write_text(str(port))


def cleanup_stale_pid(runtime: Path) -> bool:
    """Remove server.pid if the process is dead. Returns True if cleanup happened."""
    pid = read_pid(runtime)
    if pid is None:
        return False
    if _is_alive(pid):
        return False
    _pid_path(runtime).unlink(missing_ok=True)
    _port_path(runtime).unlink(missing_ok=True)
    return True
