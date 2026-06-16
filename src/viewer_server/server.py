"""Viewer server entry — start/stop/open-browser CLI."""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).parent.parent))

from character_workflow.lib import data_root  # noqa: E402
from character_workflow.lib import net_env  # noqa: E402
from viewer_server.pid import (  # noqa: E402
    cleanup_stale_pid, read_pid, read_port, write_pid, write_port,
)


DEFAULT_PORT = 5174
_BOOTSTRAP = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap.py"


def _bootstrap_gate(background: bool) -> bool:
    """Check deps before launching uvicorn. Returns True if ready to start.

    needs_uv      → print install command, exit (cannot auto-install uv).
    needs_venv    → foreground: prompt Y/n; background: auto-install.
    other states  → handled by Web onboarding (data-root, keys); pass through.
    """
    # 必须显式 encoding="utf-8"：bootstrap.py 输出 UTF-8 JSON，但 Windows 父进程
    # 默认按 GBK 解码子进程管道，遇中文/特殊字节 reader 线程会抛 UnicodeDecodeError
    # 致 stdout=None，再 json.loads(None) 崩 TypeError。errors="replace" 再兜一层。
    check = subprocess.run(
        [sys.executable, str(_BOOTSTRAP), "--check"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if check.returncode != 0:
        print(f"bootstrap --check failed: {check.stderr}", file=sys.stderr)
        return False
    if not (check.stdout or "").strip():
        print(f"bootstrap --check 无输出，无法判断依赖状态。stderr: {check.stderr}", file=sys.stderr)
        return False
    state = json.loads(check.stdout)
    status = state.get("status")

    if status == "needs_uv":
        print(f"缺少 uv，请先安装：\n  {state['next_action'].removeprefix('安装 uv: ')}")
        return False

    if status == "needs_venv":
        if background:
            print("依赖未安装/已过期，自动运行 bootstrap.py --ensure-venv …")
            ok = _run_ensure_venv()
            if not ok:
                return False
        else:
            print("依赖未安装或已过期 (pyproject.toml 变化)。一键安装？[Y/n] ", end="", flush=True)
            ans = sys.stdin.readline().strip().lower()
            if ans in ("", "y", "yes"):
                ok = _run_ensure_venv()
                if not ok:
                    return False
            else:
                print("已取消。手动安装：uv run python scripts/bootstrap.py --ensure-venv")
                return False

    return True


def _run_ensure_venv() -> bool:
    proc = subprocess.run([sys.executable, str(_BOOTSTRAP), "--ensure-venv"])
    if proc.returncode != 0:
        print(f"bootstrap --ensure-venv 失败 (exit={proc.returncode})", file=sys.stderr)
        return False
    return True


def _spawn_detached(cmd: list[str], *, cwd: str, env: dict[str, str]) -> int:
    """Cross-platform: detach a subprocess so the parent can exit while it keeps running."""
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS  # type: ignore[attr-defined]
        proc = subprocess.Popen(
            cmd, creationflags=flags,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            cwd=cwd, env=env,
        )
    else:
        proc = subprocess.Popen(
            cmd, start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            cwd=cwd, env=env,
        )
    return proc.pid


def _terminate(pid: int) -> bool:
    """Send terminate signal cross-platform. Returns True if signal was delivered."""
    if sys.platform == "win32":
        result = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True,
        )
        return result.returncode == 0
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except ProcessLookupError:
        return False


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


def _server_responds(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config", timeout=0.5):
            return True
    except Exception:
        return False


def _clear_server_files(runtime: Path) -> None:
    (runtime / "server.pid").unlink(missing_ok=True)
    (runtime / "server.port").unlink(missing_ok=True)


def cmd_start(background: bool = False) -> None:
    if not _bootstrap_gate(background):
        sys.exit(1)

    # 国产厂商 host 绕过系统/坏代理（NO_PROXY）：覆盖 Studio 后台出图与 models-preview 等服务端调用。
    net_env.configure_proxy_bypass()

    runtime = data_root.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    cleanup_stale_pid(runtime)

    existing_pid = read_pid(runtime)
    if existing_pid:
        port = read_port(runtime) or DEFAULT_PORT
        if _server_responds(port):
            url = f"http://127.0.0.1:{port}/"
            print(f"工坊已在运行，正在打开浏览器：{url}")
            cmd_open_browser()
            return
        print(f"检测到旧启动记录但端口未响应，重新启动工坊 (pid={existing_pid}, port={port})")
        _clear_server_files(runtime)

    port = _find_free_port(DEFAULT_PORT)
    write_port(runtime, port)

    if background:
        # 后台启动（Skill 调用路径）：非阻塞，只在首次启动时开浏览器
        project_root = str(Path(__file__).parent.parent.parent)
        env = os.environ.copy()
        src_path = str(Path(__file__).parent.parent)
        env["PYTHONPATH"] = (
            f"{src_path}{os.pathsep}{env['PYTHONPATH']}"
            if env.get("PYTHONPATH") else src_path
        )
        pid = _spawn_detached(
            [sys.executable, "-m", "uvicorn",
             "viewer_server.server_app:build_app", "--factory",
             "--host", "127.0.0.1", "--port", str(port), "--log-level", "info"],
            cwd=project_root,
            env=env,
        )
        write_pid(runtime, pid)
        print(f"viewer-server started at http://127.0.0.1:{port}/ (pid={pid})")
        time.sleep(1.5)  # 等 uvicorn 就绪
        cmd_open_browser()
    else:
        # 前台启动（终端 A 手动路径）：阻塞直到 Ctrl-C
        write_pid(runtime, os.getpid())
        print(f"viewer-server starting at http://127.0.0.1:{port}/")
        from viewer_server.server_app import build_app  # late import
        uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="info")


def cmd_stop() -> None:
    runtime = data_root.runtime_dir()
    pid = read_pid(runtime)
    if not pid:
        print("viewer-server not running")
        return
    if _terminate(pid):
        print(f"sent terminate signal to pid {pid}")
    else:
        print(f"pid {pid} not found — cleaning stale PID")
        cleanup_stale_pid(runtime)


def cmd_open_browser() -> None:
    runtime = data_root.runtime_dir()
    port = read_port(runtime) or DEFAULT_PORT
    url = f"http://127.0.0.1:{port}/"
    webbrowser.open(url)
    print(url)


def _force_utf8_stdio() -> None:
    """Windows 控制台默认 GBK；强制 stdout/stderr UTF-8，防中文输出 mojibake / WinError 87。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


if __name__ == "__main__":
    _force_utf8_stdio()
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
