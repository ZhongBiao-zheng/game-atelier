"""Detached bundle switch, readiness handshake, and recovery of interrupted switches."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text
from character_workflow.lib.file_lock import try_file_lock
from viewer_server.connection_status import probe_connection_status
from viewer_server.pid import _is_alive, read_instance, read_pid, read_port

VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
UPDATE_ID = re.compile(r"[0-9a-f]{32}\Z")
UPDATE_ENV = "GAME_ATELIER_UPDATE_ID"
ROLLBACK_ENV = "GAME_ATELIER_UPDATE_ROLLBACK_ID"
NORMAL_START_TIMEOUT = 60
SERVICE_START_TIMEOUT = 180
ROLLBACK_TIMEOUT = 180


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


def _pointer(root: Path, name: str) -> str:
    try:
        value = (root / name).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return ""
    return value if VERSION.fullmatch(value) else ""


def _payload(root: Path, version: str) -> Path:
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("更新版本号无效")
    folder = root / "versions" / version
    python = folder / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    entry = folder / "app/scripts/bootstrap.py"
    if (folder.is_symlink() or not python.is_file() or not entry.is_file()
            or not python.resolve().is_relative_to(folder.resolve())
            or not entry.resolve().is_relative_to(folder.resolve())):
        raise ValueError("安装包版本目录不完整")
    if (folder / "VERSION").read_text(encoding="utf-8").strip() != version:
        raise ValueError("安装包版本记录不一致")
    return folder


def pending_update(root: Path) -> dict:
    pending = read_json(root / "updates/pending.json")
    if not UPDATE_ID.fullmatch(str(pending.get("update_id", ""))):
        return {}
    if not all(VERSION.fullmatch(str(pending.get(key, ""))) for key in ("from", "to")):
        return {}
    return pending


def update_running(runtime: Path) -> bool:
    with try_file_lock(runtime / "update.lock") as acquired:
        return not acquired


def start_allowed(runtime: Path) -> bool:
    if not update_running(runtime):
        return True
    app = Path(__file__).resolve().parents[2]
    payload = app.parent
    if payload.parent.name != "versions":
        return False
    pending = pending_update(payload.parent.parent)
    rollback = pending.get("phase") == "rollback"
    expected = pending.get("from") if rollback else pending.get("to")
    return (pending.get("update_id") == os.environ.get(ROLLBACK_ENV if rollback else UPDATE_ENV)
            and expected == payload.name)


def _status(runtime: Path):
    port = read_port(runtime)
    return probe_connection_status(port) if port else None


def _waiting_owner_alive(runtime: Path, pending: dict) -> bool:
    """The drain coordinator lives in the old server, before any executor holds its lock."""
    from viewer_server.pid import is_viewer_server_process
    owner = pending.get("from_instance")
    status = _status(runtime)
    if status is not None and status.instance_id == owner:
        return True
    pid = read_pid(runtime)
    # A temporarily unresponsive server may still be completing a paid request. Unknown
    # command-line access is not evidence that it exited; preserve the drain conservatively.
    return bool(pid is not None and read_instance(runtime) == owner and _is_alive(pid)
                and is_viewer_server_process(pid) is not False)


def _stop(runtime: Path, *, expected_instance: str | None = None) -> None:
    from viewer_server.server import _stop_locked
    with try_file_lock(runtime / "server.start.lock") as acquired:
        if not acquired:
            raise RuntimeError("服务正在启动或停止，请稍后重试")
        if read_pid(runtime) and expected_instance and read_instance(runtime) != expected_instance:
            raise RuntimeError("服务实例已改变，未停止其他实例")
        try:
            _stop_locked(runtime)
        except SystemExit as exc:
            raise RuntimeError("无法安全停止服务") from exc


def _start(root: Path, runtime: Path, version: str, *, service: bool, update_id: str = "") -> None:
    folder = _payload(root, version)
    if service:
        # The scheduler can retain Running briefly after the old child exits. Its next trigger
        # is the recovery mechanism; do not create a service outside the task's process tree.
        try:
            subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                 "Start-ScheduledTask -TaskName GameAtelier"],
                timeout=15, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        return
    python = folder / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    env = {**os.environ, "GAME_ATELIER_DATA_ROOT": str(runtime.parent),
           "PYTHONPATH": str(folder / "app/src"), "PYTHONUTF8": "1"}
    env.pop("VIRTUAL_ENV", None)
    env.pop("UV_PROJECT_ENVIRONMENT", None)
    env.pop(UPDATE_ENV, None)
    env.pop(ROLLBACK_ENV, None)
    command = [str(python), str(folder / "app/scripts/bootstrap.py"), "--select-version"]
    if update_id:
        command += ["--to", version, "--update-id", update_id]
    else:
        command += ["--no-browser"]
    # --select-version for a transaction starts directly without launch()'s stop/restart.
    result = subprocess.run(command, env=env, timeout=40, check=False)
    if result.returncode:
        raise RuntimeError("服务启动命令失败")


def _wait_ready(
    runtime: Path, version: str, *, update_id: str = "", timeout: float, ready: bool = False,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if update_id and (runtime / f"update-start-failed-{update_id}").exists():
            return False
        pid = read_pid(runtime)
        if pid is not None and not _is_alive(pid):
            return False
        status = _status(runtime)
        if status and status.app_version == version and status.instance_id == read_instance(runtime):
            if not update_id:
                return True
            try:
                phase = "ready" if ready else "started"
                reported = (runtime / f"update-{phase}-{update_id}").read_text().strip()
            except OSError:
                reported = ""
            if reported == status.instance_id:
                return True
        time.sleep(0.2)
    return False


def _finish(root: Path, runtime: Path, pending: dict, status: str, reason: str = "") -> None:
    atomic_write_json(runtime / "update-result.json", {
        "update_id": pending["update_id"], "status": status,
        "from": pending["from"], "to": pending["to"], "reason": reason,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    })
    (root / "updates/pending.json").unlink(missing_ok=True)
    (runtime / "maintenance").unlink(missing_ok=True)
    # 结果已落盘，握手文件不再有读者；不清理会每次更新留下三四个。
    for phase in ("started", "activate", "ready", "start-failed"):
        (runtime / f"update-{phase}-{pending['update_id']}").unlink(missing_ok=True)


def _block(root: Path, version: str, reason: str) -> None:
    from viewer_server.bundle_download import block_version
    block_version(root, version, reason)
    atomic_write_json(root / "updates/state.json", {
        "status": "blocked", "to": version, "version": version, "reason": reason,
    })


def apply_update(root: Path, runtime: Path, to: str, update_id: str) -> int:
    """Only mutate the transaction created by the authenticated local controller."""
    with try_file_lock(runtime / "update.lock") as acquired:
        if not acquired:
            return 1
        pending = pending_update(root)
        if pending.get("update_id") != update_id or pending.get("to") != to:
            return 1
        old = pending["from"]
        service = bool(pending.get("service_mode"))
        stopped = False
        try:
            _payload(root, old)
            _payload(root, to)
            if _pointer(root, "last-good") != old:
                raise ValueError("已确认版本发生变化，请重新检查更新")
            for phase in ("started", "activate", "ready", "start-failed"):
                (runtime / f"update-{phase}-{update_id}").unlink(missing_ok=True)
            # Freeze the restart deadline separately from any preceding drain period.
            pending["restart_started_at"] = time.time()
            pending["phase"] = "restarting"
            atomic_write_json(root / "updates/pending.json", pending)
            if service:
                atomic_write_text(root / "current", to + "\n")
            _stop(runtime, expected_instance=pending.get("from_instance"))
            stopped = True
            timeout = SERVICE_START_TIMEOUT if service else NORMAL_START_TIMEOUT
            deadline = time.monotonic() + timeout
            _start(root, runtime, to, service=service, update_id=update_id)
            if not _wait_ready(runtime, to, update_id=update_id,
                               timeout=max(0, deadline - time.monotonic())):
                raise RuntimeError("新版未能在时限内启动")
            # The first handshake proves the new process can listen without modifying user
            # data. Activate its normal lifespan, then require full initialization before
            # moving the durable rollback pointer. Both handshakes share one deadline.
            atomic_write_text(runtime / f"update-activate-{update_id}", update_id)
            if not _wait_ready(runtime, to, update_id=update_id, ready=True,
                               timeout=max(0, deadline - time.monotonic())):
                raise RuntimeError("新版初始化失败或超时")
            atomic_write_text(root / "previous", old + "\n")
            # last-good is the commit point. Recovery recognizes it even if the executor
            # exits before writing the result or removing pending.json.
            atomic_write_text(root / "current", to + "\n")
            atomic_write_text(root / "last-good", to + "\n")
            _finish(root, runtime, pending, "succeeded")
            return 0
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            if _pointer(root, "last-good") == to:
                # The commit point was durable, so recovery must finish this success rather
                # than start an old runtime while last-good already names the new version.
                print("新版已确认，更新结果记录待下次启动恢复。", file=sys.stderr)
                return 0
            reason = str(exc)
            if stopped:
                try:
                    pending["phase"] = "rollback"
                    atomic_write_json(root / "updates/pending.json", pending)
                    atomic_write_text(root / "current", old + "\n")
                    _stop(runtime)
                    _start(root, runtime, old, service=service, update_id=update_id)
                    if not _wait_ready(runtime, old, timeout=ROLLBACK_TIMEOUT):
                        raise RuntimeError("旧版尚未恢复，请双击启动器")
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as rollback:
                    reason += "；" + str(rollback)
            elif _pointer(root, "last-good") == old:
                atomic_write_text(root / "current", old + "\n")
            _block(root, to, reason)
            _finish(root, runtime, pending, "failed", reason)
            return 1


def recover_pending(root: Path, runtime: Path) -> None:
    """A launcher repairs abandoned transactions before selecting a payload."""
    with try_file_lock(runtime / "update.lock") as acquired:
        if not acquired:
            return
        pending = pending_update(root)
        if not pending:
            if (root / "updates/pending.json").exists():
                raise RuntimeError("更新事务记录损坏，未启动未确认的版本")
            (runtime / "maintenance").unlink(missing_ok=True)
            return
        if pending.get("phase") == "waiting":
            if _waiting_owner_alive(runtime, pending):
                raise RuntimeError("正在等待任务完成，请在应用内取消更新后再启动")
            # No payload has been switched and no executor ever stopped the service. End
            # the abandoned drain immediately without blocking a perfectly usable release.
            _finish(root, runtime, pending, "failed", "等待任务期间服务已重启，本次更新已取消")
            return
        if _pointer(root, "last-good") == pending["to"]:
            atomic_write_text(root / "current", pending["to"] + "\n")
            _finish(root, runtime, pending, "succeeded")
            return
        start = pending.get("restart_started_at", pending.get("started_at", 0))
        timeout = SERVICE_START_TIMEOUT if pending.get("service_mode") else NORMAL_START_TIMEOUT
        if not isinstance(start, (int, float)) or time.time() - start < timeout:
            raise RuntimeError("更新启动中，请稍后重试")
        old = _pointer(root, "last-good")
        _payload(root, old)
        # A survivor must be stopped using the same verified PID/instance protocol as normal
        # shutdown. Never overwrite the records while another instance is still alive.
        _stop(runtime)
        atomic_write_text(root / "current", old + "\n")
        reason = "更新执行器已退出，已恢复上一个可用版本"
        _block(root, pending["to"], reason)
        _finish(root, runtime, pending, "failed", reason)


def report_started(instance_id: str) -> None:
    """Called during lifespan; report only once the loopback identity actually responds."""
    from character_workflow.lib import data_root
    update_id = os.environ.get(UPDATE_ENV, "")
    if not UPDATE_ID.fullmatch(update_id):
        return
    runtime = data_root.runtime_dir()
    def report():
        deadline = time.monotonic() + SERVICE_START_TIMEOUT
        while time.monotonic() < deadline:
            status = _status(runtime)
            if status and status.instance_id == instance_id:
                atomic_write_text(runtime / f"update-started-{update_id}", instance_id)
                return
            time.sleep(0.2)
    threading.Thread(target=report, name="bundle-update-report", daemon=True).start()


def cleanup_versions(root: Path) -> None:
    """Only remove old confirmed payloads; preserve staged/ready and executing runtimes."""
    if (root / "updates/pending.json").exists():
        return
    keep = {_pointer(root, name) for name in ("current", "last-good", "previous")}
    state = read_json(root / "updates/state.json")
    keep.add(str(state.get("to", "")))
    # Do not delete an unconfirmed download merely because it is not selected. Only versions
    # strictly older than the previous confirmed version are candidates for cleanup.
    previous = _pointer(root, "previous")
    if not previous:
        return
    cutoff = tuple(map(int, previous.split(".")))
    for folder in (root / "versions").iterdir():
        if (folder.name in keep or not VERSION.fullmatch(folder.name) or folder.is_symlink()
                or tuple(map(int, folder.name.split("."))) >= cutoff
                or Path(sys.executable).resolve().is_relative_to(folder.resolve())):
            continue
        try:
            shutil.rmtree(folder)
        except OSError:
            pass  # Windows may still hold files from a previous task tree; retry next launch.
