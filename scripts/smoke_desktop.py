"""Install the desktop app, open it, quit it, uninstall it, and check what it left behind.

Exercises the real installed path: seed extraction, launcher, webview session, quit → stop.
macOS runs in a throwaway HOME; Windows installs silently into a temporary folder (the shell reads
%LOCALAPPDATA% through the system API, so the runtime root there is the runner's real one).

macOS (Electron) then reopens the app three times on the same runtime root: with its
DESKTOP_CONTRACT markers removed (it must be replaced from the seed), with the version directory
claiming a different seed build (replaced again), and unchanged (kept). Windows (Tauri until the
Electron switch reaches it) reopens once with the markers removed and must take the old start path.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

SESSION_OK = '"POST /api/connection/local-session HTTP/1.1" 200'
# Tauri (Windows) log lines.
DESKTOP_START = 'launcher ["--desktop-start"] -> Some(0)'
LEGACY_START = 'launcher ["--select-version", "--no-browser"] -> Some(0)'
# Electron (macOS) log lines.
ELECTRON_START = 'launcher ["--desktop-start"] -> 0'
PROBE_OK = "security probe: ok"


def install_from_dmg(dmg: Path, work: Path) -> Path:
    mount = work / "mnt"
    mount.mkdir()
    subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(dmg)],
                   check=True, stdout=subprocess.DEVNULL)
    try:
        source = next(mount.glob("*.app"))
        target = work / "Applications" / source.name
        target.parent.mkdir()
        subprocess.run(["ditto", str(source), str(target)], check=True)
    finally:
        subprocess.run(["hdiutil", "detach", str(mount)], check=False, stdout=subprocess.DEVNULL)
    return target


def _tail(path: Path, limit: int = 6000) -> str:
    return path.read_text(encoding="utf-8", errors="replace")[-limit:] if path.exists() else ""


def _run(executable: Path, env: dict[str, str], timeout: int) -> int | str:
    try:
        return subprocess.run([str(executable)], env=env, timeout=timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        return "timeout"


def _size(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


def _since(path: Path, offset: int) -> str:
    if not path.exists():
        return ""
    with path.open("rb") as handle:
        handle.seek(offset)
        return handle.read().decode("utf-8", errors="replace")


def _start_problems(shell_log: str, *, declared: bool, overlay: bool) -> list[str]:
    """Which start path and title bar the shell chose (docs/contracts/desktop-shell.md)."""
    problems = []
    if declared and DESKTOP_START not in shell_log:
        problems.append("the shell did not start the server through --desktop-start")
    if not declared:
        if "--desktop-start" in shell_log:
            problems.append("the shell called --desktop-start on a runtime that does not declare it")
        if LEGACY_START not in shell_log:
            problems.append("the shell did not start an undeclared runtime through --select-version")
    if f"title bar overlay={str(overlay).lower()}" not in shell_log:
        problems.append(f"expected title bar overlay={str(overlay).lower()}")
    return problems


def _undeclared_run(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                    data_runtime: Path, *, overlay: bool) -> list[str]:
    """Reopen on the same runtime with its DESKTOP_CONTRACT markers removed."""
    markers = list((runtime_parent / "GameAtelier/versions").glob("*/DESKTOP_CONTRACT"))
    if not markers:
        return ["the runtime does not declare DESKTOP_CONTRACT"]
    for marker in markers:
        marker.unlink()
    shell_log, server_log = runtime_parent / "shell.log", data_runtime / "server.log"
    shell_at, server_at = _size(shell_log), _size(server_log)
    code = _run(executable, env, timeout)
    problems = [] if code == 0 else [f"shell exit {code}"]
    if SESSION_OK not in _since(server_log, server_at):
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
    problems += _start_problems(_since(shell_log, shell_at), declared=False, overlay=overlay)
    return [f"undeclared runtime: {p}" for p in problems]


def _electron_run(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                  data_runtime: Path, *, replacement: str | None) -> list[str]:
    """One launch: page session, security probe, quit stops the server, and the expected
    `runtime replacement` decision (None: the runtime must be kept)."""
    shell_log, server_log = runtime_parent / "shell.log", data_runtime / "server.log"
    shell_at, server_at = _size(shell_log), _size(server_log)
    code = _run(executable, env, timeout)
    shell, server = _since(shell_log, shell_at), _since(server_log, server_at)
    problems = [] if code == 0 else [f"shell exit {code}"]
    if SESSION_OK not in server:
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
    if ELECTRON_START not in shell:
        problems.append("the shell did not start the server through --desktop-start")
    if PROBE_OK not in shell:
        problems.append("the security probe did not pass")
    if "title bar overlay=true" not in shell:
        problems.append("expected title bar overlay=true")
    decided = re.findall(r"runtime replacement: (\w[\w-]*)", shell)
    if decided != ([replacement] if replacement else []):
        problems.append(f"expected runtime replacement {replacement}, the shell logged {decided}")
    return problems


def _seed_build(app: Path) -> tuple[str, str]:
    info = json.loads((app / "Contents/Resources/seed/seed.json").read_text(encoding="utf-8"))
    return info["version"], info["build"]


def _electron_reopens(app: Path, executable: Path, env: dict[str, str], timeout: int,
                      runtime_parent: Path, data_runtime: Path) -> list[str]:
    root = runtime_parent / "GameAtelier"
    version, build = _seed_build(app)
    payload = root / "versions" / version
    problems: list[str] = []
    # 1. A runtime that does not declare the contract (unpacked by an older shell) is replaced.
    for marker in root.glob("versions/*/DESKTOP_CONTRACT"):
        marker.unlink()
    problems += [f"undeclared runtime: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement="contract")]
    if not (payload / "DESKTOP_CONTRACT").is_file():
        problems.append("undeclared runtime: the marker is still missing after the replacement")
    # 2. Same version, unpacked from another build of the seed (a reinstalled test package).
    (payload / "BUILD_ID").write_text("stale-build\n", encoding="utf-8")
    (root / "seed.json").write_text(json.dumps({"version": version, "build": "stale-build"}) + "\n",
                                    encoding="utf-8")
    problems += [f"other seed build: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement="build")]
    if (payload / "BUILD_ID").read_text(encoding="utf-8").strip() != build:
        problems.append("other seed build: the runtime still carries the stale build")
    # 3. Nothing to change: the runtime is kept.
    problems += [f"current runtime: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement=None)]
    return problems


def smoke_macos(installer: Path, timeout: int) -> int:
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    home = work / "home"
    home.mkdir()
    app = install_from_dmg(installer, work)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    env = {**os.environ, "HOME": str(home), "ATELIER_SMOKE": "1", "GAME_ATELIER_NO_UPDATE_CHECK": "1"}
    for name in ("GAME_ATELIER_DATA_ROOT", "ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    runtime_parent = home / "Library/Application Support/game-atelier/runtime"
    data_runtime = home / "game-atelier/.runtime"
    problems = []
    signed = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)],
                            capture_output=True, text=True)
    if signed.returncode != 0:
        problems.append(f"the app bundle is not sealed: {signed.stderr.strip()}")
    problems += _electron_run(executable, env, timeout, runtime_parent, data_runtime, replacement="missing")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if not problems:
        problems += _electron_reopens(app, executable, env, timeout, runtime_parent, data_runtime)
    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    if problems:
        print("SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("smoke passed")
    return 0


def _wait_gone(path: Path, seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while path.exists() and time.monotonic() < deadline:
        time.sleep(1)
    return not path.exists()


def _windows_shell_problems(shell_log: str) -> list[str]:
    """What the shell log must show on Windows (docs/contracts/desktop-shell.md)."""
    problems = _start_problems(shell_log, declared=True, overlay=False)
    progress = re.search(r"unpack progress: (\d+) reports, last (\d+)/(\d+)", shell_log)
    if not progress or progress[1] == "0" or progress[2] != progress[3]:
        problems.append("unpack progress did not reach the total entry count")
    return problems


def smoke_windows(installer: Path, timeout: int) -> int:
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    install_dir = work / "app"
    data = work / "数据目录"  # A non-ASCII data root exercises every encoding hop.
    # NSIS: /D must be the last argument and must not be quoted.
    subprocess.run([str(installer), "/S", f"/D={install_dir}"], check=True, timeout=600)
    executable = next(p for p in install_dir.glob("*.exe") if p.name.lower() != "uninstall.exe")
    env = {**os.environ, "GAME_ATELIER_DATA_ROOT": str(data), "ATELIER_SMOKE": "1",
           "GAME_ATELIER_NO_UPDATE_CHECK": "1"}
    for name in ("ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    runtime_parent = Path(os.environ["LOCALAPPDATA"]) / "game-atelier/runtime"
    data_runtime = data / ".runtime"
    code = _run(executable, env, timeout)
    problems = []
    if code != 0:
        problems.append(f"shell exit {code}")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if SESSION_OK not in _tail(data_runtime / "server.log", 10**7):
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
    problems += _windows_shell_problems(_tail(runtime_parent / "shell.log", 10**7))
    if not problems:
        problems += _undeclared_run(executable, env, timeout, runtime_parent, data_runtime,
                                    overlay=False)
    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    # The uninstaller copies itself to %TEMP% and returns at once; wait for the folder to go.
    subprocess.run([str(install_dir / "uninstall.exe"), "/S"], check=True, timeout=300)
    if not _wait_gone(install_dir, 120):
        problems.append("uninstall left the install folder")
    if not _wait_gone(runtime_parent, 60):
        problems.append("uninstall left the runtime root")
    if not (data_runtime / "server.log").is_file():
        problems.append("uninstall touched the data root")
    if problems:
        print("SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("smoke passed")
    return 0


def smoke(installer: Path, timeout: int) -> int:
    if installer.suffix.lower() == ".exe":
        return smoke_windows(installer, timeout)
    return smoke_macos(installer, timeout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    sys.exit(smoke(args.installer, args.timeout))
