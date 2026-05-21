"""Viewer server entry — start/stop/open-browser CLI."""
from __future__ import annotations

import os
import platform
import socket
import subprocess
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from skill.viewer_server.pid import (  # noqa: E402
    cleanup_stale_pid, read_pid, read_port, write_pid, write_port,
)


DEFAULT_PORT = 5174


def _find_free_port(start: int) -> int:
    port = start
    while port < start + 100:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    raise RuntimeError(f"No free port in range {start}-{start+100}")


def cmd_start(background: bool = False) -> None:
    runtime = Path(os.environ.get("RUNTIME_DIR", ".runtime"))
    runtime.mkdir(parents=True, exist_ok=True)
    cleanup_stale_pid(runtime)

    existing_pid = read_pid(runtime)
    if existing_pid:
        port = read_port(runtime) or DEFAULT_PORT
        print(f"viewer-server already running (pid={existing_pid}, port={port})")
        return  # 已在运行 — 跳过重启，也不开浏览器

    port = _find_free_port(DEFAULT_PORT)
    write_port(runtime, port)

    if background:
        # 后台启动（Skill 调用路径）：非阻塞，只在首次启动时开浏览器
        import time
        project_root = str(Path(__file__).parent.parent.parent)
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn",
             "skill.viewer_server.server_app:build_app", "--factory",
             "--host", "127.0.0.1", "--port", str(port), "--log-level", "info"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=os.environ.copy(),
        )
        write_pid(runtime, proc.pid)
        print(f"viewer-server started at http://127.0.0.1:{port}/ (pid={proc.pid})")
        time.sleep(1.5)  # 等 uvicorn 就绪
        cmd_open_browser()
    else:
        # 前台启动（终端 A 手动路径）：阻塞直到 Ctrl-C
        write_pid(runtime, os.getpid())
        print(f"viewer-server starting at http://127.0.0.1:{port}/")
        from skill.viewer_server.server_app import build_app  # late import
        uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="info")


def cmd_stop() -> None:
    runtime = Path(os.environ.get("RUNTIME_DIR", ".runtime"))
    pid = read_pid(runtime)
    if not pid:
        print("viewer-server not running")
        return
    try:
        os.kill(pid, 15)  # SIGTERM
        print(f"sent SIGTERM to pid {pid}")
    except ProcessLookupError:
        print(f"pid {pid} not found — cleaning stale PID")
        cleanup_stale_pid(runtime)


def cmd_open_browser() -> None:
    runtime = Path(os.environ.get("RUNTIME_DIR", ".runtime"))
    port = read_port(runtime) or DEFAULT_PORT
    url = f"http://127.0.0.1:{port}/"
    opener = "open" if platform.system() == "Darwin" else "xdg-open"
    subprocess.run([opener, url], check=False)
    print(url)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: server.py {start [--background]|stop|open-browser}")
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "start":
        cmd_start(background="--background" in sys.argv)
    elif cmd == "stop":
        cmd_stop()
    elif cmd == "open-browser":
        cmd_open_browser()
    else:
        print(f"unknown command: {cmd}")
        sys.exit(1)
