"""Install the desktop app, open it, quit it, and check what it left behind.

Exercises the real installed path: runtime download, unpack, launcher, page session, quit -> stop.
Every run uses a throwaway HOME (macOS) or LOCALAPPDATA and data root (Windows, a Chinese path to
exercise every encoding hop). macOS installs from the dmg; Windows unzips the app folder that the
Windows installer (desktop/setup) packages.

The runtime archive this build goes with (--runtime) is served by a local stand-in for the release
sources (GAME_ATELIER_TEST_UPDATE_FEED): an unreleased build has nowhere else to download it from.
First start: a source without the archive and one with another checksum are skipped, the third
serves it. Then: a download killed half-way continues with a Range request; sources that only
offer another build fail without downloading; a runtime without the contract markers and one from
another build are replaced by downloading; an unchanged one is kept; `--quit` stops a running app.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

SESSION_OK = '"POST /api/connection/local-session HTTP/1.1" 200'
DESKTOP_START = re.compile(r'launcher \["--desktop-start"\] -> (-?\d+)')
SHELL_STARTED = "started { port: "
PROBE_OK = "security probe: ok"
REPO = Path(__file__).resolve().parent.parent


class Feed:
    """Release sources on 127.0.0.1: /<mode>/download/v<version>/<asset>[.sha256]. Modes: ok,
    missing (404), badsum (another build's checksum), slow (ok, throttled). Logs every request."""

    def __init__(self, archive: Path, version: str):
        self.data = archive.read_bytes()
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.path = f"download/v{version}/{archive.name}"
        self.log: list[tuple[str, str, str | None]] = []
        feed = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                mode, _, rest = self.path.strip("/").partition("/")
                feed.log.append((mode, rest, self.headers.get("Range")))
                if mode == "missing" or rest not in (feed.path, feed.path + ".sha256"):
                    self.send_response(404)
                    self.end_headers()
                    return
                if rest.endswith(".sha256"):
                    value = "0" * 64 if mode == "badsum" else feed.digest
                    body = f"{value}  {Path(feed.path).name}\n".encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                start = 0
                match = re.fullmatch(r"bytes=(\d+)-", self.headers.get("Range") or "")
                if match:
                    start = int(match[1])
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(feed.data) - 1}/{len(feed.data)}")
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(feed.data) - start))
                self.end_headers()
                chunk = 256 * 1024
                try:
                    for offset in range(start, len(feed.data), chunk):
                        self.wfile.write(feed.data[offset:offset + chunk])
                        if mode == "slow":
                            time.sleep(0.25)  # 1 MiB/s: slow enough to be killed half-way
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def sources(self, *modes: str) -> str:
        return ",".join(f"{self.base}/{mode}" for mode in modes)

    def archive_requests(self, since: int = 0) -> list[tuple[str, str | None]]:
        return [(mode, rng) for mode, rest, rng in self.log[since:] if rest == self.path]


def _expected_build(archive: Path, version: str) -> str:
    sys.path.insert(0, str(REPO / "scripts"))
    import build_desktop
    return build_desktop.runtime_markers(archive, version)["BUILD_ID"]


def _version() -> str:
    return json.loads((REPO / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]


def _fresh(runtime_parent: Path) -> None:
    """No runtime and no download left: the next start has to download."""
    for name in ("GameAtelier", "download"):
        shutil.rmtree(runtime_parent / name, ignore_errors=True)


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


def _start_problems(shell: str) -> list[str]:
    """The shell starts the server with `--desktop-start` and ends up with a verified server.
    The launcher stops waiting for verification after 8 s and exits 1; on a slow machine (first
    start after a runtime replacement) the shell then waits on the server record itself
    (docs/contracts/desktop-shell.md). So the launcher's exit code alone is not the verdict: what
    must follow the last call is the shell's `started` line."""
    calls = list(DESKTOP_START.finditer(shell))
    if not calls:
        return ["the shell did not start the server through --desktop-start"]
    last = calls[-1]
    if SHELL_STARTED not in shell[last.end():]:
        return [f"--desktop-start exited {last[1]} and the shell never verified a server"]
    if last[1] != "0":
        print(f"note: --desktop-start exited {last[1]}; the shell verified the server from its record")
    return []


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
    problems += _start_problems(shell)
    if PROBE_OK not in shell:
        problems.append("the security probe did not pass")
    if "title bar overlay=true" not in shell:
        problems.append("expected title bar overlay=true")
    decided = re.findall(r"runtime replacement: (\w[\w-]*)", shell)
    if decided != ([replacement] if replacement else []):
        problems.append(f"expected runtime replacement {replacement}, the shell logged {decided}")
    return problems


def _relabel_runtime(root: Path, version: str) -> None:
    """Make the unpacked runtime claim another version, as an in-app update would have left it."""
    current = (root / "last-good").read_text(encoding="utf-8").strip()
    (root / "versions" / current).rename(root / "versions" / version)
    for name in ("versions/" + version + "/VERSION", "current", "last-good"):
        (root / name).write_text(version + "\n", encoding="utf-8")


def _runtime_version(root: Path) -> str:
    return (root / "last-good").read_text(encoding="utf-8").strip()


# Higher than any version this build could carry: an in-app update the installer must not undo.
NEWER_RUNTIME = "999.0.0"


def _first_start(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                 data_runtime: Path, feed: Feed) -> list[str]:
    """A source without the archive and one offering another build's checksum are skipped without
    downloading; the third serves this build's runtime."""
    at = len(feed.log)
    env = {**env, "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("missing", "badsum", "ok")}
    problems = _electron_run(executable, env, timeout, runtime_parent, data_runtime, replacement="missing")
    fetched = [mode for mode, _ in feed.archive_requests(at)]
    if fetched != ["ok"]:
        problems.append(f"the archive was requested from {fetched}, expected only the good source")
    if not (runtime_parent / "GameAtelier/last-good").is_file():
        problems.append("the runtime was not unpacked")
    return [f"first start: {p}" for p in problems]


def _second_start(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                  data_runtime: Path, feed: Feed) -> list[str]:
    """Once downloaded and unpacked, the next start downloads nothing (not even a checksum) and goes
    straight in. The runtime's own update check (`/latest`, the same test feed) is not a download."""
    at = len(feed.log)
    problems = _electron_run(executable, env, timeout, runtime_parent, data_runtime, replacement=None)
    downloads = [entry for entry in feed.log[at:] if entry[1].startswith("download/")]
    if downloads:
        problems.append(f"it downloaded again: {downloads}")
    other = [entry for entry in feed.log[at:] if not entry[1].startswith("download/")]
    if other:
        print(f"second start: requests that are not downloads (the runtime's update check): {other}")
    return [f"second start: {p}" for p in problems]


def _resumed_download(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                      data_runtime: Path, feed: Feed) -> list[str]:
    """A download killed half-way continues where it stopped on the next start."""
    _fresh(runtime_parent)
    at = len(feed.log)
    slow = {**env, "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("slow")}
    app = subprocess.Popen([str(executable)], env=slow)
    deadline = time.monotonic() + timeout
    part = None
    while time.monotonic() < deadline:
        part = next((runtime_parent / "download").glob("*.part"), None) if (runtime_parent / "download").is_dir() else None
        if part and part.stat().st_size > 3 * 1024 * 1024:
            break
        time.sleep(0.2)
    app.kill()
    app.wait(timeout=60)
    if not part:
        return ["resumed download: no partial download to kill"]
    kept = part.stat().st_size
    env = {**env, "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("ok")}
    problems = _electron_run(executable, env, timeout, runtime_parent, data_runtime, replacement="missing")
    ranges = [rng for mode, rng in feed.archive_requests(at) if mode == "ok"]
    resumed = [rng for rng in ranges if rng and int(rng[6:-1]) >= kept - 1024 * 1024]
    if not resumed:
        problems.append(f"the second start did not continue the {kept}-byte part (requests: {ranges})")
    print(f"resumed download: killed with {kept} bytes, continued with {ranges}")
    return [f"resumed download: {p}" for p in problems]


def _no_matching_source(executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
                        feed: Feed) -> list[str]:
    """Sources that only offer another build (an unreleased build's version): fail, download nothing."""
    _fresh(runtime_parent)
    at = len(feed.log)
    shell_log = runtime_parent / "shell.log"
    shell_at = _size(shell_log)
    env = {**env, "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("badsum")}
    code = _run(executable, env, timeout)
    shell = _since(shell_log, shell_at)
    problems = []
    if code == 0:
        problems.append("the shell exited 0")
    if "smoke: failed: download" not in shell:
        problems.append("the shell did not show the download failure page")
    if feed.archive_requests(at):
        problems.append("the archive was downloaded anyway")
    if (runtime_parent / "GameAtelier").exists():
        problems.append("a runtime root was left behind")
    return [f"no matching source: {p}" for p in problems]


def _electron_reopens(archive: Path, executable: Path, env: dict[str, str], timeout: int,
                      runtime_parent: Path, data_runtime: Path, feed: Feed) -> list[str]:
    root = runtime_parent / "GameAtelier"
    version = _version()
    build = _expected_build(archive, version)
    payload = root / "versions" / version
    env = {**env, "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("ok")}
    problems: list[str] = []
    # 1. A runtime that does not declare the contract (unpacked by an older shell) is replaced.
    for marker in root.glob("versions/*/DESKTOP_CONTRACT"):
        marker.unlink()
    problems += [f"undeclared runtime: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement="contract")]
    if not (payload / "DESKTOP_CONTRACT").is_file():
        problems.append("undeclared runtime: the marker is still missing after the replacement")
    # 2. The shell's version from another build (an unreleased build reuses the version number).
    (payload / "BUILD_ID").write_text("another-build\n", encoding="utf-8")
    problems += [f"another build: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement="build")]
    if (payload / "BUILD_ID").read_text(encoding="utf-8").strip() != build:
        problems.append("another build: the runtime still carries the other build")
    # 3. Nothing to change: the runtime is kept.
    problems += [f"current runtime: {p}" for p in _electron_run(
        executable, env, timeout, runtime_parent, data_runtime, replacement=None)]
    return problems


def _downloads(archive: Path, executable: Path, env: dict[str, str], timeout: int, runtime_parent: Path,
               data_runtime: Path, feed: Feed) -> list[str]:
    for case in (
        lambda: _first_start(executable, env, timeout, runtime_parent, data_runtime, feed),
        lambda: _second_start(executable, env, timeout, runtime_parent, data_runtime, feed),
        lambda: _electron_reopens(archive, executable, env, timeout, runtime_parent, data_runtime, feed),
        lambda: _resumed_download(executable, env, timeout, runtime_parent, data_runtime, feed),
        lambda: _no_matching_source(executable, env, timeout, runtime_parent, feed),
    ):
        problems = case()
        if problems:
            return problems
    return []


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


def _feed_env(feed: Feed) -> dict[str, str]:
    """The shell downloads from the local feed only when testing is switched on (as the updater)."""
    return {"GAME_ATELIER_TESTING": "1", "GAME_ATELIER_TEST_UPDATE_FEED": feed.sources("ok")}


def smoke_macos(installer: Path, runtime: Path, timeout: int) -> int:
    feed = Feed(runtime, _version())
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    home = work / "home"
    home.mkdir()
    app = install_from_dmg(installer, work)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    env = {**os.environ, "HOME": str(home), "ATELIER_SMOKE": "1", "GAME_ATELIER_NO_UPDATE_CHECK": "1",
           **_feed_env(feed)}
    for name in ("GAME_ATELIER_DATA_ROOT", "ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    runtime_parent = home / "Library/Application Support/game-atelier/runtime"
    data_runtime = home / "game-atelier/.runtime"
    problems = []
    signed = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)],
                            capture_output=True, text=True)
    if signed.returncode != 0:
        problems.append(f"the app bundle is not sealed: {signed.stderr.strip()}")
    if not problems:
        problems += _downloads(runtime, executable, env, timeout, runtime_parent, data_runtime, feed)
    if not problems:
        problems += _quit_request(executable, env, timeout, runtime_parent, data_runtime)
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


def smoke_windows(installer: Path, runtime: Path, timeout: int) -> int:
    feed = Feed(runtime, _version())
    work = Path(tempfile.mkdtemp(prefix="atelier-smoke-")).resolve()
    app = work / "app"
    shutil.unpack_archive(installer, app)
    product = json.loads((Path(__file__).resolve().parent.parent / "desktop/package.json")
                         .read_text(encoding="utf-8"))["productName"]
    executable = app / f"{product}.exe"
    local, data = work / "local", work / "数据目录"
    env = {**os.environ, "LOCALAPPDATA": str(local), "GAME_ATELIER_DATA_ROOT": str(data),
           "ATELIER_SMOKE": "1", "GAME_ATELIER_NO_UPDATE_CHECK": "1", **_feed_env(feed)}
    for name in ("ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    runtime_parent = local / "game-atelier/runtime"
    data_runtime = data / ".runtime"
    problems = _first_start(executable, env, timeout, runtime_parent, data_runtime, feed)
    problems += _unpack_progress(_tail(runtime_parent / "shell.log", 10**7))
    if not problems:
        problems += _second_start(executable, env, timeout, runtime_parent, data_runtime, feed)
    if not problems:
        problems += _electron_reopens(runtime, executable, env, timeout, runtime_parent, data_runtime, feed)
    if not problems:
        problems += _resumed_download(executable, env, timeout, runtime_parent, data_runtime, feed)
    if not problems:
        problems += _no_matching_source(executable, env, timeout, runtime_parent, feed)
    if not problems:
        problems += _quit_request(executable, env, timeout, runtime_parent, data_runtime)
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


def _windows_registration(product: str) -> tuple[bool, bool]:
    """Whether the Settings > Apps entry and the Start menu shortcut exist (the runner's real ones)."""
    import winreg
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                       rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}").Close()
        entry = True
    except OSError:
        entry = False
    return entry, (_programs_dir() / f"{product}.lnk").is_file()


def _programs_dir() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs"


def _shortcut_app_id(link: Path) -> str:
    script = (f"(New-Object -ComObject Shell.Application).NameSpace('{link.parent}')"
              f".ParseName('{link.name}').ExtendedProperty('System.AppUserModel.ID')")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True,
                         text=True, encoding="utf-8", errors="replace", check=False)
    return out.stdout.strip()


def _desktop_dir() -> Path:
    out = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return Path(out.stdout.strip())


def _make_shortcut(link: Path, target: Path) -> None:
    script = (f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{link}'); "
              f"$s.TargetPath = '{target}'; $s.Save()")
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)


EARLIER_PRODUCT = "Atelier"


def _seed_earlier_install(setup: Path, local: Path, product: str, app_id: str) -> Path:
    """What the installer of the app's earlier name left (desktop/setup/src/takeover.rs): its
    folder under LOCALAPPDATA with the app as <earlier>.exe and an uninstall.exe listing its files,
    its Apps entry, Start menu and desktop shortcuts."""
    import winreg
    earlier = local / EARLIER_PRODUCT
    shutil.unpack_archive(setup.with_name(setup.name.replace("-setup.exe", ".zip")), earlier)
    (earlier / f"{product}.exe").rename(earlier / f"{EARLIER_PRODUCT}.exe")
    installed = sorted(p.relative_to(earlier).as_posix() for p in earlier.rglob("*") if p.is_file())
    data = setup.read_bytes()
    (length,) = struct.unpack("<Q", data[-16:-8])
    exe_len = json.loads(data[-16 - length:-16])["exe_len"]
    manifest = json.dumps({"role": "uninstall", "product": EARLIER_PRODUCT, "version": _version(),
                           "main": f"{EARLIER_PRODUCT}.exe", "app_id": app_id, "exe_len": exe_len,
                           "files": [], "installed": [*installed, "uninstall.exe"]}).encode()
    (earlier / "uninstall.exe").write_bytes(
        data[:exe_len] + manifest + struct.pack("<Q", len(manifest)) + data[-8:])
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                          rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{EARLIER_PRODUCT}") as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, EARLIER_PRODUCT)
        winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, _version())
        winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, f'"{earlier}"')
    for folder in (_programs_dir(), _desktop_dir()):
        _make_shortcut(folder / f"{EARLIER_PRODUCT}.lnk", earlier / f"{EARLIER_PRODUCT}.exe")
    return earlier


def _takeover(setup: Path, local: Path, product: str, app_id: str, env: dict[str, str]) -> list[str]:
    """An install over the app's earlier name: one app afterwards, in <LOCALAPPDATA>/<product>,
    the earlier folder, entry and shortcuts gone, the shared runtime untouched."""
    if _windows_registration(EARLIER_PRODUCT) != (False, False):
        return [f"the runner already has {EARLIER_PRODUCT} registered"]
    earlier = _seed_earlier_install(setup, local, product, app_id)
    runtime_marker = local / "game-atelier/runtime/window-theme"
    runtime_marker.parent.mkdir(parents=True, exist_ok=True)
    runtime_marker.write_text("dark", encoding="utf-8")
    problems: list[str] = []
    code, _ = _timed([str(setup), "--silent"], env)
    target = local / product
    if code != 0:
        problems.append(f"takeover install exited {code}")
    if not (target / f"{product}.exe").is_file():
        problems.append(f"takeover did not install into {target}")
    if earlier.exists():
        problems.append(f"takeover left the earlier folder: {sorted(p.name for p in earlier.iterdir())}")
    if _windows_registration(EARLIER_PRODUCT) != (False, False):
        problems.append(f"takeover left the earlier registration: {_windows_registration(EARLIER_PRODUCT)}")
    if (_desktop_dir() / f"{EARLIER_PRODUCT}.lnk").exists():
        problems.append("takeover left the earlier desktop shortcut")
    if _windows_registration(product) != (True, True):
        problems.append(f"takeover registration (Apps entry, Start menu) = {_windows_registration(product)}")
    if not (_desktop_dir() / f"{product}.lnk").is_file():
        problems.append("takeover dropped the desktop shortcut the earlier install had")
    if runtime_marker.read_text(encoding="utf-8") != "dark":
        problems.append("takeover touched the runtime")
    uninstaller = target / "uninstall.exe"
    if uninstaller.is_file():
        subprocess.run([str(uninstaller), "--silent"], env=env, check=False, timeout=300)
        if not _wait_gone(target, 120):
            problems.append("uninstalling after the takeover left its folder")
    return problems


def _timed(command: list[str], env: dict[str, str]) -> tuple[int, float]:
    started = time.monotonic()
    code = subprocess.run(command, env=env, timeout=900, check=False).returncode
    return code, time.monotonic() - started


def smoke_windows_setup(setup: Path, runtime: Path, timeout: int) -> int:
    """The app's installer around the Electron app (desktop/setup): takeover of an install under the
    earlier name → fresh install (no runtime yet) → first start downloads it → install over the running app keeps it → install under a newer
    runtime keeps that too → uninstall. Runtime and data root stay in a throwaway LOCALAPPDATA;
    the Apps entry and Start menu are the runner's real ones."""
    feed = Feed(runtime, _version())
    repo = Path(__file__).resolve().parent.parent
    product = json.loads((repo / "desktop/package.json").read_text(encoding="utf-8"))["productName"]
    app_id = re.search(r"^appId: (\S+)$", (repo / "desktop/electron-builder.yml").read_text(encoding="utf-8"),
                       re.M)[1]
    work = Path(tempfile.mkdtemp(prefix="atelier-setup-")).resolve()
    install_dir, local, data = work / "app", work / "local", work / "数据目录"
    env = {**os.environ, "LOCALAPPDATA": str(local), "GAME_ATELIER_DATA_ROOT": str(data),
           "ATELIER_SMOKE": "1", "GAME_ATELIER_NO_UPDATE_CHECK": "1", **_feed_env(feed)}
    for name in ("ATELIER_RUNTIME_ROOT", "VIRTUAL_ENV"):
        env.pop(name, None)
    quiet = {k: v for k, v in env.items() if k != "ATELIER_SMOKE"}
    runtime_parent, data_runtime = local / "game-atelier/runtime", data / ".runtime"
    executable = install_dir / f"{product}.exe"
    install = [str(setup), "--silent", "--dir", str(install_dir)]
    problems: list[str] = [f"takeover: {p}" for p in _takeover(setup, local, product, app_id, quiet)]

    code, fresh = _timed(install, quiet)
    if code != 0:
        problems.append(f"fresh install exited {code}")
    if (runtime_parent / "GameAtelier").exists():
        problems.append("the installer touched the runtime (the app downloads it on first start)")
    if _windows_registration(product) != (True, True):
        problems.append(f"install registration (Apps entry, Start menu) = {_windows_registration(product)}")
    shortcut_id = _shortcut_app_id(_programs_dir() / f"{product}.lnk")
    if shortcut_id != app_id:
        problems.append(f"Start menu shortcut AppUserModelID {shortcut_id!r}, expected {app_id!r}")
    if not problems:
        problems += [f"first start: {p}" for p in _electron_run(
            executable, env, timeout, runtime_parent, data_runtime, replacement="missing")]

    # Install over the running app: the installer asks it to quit (--quit) and keeps the runtime.
    over = 0.0
    if not problems:
        last_good = (runtime_parent / "GameAtelier/last-good").read_text(encoding="utf-8")
        server_log = data_runtime / "server.log"
        server_at = _size(server_log)
        running = subprocess.Popen([str(executable)], env=quiet)
        deadline = time.monotonic() + timeout
        while SESSION_OK not in _since(server_log, server_at) and time.monotonic() < deadline:
            time.sleep(1)
        code, over = _timed(install, quiet)
        if code != 0:
            problems.append(f"install over the running app exited {code}")
        try:
            running.wait(timeout=60)
        except subprocess.TimeoutExpired:
            running.kill()
            problems.append("the running app did not quit for the install")
        if (runtime_parent / "GameAtelier/last-good").read_text(encoding="utf-8") != last_good:
            problems.append("the install over the same version replaced the runtime")
        problems += [f"start after reinstall: {p}" for p in _electron_run(
            executable, env, timeout, runtime_parent, data_runtime, replacement=None)]

    # An installer of this version under a runtime an in-app update raised: never rolled back.
    root = runtime_parent / "GameAtelier"
    if not problems:
        _relabel_runtime(root, NEWER_RUNTIME)
        code, _ = _timed(install, quiet)
        if code != 0 or _runtime_version(root) != NEWER_RUNTIME:
            problems.append(f"install under a newer runtime: exit {code}, runtime now {_runtime_version(root)}")

    for log in (runtime_parent / "shell.log", data_runtime / "server.log"):
        print(f"--- {log.name}\n{_tail(log)}")
    # The uninstaller copies itself to %TEMP% and returns at once; wait for the folder to go.
    # Started from inside the install folder, as Explorer starts it: the folder must still go.
    subprocess.run([str(install_dir / "uninstall.exe"), "--silent"], env=quiet, check=True,
                   timeout=300, cwd=install_dir)
    if not _wait_gone(install_dir, 120):
        problems.append("uninstall left the install folder")
    if not _wait_gone(runtime_parent, 60):
        problems.append("uninstall left the runtime root")
    if not (data_runtime / "server.log").is_file():
        problems.append("uninstall touched the data root")
    if _windows_registration(product) != (False, False):
        problems.append(f"uninstall left registration behind: {_windows_registration(product)}")
    print(f"installer {setup.stat().st_size / 1024**2:.1f} MiB; fresh install {fresh:.1f} s; "
          f"install over the running app {over:.1f} s")
    if problems:
        print("SETUP SMOKE FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("setup smoke passed")
    return 0


def smoke(installer: Path, runtime: Path, timeout: int) -> int:
    if installer.suffix.lower() == ".zip":
        return smoke_windows(installer, runtime, timeout)
    return smoke_macos(installer, runtime, timeout)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--installer", type=Path, help="dmg, or the zipped Windows app folder")
    target.add_argument("--setup", type=Path, help="Windows: Atelier's own setup.exe")
    parser.add_argument("--runtime", type=Path, required=True,
                        help="the GameAtelier-<version>-<platform> archive this build goes with")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.setup:
        sys.exit(smoke_windows_setup(args.setup, args.runtime, args.timeout))
    sys.exit(smoke(args.installer, args.runtime, args.timeout))
