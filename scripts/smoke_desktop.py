"""Install the desktop app, open it, quit it, uninstall it, and check what it left behind.

Exercises the real installed path: seed extraction, launcher, webview session, quit → stop.
macOS runs in a throwaway HOME; Windows installs silently into a temporary folder (Tauri reads
%LOCALAPPDATA% through the shell API, so the runtime root there is the runner's real one).
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

SESSION_OK = '"POST /api/connection/local-session HTTP/1.1" 200'


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


def smoke_macos(installer: Path, timeout: int) -> int:
    # Tauri refuses an executable path that contains a symlink on macOS, and /var -> /private/var.
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
    try:
        code: int | str = subprocess.run([str(executable)], env=env, timeout=timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        code = "timeout"
    problems = []
    if code != 0:
        problems.append(f"shell exit {code}")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if SESSION_OK not in _tail(data_runtime / "server.log", 10**7):
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
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
    try:
        code: int | str = subprocess.run([str(executable)], env=env, timeout=timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        code = "timeout"
    problems = []
    if code != 0:
        problems.append(f"shell exit {code}")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if SESSION_OK not in _tail(data_runtime / "server.log", 10**7):
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
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
