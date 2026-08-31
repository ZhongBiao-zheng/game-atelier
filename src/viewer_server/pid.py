"""PID + port file management with stale cleanup (T4).
viewer-server start 时先调 cleanup_stale_pid() 避免端口冲突。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from character_workflow.lib.atomic_io import atomic_write_text


def _pid_path(runtime: Path) -> Path:
    return runtime / "server.pid"


def _port_path(runtime: Path) -> Path:
    return runtime / "server.port"


def _is_alive_windows(pid: int) -> bool:
    """Windows 没有 POSIX signal-0 语义：os.kill(pid, 0) 会去 TerminateProcess，
    在 Win 上报 WinError 11/87 而非"查存在"。改用 OpenProcess 查进程是否存在。
    成功打开=存活；ACCESS_DENIED=存在但无权限=存活；其它(INVALID_PARAMETER 等)=已死。
    """
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    ERROR_ACCESS_DENIED = 5
    STILL_ACTIVE = 259

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return code.value == STILL_ACTIVE  # 已退出的进程 exit code ≠ 259
        return True  # 拿不到退出码，保守当存活
    finally:
        kernel32.CloseHandle(handle)


def _is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _is_alive_windows(pid)
    try:
        os.kill(pid, 0)  # POSIX: signal 0 = check existence only
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


def read_instance(runtime: Path) -> str | None:
    try:
        value = (runtime / "server.instance").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return None
    if len(value) != 32 or any(char not in "0123456789abcdef" for char in value):
        return None
    return value


def write_instance(runtime: Path, instance_id: str) -> None:
    if len(instance_id) != 32 or any(char not in "0123456789abcdef" for char in instance_id):
        raise ValueError("invalid server instance id")
    atomic_write_text(runtime / "server.instance", instance_id)


def cleanup_stale_pid(runtime: Path) -> bool:
    """Remove server.pid if the process is dead. Returns True if cleanup happened."""
    pid = read_pid(runtime)
    if pid is None:
        return False
    if _is_alive(pid):
        return False
    _pid_path(runtime).unlink(missing_ok=True)
    _port_path(runtime).unlink(missing_ok=True)
    (runtime / "server.instance").unlink(missing_ok=True)
    return True
