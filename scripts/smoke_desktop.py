"""Install the desktop app into a throwaway home, open it, quit it, and check what it left behind.

Exercises the real installed path: seed extraction, launcher, WKWebView session, quit → stop.
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


def smoke(installer: Path, timeout: int) -> int:
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    sys.exit(smoke(args.installer, args.timeout))
