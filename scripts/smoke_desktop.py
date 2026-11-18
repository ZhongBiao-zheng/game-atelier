"""Install the desktop app, open it, quit it, and check what it left behind.

Exercises the real installed path: seed extraction, launcher, page session, quit -> stop. Every run
uses a throwaway HOME (macOS) or LOCALAPPDATA and data root (Windows, a Chinese path to exercise
every encoding hop). macOS installs from the dmg; Windows unzips the app folder that the Windows
installer (desktop/setup) packages, with the seed beside the exe.

After the first start the app is reopened on the same runtime root three times: with its
DESKTOP_CONTRACT markers removed (replaced from the seed), with the version directory claiming a
different seed build (replaced again), and unchanged (kept). Then the two installer arguments:
`--prepare-runtime` on an empty runtime root, and `--quit` against a running instance.
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


def _seed_build(seed_dir: Path) -> tuple[str, str]:
    info = json.loads((seed_dir / "seed.json").read_text(encoding="utf-8"))
    return info["version"], info["build"]


def _electron_reopens(seed_dir: Path, executable: Path, env: dict[str, str], timeout: int,
                      runtime_parent: Path, data_runtime: Path) -> list[str]:
    root = runtime_parent / "GameAtelier"
    version, build = _seed_build(seed_dir)
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


def _prepare_runtime(executable: Path, env: dict[str, str], runtime_parent: Path,
                     data_runtime: Path) -> list[str]:
    """--prepare-runtime on an empty runtime root: progress lines, exit code, no window, no server."""
    shutil.rmtree(runtime_parent / "GameAtelier")
    quiet = {k: v for k, v in env.items() if k != "ATELIER_SMOKE"}
    proc = subprocess.run([str(executable), "--prepare-runtime"], env=quiet, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=600, check=False)
    progress = [tuple(map(int, line.split()[1:3])) for line in proc.stdout.splitlines()
                if re.fullmatch(r"progress \d+ \d+", line.strip())]
    problems = []
    if proc.returncode != 0:
        problems.append(f"exit {proc.returncode}: {proc.stderr.strip()[-300:]}")
    if not progress:
        problems.append(f"no progress lines (stdout: {proc.stdout[-300:]!r})")
    elif progress[-1][0] != progress[-1][1] or any(b[0] < a[0] for a, b in zip(progress, progress[1:])):
        problems.append(f"progress did not climb to the total: {progress[:3]} … {progress[-3:]}")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("the runtime was not unpacked")
    if (data_runtime / "server.pid").exists():
        problems.append("it started a server")
    print(f"--prepare-runtime: exit {proc.returncode}, {len(progress)} progress lines, last {progress[-1:] }")
    return [f"--prepare-runtime: {p}" for p in problems]


def _quit_request(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                  data_runtime: Path) -> list[str]:
    """--quit sends a running instance through its normal quit flow (it stops its server)."""
    quiet = {k: v for k, v in env.items() if k != "ATELIER_SMOKE"}
    shell_log, server_log = runtime_parent / "shell.log", data_runtime / "server.log"
    shell_at, server_at = _size(shell_log), _size(server_log)
    app = subprocess.Popen([str(executable)], env=quiet)
    deadline = time.monotonic() + timeout
    while SESSION_OK not in _since(server_log, server_at) and time.monotonic() < deadline:
        time.sleep(1)
    problems = [] if SESSION_OK in _since(server_log, server_at) else ["the app never showed the page"]
    request = subprocess.run([str(executable), "--quit"], env=quiet, timeout=60, check=False)
    if request.returncode != 0:
        problems.append(f"the --quit launch exited {request.returncode}")
    try:
        code = app.wait(timeout=60)
        if code != 0:
            problems.append(f"the running app exited {code}")
    except subprocess.TimeoutExpired:
        app.kill()
        problems.append("the running app did not quit")
    if "quit requested by another launch" not in _since(shell_log, shell_at):
        problems.append("the running app never received the request")
    if (data_runtime / "server.pid").exists():
        problems.append("server records remain after quit")
    nothing = subprocess.run([str(executable), "--quit"], env=quiet, timeout=60, check=False)
    if nothing.returncode != 0:
        problems.append(f"--quit with nothing running exited {nothing.returncode}")
    return [f"--quit: {p}" for p in problems]


def _installer_arguments(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                         data_runtime: Path) -> list[str]:
    problems = _prepare_runtime(executable, env, runtime_parent, data_runtime)
    return problems or _quit_request(executable, env, timeout, runtime_parent, data_runtime)


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
        problems += _electron_reopens(app / "Contents/Resources/seed", executable, env, timeout,
                                      runtime_parent, data_runtime)
    if not problems:
        problems += _installer_arguments(executable, env, timeout, runtime_parent, data_runtime)
    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    if problems:
        print("SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("smoke passed")
    return 0


def _unpack_progress(shell_log: str) -> list[str]:
    """Windows zip extraction reports entries; the last report reaches the total."""
    found = re.search(r"unpack progress: (\d+) reports, last (\d+)/(\d+)", shell_log)
    if not found or found[1] == "0" or found[2] != found[3]:
        return ["unpack progress did not reach the total entry count"]
    return []


def smoke_windows(installer: Path, timeout: int) -> int:
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    app = work / "app"
    shutil.unpack_archive(installer, app)
    product = json.loads((Path(__file__).resolve().parent.parent / "desktop/package.json")
                         .read_text(encoding="utf-8"))["productName"]
    executable = app / f"{product}.exe"
    local, data = work / "local", work / "数据目录"
    env = {**os.environ, "LOCALAPPDATA": str(local), "GAME_ATELIER_DATA_ROOT": str(data),
           "ATELIER_SMOKE": "1", "GAME_ATELIER_NO_UPDATE_CHECK": "1"}
    for name in ("ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    runtime_parent = local / "game-atelier/runtime"
    data_runtime = data / ".runtime"
    problems = _electron_run(executable, env, timeout, runtime_parent, data_runtime, replacement="missing")
    problems += _unpack_progress(_tail(runtime_parent / "shell.log", 10**7))
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("seed was not extracted into the runtime root")
    if not problems:
        problems += _electron_reopens(app / "seed", executable, env, timeout, runtime_parent, data_runtime)
    if not problems:
        problems += _installer_arguments(executable, env, timeout, runtime_parent, data_runtime)
    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    if problems:
        print("SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("smoke passed")
    return 0


def smoke(installer: Path, timeout: int) -> int:
    if installer.suffix.lower() == ".zip":
        return smoke_windows(installer, timeout)
    return smoke_macos(installer, timeout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    sys.exit(smoke(args.installer, args.timeout))
