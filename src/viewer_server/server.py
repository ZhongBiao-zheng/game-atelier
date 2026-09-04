"""Viewer server entry — start/stop/open-browser CLI."""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import TYPE_CHECKING

import uvicorn

sys.path.insert(0, str(Path(__file__).parent.parent))

from character_workflow.lib import data_root  # noqa: E402
from character_workflow.lib import net_env  # noqa: E402
from character_workflow.lib.file_lock import try_file_lock  # noqa: E402
from viewer_server.connection_status import (  # noqa: E402
    INSTANCE_ENV, new_instance_id, probe_connection_status,
)
from viewer_server.pid import (  # noqa: E402
    _is_alive, cleanup_stale_pid, read_instance, read_pid, read_port, write_instance, write_pid, write_port,
)


DEFAULT_PORT = 5174
_BOOTSTRAP = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap.py"

if TYPE_CHECKING:
    from fastapi import FastAPI


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
            # 刚停掉的服务留下的 TIME_WAIT 会让裸 bind 失败，把端口一路推到 5175/5176；uvicorn 自己
            # 带 SO_REUSEADDR 能绑上，探测要用同样的口径。Windows 上这个选项会放行抢占正在监听的端口，不开。
            if sys.platform != "win32":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    raise RuntimeError(f"No free port in range {start}-{start+100}")


def _server_responds(port: int, instance_id: str | None) -> bool:
    if instance_id is None:
        return False
    status = probe_connection_status(port)
    return status is not None and status.instance_id == instance_id


STOP_TIMEOUT_SECONDS = 20.0


def _wait_for_exit(pid: int, *, timeout: float = STOP_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _is_alive(pid):
            return True
        time.sleep(0.2)
    return False


def _wait_for_server(port: int, instance_id: str, *, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _server_responds(port, instance_id):
            return True
        time.sleep(0.2)
    return False


def cmd_start(background: bool = False) -> None:
    if not _bootstrap_gate(background):
        sys.exit(1)

    # 国产厂商 host 绕过系统/坏代理（NO_PROXY）：覆盖 Studio 后台出图与 models-preview 等服务端调用。
    net_env.configure_proxy_bypass()

    runtime = data_root.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    # Two launchers must not overwrite each other's PID/port/instance before either server is ready.
    with try_file_lock(runtime / "server.start.lock") as acquired:
        if not acquired:
            print("工坊正在启动或停止，请稍后重试。", file=sys.stderr)
            sys.exit(1)
        foreground = _start_locked(runtime, background=background)
    if foreground is not None:
        app, port = foreground
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def _start_locked(runtime: Path, *, background: bool) -> tuple[FastAPI, int] | None:
    cleanup_stale_pid(runtime)

    existing_pid = read_pid(runtime)
    if existing_pid:
        port = read_port(runtime) or DEFAULT_PORT
        if _server_responds(port, read_instance(runtime)):
            url = f"http://127.0.0.1:{port}/"
            print(f"工坊已在运行，正在打开浏览器：{url}")
            cmd_open_browser()
            return None
        # A living but unverified process may still be generating. Never start another writer.
        if read_instance(runtime) is None:
            # Trigger: 记录来自不写 server.instance 的旧版本，升级后老服务还在跑
            # Why: 旧服务没有 /api/connection/status，永远验不过；用户唯一出口就是这里的 stop
            # Outcome: 指到可执行的 stop，由 stop 按 legacy 规则终止记录里的 PID
            print(
                f"旧版本工坊仍在运行（pid={existing_pid}）。"
                "请先执行 `stop` 子命令停止它，再重新启动。未覆盖记录或启动第二个服务。",
                file=sys.stderr,
            )
        else:
            print(
                "已有存活的工坊启动记录，但无法验证运行实例。"
                "请检查原启动终端，从原入口正常停止后再启动。未覆盖记录或启动第二个服务。",
                file=sys.stderr,
            )
        sys.exit(1)

    port = _find_free_port(DEFAULT_PORT)
    instance_id = new_instance_id()
    write_port(runtime, port)
    write_instance(runtime, instance_id)

    if background:
        # 后台启动（Skill 调用路径）：非阻塞，只在首次启动时开浏览器
        project_root = str(Path(__file__).parent.parent.parent)
        env = os.environ.copy()
        env[INSTANCE_ENV] = instance_id
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
        if not _wait_for_server(port, instance_id):
            print(
                "工坊启动后尚未通过实例验证，未打开浏览器。"
                "请检查服务启动情况；再次启动不会另开第二个服务。",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"viewer-server started at http://127.0.0.1:{port}/ (pid={pid})")
        cmd_open_browser()
        return None
    else:
        # 前台启动（终端 A 手动路径）：阻塞直到 Ctrl-C
        write_pid(runtime, os.getpid())
        print(f"viewer-server starting at http://127.0.0.1:{port}/")
        from viewer_server.server_app import build_app  # late import
        return build_app(instance_id=instance_id), port


def cmd_stop() -> None:
    runtime = data_root.runtime_dir()
    with try_file_lock(runtime / "server.start.lock") as acquired:
        if not acquired:
            print("工坊正在启动或停止，请稍后重试。", file=sys.stderr)
            sys.exit(1)
        cleanup_stale_pid(runtime)
        pid = read_pid(runtime)
        if not pid:
            print("viewer-server not running")
            return
        port = read_port(runtime) or DEFAULT_PORT
        instance_id = read_instance(runtime)
        # 没有 instance 记录 = 旧版本写下的 PID，无法用实例验证；这条记录是本启动器自己写的，照旧发停止信号。
        # 有 instance 记录却验不过 = 端口上是别的服务，绝不碰记录里的 PID。
        if instance_id is not None and not _server_responds(port, instance_id):
            print("无法验证运行实例，未向该 PID 发送停止信号。请检查原启动终端。", file=sys.stderr)
            sys.exit(1)
        if not _terminate(pid):
            print(f"pid {pid} not found — cleaning stale PID")
            cleanup_stale_pid(runtime)
            return
        print(f"sent terminate signal to pid {pid}")
        # 一键启动脚本是 stop 紧接 start：不等进程真正退出，start 会读到「还活着但已不应答」的
        # 记录并拒绝启动。等到退出再清记录，start 才能干净接手。
        if _wait_for_exit(pid):
            cleanup_stale_pid(runtime)
            return
        print(
            f"pid {pid} 在 {STOP_TIMEOUT_SECONDS:.0f} 秒内没有退出（可能还在收尾出图任务），"
            "启动记录保留；等它退出后再启动。",
            file=sys.stderr,
        )
        sys.exit(1)


def cmd_open_browser() -> None:
    runtime = data_root.runtime_dir()
    port = read_port(runtime) or DEFAULT_PORT
    if not _server_responds(port, read_instance(runtime)):
        print("无法验证本机工坊，未打开浏览器。请先启动服务。", file=sys.stderr)
        sys.exit(1)
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
