"""Install the desktop app, open it, quit it, uninstall it, and check what it left behind.

Exercises the real installed path: seed extraction, launcher, webview session, quit → stop.
macOS runs in a throwaway HOME; Windows installs silently into a temporary folder with Atelier's own
installer (desktop/setup), which also unpacks the runtime; %LOCALAPPDATA% and the Start menu are
the runner's real ones.
"""
from __future__ import annotations

import argparse
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


def _windows_shell_problems(shell_log: str) -> list[str]:
    """What the shell log must show on Windows (docs/contracts/desktop-shell.md)."""
    problems = []
    if 'launcher ["--desktop-start"] -> Some(0)' not in shell_log:
        problems.append("the shell did not start the server through --desktop-start")
    if "title bar overlay=false" not in shell_log:
        problems.append("the window did not keep the system title bar")
    if "menu bar=false" not in shell_log:
        problems.append("the window shows a menu bar")
    progress = re.search(r"unpack progress: (\d+) reports, last (\d+)/(\d+)", shell_log)
    if not progress or progress[1] == "0" or progress[2] != progress[3]:
        problems.append("unpack progress did not reach the total entry count")
    return problems


# The whole primary screen, as the runner's desktop shows it (evidence for reviewers).
_CAPTURE_SCREEN = """
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save($env:ATELIER_CAPTURE)
"""


def _run_windows_shell(executable: Path, env: dict[str, str], timeout: int, server_log: Path,
                       screenshot: Path | None) -> int | str:
    """Run the shell to its smoke quit; capture the window once the page has its session."""
    process = subprocess.Popen([str(executable)], env=env)
    deadline = time.monotonic() + timeout
    while screenshot and process.poll() is None and time.monotonic() < deadline:
        if SESSION_OK in _tail(server_log, 10**7):
            time.sleep(3)  # Let the page paint; the shell quits about 8 s after showing it.
            subprocess.run(["powershell", "-NoProfile", "-Command", _CAPTURE_SCREEN],
                           env={**os.environ, "ATELIER_CAPTURE": str(screenshot.resolve())}, check=False)
            break
        time.sleep(1)
    try:
        return process.wait(timeout=max(deadline - time.monotonic(), 1))
    except subprocess.TimeoutExpired:
        process.kill()
        return "timeout"


def _windows_registration(product: str) -> tuple[bool, bool]:
    """Whether the Settings > Apps entry and the Start menu shortcut exist."""
    import winreg
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                       rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}").Close()
        entry = True
    except OSError:
        entry = False
    programs = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs"
    return entry, (programs / f"{product}.lnk").is_file()


def smoke_windows(installer: Path, timeout: int, screenshot: Path | None = None) -> int:
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    install_dir = work / "app"
    data = work / "数据目录"  # A non-ASCII data root exercises every encoding hop.
    runtime_parent = Path(os.environ["LOCALAPPDATA"]) / "game-atelier/runtime"
    subprocess.run([str(installer), "--silent", "--dir", str(install_dir)], check=True, timeout=600)
    executable = next(p for p in install_dir.glob("*.exe") if p.name.lower() != "uninstall.exe")
    product = executable.stem
    problems = []
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("the installer did not unpack the runtime")
    if _windows_registration(product) != (True, True):
        problems.append(f"install registration (Apps entry, Start menu) = {_windows_registration(product)}")
    env = {**os.environ, "GAME_ATELIER_DATA_ROOT": str(data), "ATELIER_SMOKE": "1",
           "GAME_ATELIER_NO_UPDATE_CHECK": "1"}
    for name in ("ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    data_runtime = data / ".runtime"
    code = _run_windows_shell(executable, env, timeout, data_runtime / "server.log", screenshot)
    if code != 0:
        problems.append(f"shell exit {code}")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if SESSION_OK not in _tail(data_runtime / "server.log", 10**7):
        problems.append("the page never established a local session")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
    problems += _windows_shell_problems(_tail(runtime_parent / "shell.log", 10**7))
    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    # The uninstaller copies itself to %TEMP% and returns at once; wait for the folder to go.
    subprocess.run([str(install_dir / "uninstall.exe"), "--silent"], check=True, timeout=300)
    if not _wait_gone(install_dir, 120):
        problems.append("uninstall left the install folder")
    if not _wait_gone(runtime_parent, 60):
        problems.append("uninstall left the runtime root")
    if not (data_runtime / "server.log").is_file():
        problems.append("uninstall touched the data root")
    if _windows_registration(product) != (False, False):
        problems.append(f"uninstall left registration behind: {_windows_registration(product)}")
    if problems:
        print("SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("smoke passed")
    return 0


def smoke(installer: Path, timeout: int, screenshot: Path | None = None) -> int:
    if installer.suffix.lower() == ".exe":
        return smoke_windows(installer, timeout, screenshot)
    return smoke_macos(installer, timeout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--screenshot", type=Path, help="Windows: save the running window here")
    args = parser.parse_args()
    sys.exit(smoke(args.installer, args.timeout, args.screenshot))
