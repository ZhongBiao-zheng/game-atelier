"""Contract between the desktop shell and the Python runtime (docs/contracts/desktop-shell.md)."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = REPO_ROOT / "scripts" / "bootstrap.py"


def _isolated_env(home: Path, **overrides: str) -> dict[str, str]:
    """Point every platform's config lookup at `home` (mac: HOME, Linux: XDG, Windows: override)."""
    env = {
        **os.environ,
        "HOME": str(home),
        "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "WIN_PD_OVERRIDE_LOCAL_APPDATA": str(home / "AppData" / "Local"),
        "GAME_ATELIER_DATA_ROOT": "",
    }
    env.update(overrides)
    return env


def _print_data_root(env: dict[str, str]) -> str:
    result = subprocess.run(
        [sys.executable, str(BOOTSTRAP), "--print-data-root"],
        capture_output=True, text=True, encoding="utf-8", env=env, check=True,
    )
    lines = result.stdout.splitlines()
    assert len(lines) == 1, result.stdout
    return lines[0]


def _server_data_root(env: dict[str, str]) -> str:
    """What the running server resolves under the same environment."""
    result = subprocess.run(
        [sys.executable, "-c",
         "from character_workflow.lib.data_root import resolve_data_root; print(resolve_data_root())"],
        capture_output=True, text=True, encoding="utf-8", check=True,
        env={**env, "PYTHONPATH": str(REPO_ROOT / "src")},
    )
    return result.stdout.strip()


def _write_global_config(env: dict[str, str], target: Path) -> None:
    subprocess.run(
        [sys.executable, str(BOOTSTRAP), "--init-data-root", str(target)],
        capture_output=True, text=True, encoding="utf-8", env=env, check=True,
    )


def test_print_data_root_prefers_environment(tmp_path):
    target = tmp_path / "from-env"
    env = _isolated_env(tmp_path / "home", GAME_ATELIER_DATA_ROOT=str(target))
    assert _print_data_root(env) == str(target.resolve())
    assert _print_data_root(env) == _server_data_root(env)


def test_print_data_root_reads_global_config(tmp_path):
    env = _isolated_env(tmp_path / "home")
    target = tmp_path / "chosen"
    _write_global_config(env, target)
    assert _print_data_root(env) == str(target.resolve())
    assert _print_data_root(env) == _server_data_root(env)


def test_print_data_root_falls_back_to_home_default(tmp_path):
    home = tmp_path / "home"
    env = _isolated_env(home)
    assert _print_data_root(env) == str((home / "game-atelier").resolve())
    assert _print_data_root(env) == _server_data_root(env)


def _launcher_with_stub_runtime(tmp_path: Path) -> Path:
    """A fixed launcher whose last-good 'python' only echoes the bootstrap arguments."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_build_release", REPO_ROOT / "scripts/build_release.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    folder = tmp_path / "GameAtelier"
    python = folder / "versions/1.2.3/python/bin/python3"
    python.parent.mkdir(parents=True)
    python.write_text('#!/bin/sh\nshift\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    python.chmod(0o755)
    (folder / "last-good").write_text("1.2.3\n", encoding="utf-8")
    module.write_launchers(folder, windows=False)
    return folder / "启动.command"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX launcher")
def test_launcher_forwards_shell_arguments(tmp_path):
    launcher = _launcher_with_stub_runtime(tmp_path)
    forwarded = subprocess.run(
        [str(launcher), "--select-version", "--no-browser"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    assert forwarded == ["--select-version", "--no-browser"]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX launcher")
def test_launcher_double_click_selects_version(tmp_path):
    launcher = _launcher_with_stub_runtime(tmp_path)
    forwarded = subprocess.run([str(launcher)], capture_output=True, text=True, check=True).stdout.split()
    assert forwarded == ["--select-version"]


def _quarantined(path: Path) -> bool:
    return subprocess.run(["xattr", "-p", "com.apple.quarantine", str(path)],
                          capture_output=True).returncode == 0


def _quarantine(path: Path) -> None:
    subprocess.run(["xattr", "-w", "com.apple.quarantine", "0081;00000000;Test;", str(path)], check=True)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS quarantine attribute")
def test_launcher_clears_quarantine_from_a_downloaded_bundle(tmp_path):
    launcher = _launcher_with_stub_runtime(tmp_path)
    python = launcher.parent / "versions/1.2.3/python/bin/python3"
    other = launcher.parent / "versions/1.2.3/app.txt"
    other.write_text("x", encoding="utf-8")
    _quarantine(python)
    _quarantine(other)
    subprocess.run([str(launcher), "--print-data-root"], capture_output=True, check=True)
    assert not _quarantined(python)
    assert not _quarantined(other)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS quarantine attribute")
def test_launcher_skips_the_tree_walk_once_the_interpreter_is_clear(tmp_path):
    # Walking ~12k files costs about a second on every call; the desktop shell calls the
    # launcher on each start, so the walk only runs while the interpreter is still marked.
    launcher = _launcher_with_stub_runtime(tmp_path)
    marker = launcher.parent / "versions/1.2.3/app.txt"
    marker.write_text("x", encoding="utf-8")
    _quarantine(marker)
    subprocess.run([str(launcher), "--print-data-root"], capture_output=True, check=True)
    assert _quarantined(marker)


ORIGIN = "http://127.0.0.1:5174"


@pytest.fixture
def shell_client(tmp_path):
    from fastapi.testclient import TestClient

    from character_workflow.lib import data_root
    from character_workflow.lib.private_json import read_private_json
    from viewer_server.server_app import build_app

    with TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN) as client:
        control = read_private_json(data_root.runtime_dir() / "shell-control.json")
        assert control["instance_id"] == client.app.state.connection_status.instance_id
        yield client, control["token"]


def test_channel_is_closed_until_the_server_initializes(tmp_path):
    from fastapi.testclient import TestClient

    from viewer_server.server_app import build_app
    client = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    assert client.get("/api/shell/active-work", headers={"Authorization": "Bearer x"}).status_code == 403


def test_active_work_answers_the_control_token(shell_client):
    client, token = shell_client
    response = client.get("/api/shell/active-work", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"jobs", "agents", "approvals", "gateway"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("headers", [
    {},
    {"Authorization": "Bearer wrong"},
    {"Authorization": "Bearer {token}", "Origin": ORIGIN},
    {"Authorization": "Bearer {token}", "Sec-Fetch-Site": "same-origin"},
    {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"},
])
def test_active_work_rejects_everything_but_the_shell(shell_client, headers):
    client, token = shell_client
    headers = {key: value.format(token=token) for key, value in headers.items()}
    response = client.get("/api/shell/active-work", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CAPABILITY_DENIED"


def test_active_work_rejects_a_browser_session(shell_client):
    client, _token = shell_client
    client.headers.update({"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"})
    assert client.post("/api/connection/local-session", json={}).status_code == 200
    assert client.get("/api/shell/active-work").status_code == 403


def test_active_work_is_read_only(shell_client):
    client, token = shell_client
    response = client.post("/api/shell/active-work", json={},
                           headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")
def test_control_file_is_owner_only(shell_client):
    import stat

    from character_workflow.lib import data_root
    mode = (data_root.runtime_dir() / "shell-control.json").stat().st_mode
    assert stat.S_IMODE(mode) == 0o600


# One startup rule, written twice: launch.ps1 (double-click, scheduled task) and the desktop shell
# on Windows (desktop/src/runtime.mjs). Changing one without the other must fail here.
WINDOWS_STARTUP_RULE = {
    "pointer": "last-good",
    "interpreter": ("python", "python.exe"),
    "entry": ("app", "scripts", "bootstrap.py"),
    "pythonpath": ("app", "src"),
    "pythonutf8": "1",
    "cleared": ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"),
}


def _generated_launch_ps1(tmp_path: Path) -> str:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_build_release_ps", REPO_ROOT / "scripts/build_release.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.write_launchers(tmp_path, windows=True)
    return (tmp_path / "launch.ps1").read_text(encoding="utf-8-sig")


def test_launch_ps1_follows_the_windows_startup_rule(tmp_path):
    rule, script = WINDOWS_STARTUP_RULE, _generated_launch_ps1(tmp_path)
    assert f"(Join-Path $PSScriptRoot '{rule['pointer']}')" in script
    assert "('versions\\' + $version)" in script
    for key in ("interpreter", "entry"):
        assert "'" + "\\".join(rule[key]) + "'" in script, key
    assert "$env:PYTHONPATH = Join-Path $runtime '" + "\\".join(rule["pythonpath"]) + "'" in script
    assert f"$env:PYTHONUTF8 = '{rule['pythonutf8']}'" in script
    for name in rule["cleared"]:
        assert f"Remove-Item Env:{name}" in script


def _electron_windows_block() -> str:
    source = (ELECTRON_RUNTIME).read_text(encoding="utf-8")
    start = source.index("  launcher(args) {")
    return source[start:source.index("\n  }\n", start)]


ELECTRON_RUNTIME = REPO_ROOT / "desktop/src/runtime.mjs"


def test_electron_shell_follows_the_windows_startup_rule():
    rule, block = WINDOWS_STARTUP_RULE, _electron_windows_block()
    join = lambda parts: "path.join(payload, " + ", ".join(f"'{p}'" for p in parts) + ")"  # noqa: E731
    assert f"readTrim(path.join(this.root, '{rule['pointer']}'))" in block
    assert "path.join(this.root, 'versions', version)" in block
    assert f"file: {join(rule['interpreter'])}" in block
    assert f"args: [{join(rule['entry'])}, ...args]" in block
    assert f"env.PYTHONPATH = {join(rule['pythonpath'])}" in block
    assert f"env.PYTHONUTF8 = '{rule['pythonutf8']}'" in block
    for name in rule["cleared"]:
        assert f"delete env.{name};" in block


def test_runtime_and_shell_agree_on_the_contract_level():
    """The shell reads versions/<v>/DESKTOP_CONTRACT instead of comparing version numbers."""
    import importlib.util
    import re
    spec = importlib.util.spec_from_file_location(
        "_build_release_contract", REPO_ROOT / "scripts/build_release.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    build = (REPO_ROOT / "scripts/build_release.py").read_text(encoding="utf-8")
    shell = (REPO_ROOT / "desktop/src/runtime.mjs").read_text(encoding="utf-8")
    declared = re.search(r"export const DESKTOP_CONTRACT = (\d+);", shell)
    assert declared and int(declared[1]) == module.DESKTOP_CONTRACT
    assert "const CONTRACT_FILE = 'DESKTOP_CONTRACT';" in shell
    assert '(payload / "DESKTOP_CONTRACT").write_text(f"{DESKTOP_CONTRACT}\\n"' in build


def test_shell_orders_versions_like_bootstrap():
    """The shell compares its own version with the runtime's (desktop/src/runtime.mjs compareVersions:
    contract or too-old); bootstrap.version_key decides updates. The retired line must sort first in both."""
    import importlib.util
    import re
    spec = importlib.util.spec_from_file_location("_bootstrap_versions", BOOTSTRAP)
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    shell = ELECTRON_RUNTIME.read_text(encoding="utf-8")
    declared = re.search(r"const LEGACY_MAJOR = (\d+);", shell)
    assert declared and int(declared[1]) == bootstrap.LEGACY_MAJOR
    assert "parts[0] === LEGACY_MAJOR ? 0 : 1" in shell
    assert bootstrap.version_key("5.139.0") < bootstrap.version_key("0.5.140")


def test_runtime_build_id_is_a_content_digest(tmp_path):
    """Same code, same id; any change under app/ or in the pinned requirements, another id."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("_build_release_id", REPO_ROOT / "scripts/build_release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    payload = tmp_path / "5.139.0"
    (payload / "app/src").mkdir(parents=True)
    (payload / "requirements.txt").write_text("fastapi==1\n", encoding="utf-8")
    (payload / "app/src/a.py").write_text("x = 1\n", encoding="utf-8")
    first = module.build_id(payload)
    assert first == module.build_id(payload)
    (payload / "app/src/a.py").write_text("x = 2\n", encoding="utf-8")
    assert module.build_id(payload) != first
    (payload / "app/src/a.py").write_text("x = 1\n", encoding="utf-8")
    (payload / "requirements.txt").write_text("fastapi==2\n", encoding="utf-8")
    assert module.build_id(payload) != first


ELECTRON = REPO_ROOT / "desktop/src"


def test_preload_exposes_only_the_documented_interfaces():
    # docs/contracts/desktop-shell.md: the Atelier page gets setTheme, openLog and showDownload, the bundled loading page
    # retry, openLog and the runtime download's cancel / resume / importFile, every other page nothing.
    import re
    preload = (ELECTRON / "preload.cjs").read_text(encoding="utf-8")
    exposed = re.findall(r"exposeInMainWorld\('(\w+)', \{(.*?)\n  \}\);", preload, re.S)
    assert [name for name, _ in exposed] == ["atelierShell", "atelierLoading"]
    keys = {name: re.findall(r"^\s+(\w+): ", body, re.M) for name, body in exposed}
    assert keys == {"atelierShell": ["setTheme", "openLog", "showDownload"],
                    "atelierLoading": ["retry", "openLog", "cancel", "resume", "importFile"]}
    assert "protocol === 'http:' && hostname === '127.0.0.1'" in preload
    assert "exposeInMainWorld('ipcRenderer'" not in preload


def test_every_ipc_message_is_checked_against_the_sender_frame():
    import re
    main = (ELECTRON / "main.mjs").read_text(encoding="utf-8")
    # The only ipcMain listener is the checked one.
    assert re.findall(r"ipcMain\.(\w+)\(", main) == ["on"]
    listener = main.split("ipcMain.on(channel, (event, ...args) => {", 1)[1].split("\n  });", 1)[0]
    assert "trustedSender(event.senderFrame, state.win?.webContents.mainFrame, kind, context)" in listener
    assert listener.index("trustedSender") < listener.index("handler(...args)")
    channels = re.findall(r"listen\('([\w:-]+)', '(\w+)'", main)
    assert channels == [("atelier:set-theme", "page"), ("atelier:retry", "local"), ("atelier:open-log", "local"),
                        ("atelier:page-open-log", "page"), ("atelier:show-download", "page"),
                        ("atelier:cancel", "local"), ("atelier:resume", "local"), ("atelier:import", "local")]


def test_electron_pages_run_sandboxed_without_node():
    main = (ELECTRON / "main.mjs").read_text(encoding="utf-8")
    prefs = main.split("function webPreferences() {", 1)[1].split("\n}", 1)[0]
    for setting in ("contextIsolation: true", "nodeIntegration: false", "sandbox: true",
                    "nodeIntegrationInSubFrames: false", "webviewTag: false"):
        assert setting in prefs, setting
    builder = (REPO_ROOT / "desktop/electron-builder.yml").read_text(encoding="utf-8")
    for fuse in ("runAsNode: false", "enableNodeOptionsEnvironmentVariable: false",
                 "enableNodeCliInspectArguments: false", "onlyLoadAppFromAsar: true"):
        assert fuse in builder, fuse


def test_windows_exe_installer_and_uninstaller_share_one_icon():
    # A setup.exe with the stock installer icon reads as pirated software: the Electron exe
    # (electron-builder `win.icon`) and the installer / uninstaller (setup.rc) embed the same file.
    import struct
    builder = (REPO_ROOT / "desktop/electron-builder.yml").read_text(encoding="utf-8")
    assert "  icon: ../assets/brand/atelier.ico" in builder.split("\nwin:", 1)[1]
    assert '1 ICON "../../assets/brand/atelier.ico"' in (REPO_ROOT / "desktop/setup/setup.rc").read_text(
        encoding="utf-8")
    # Full-bleed artwork (no macOS margin) with every size Explorer asks for, 16 to 256.
    data = (REPO_ROOT / "assets/brand/atelier.ico").read_bytes()
    sizes = {data[6 + 16 * i] or 256 for i in range(struct.unpack("<H", data[4:6])[0])}
    assert {16, 24, 32, 48, 64, 128, 256} <= sizes


def test_windows_installer_never_asks_for_administrator_rights():
    # Windows elevates an exe named "*setup*" unless its manifest says asInvoker.
    manifest = (REPO_ROOT / "desktop/setup/setup.exe.manifest").read_text(encoding="utf-8")
    assert 'requestedExecutionLevel level="asInvoker"' in manifest


def test_installer_and_build_script_share_the_payload_format(tmp_path):
    import importlib.util
    import json
    import struct
    spec = importlib.util.spec_from_file_location("_build_desktop", REPO_ROOT / "scripts/build_desktop.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = tmp_path / "win-unpacked"
    (app / "resources").mkdir(parents=True)
    (app / "Cobrush.exe").write_bytes(b"MZ-app")
    (app / "resources/app.asar").write_bytes(b"asar")
    setup, extra = tmp_path / "setup.exe", tmp_path / "boot.exe"
    setup.write_bytes(b"MZ-setup")
    extra.write_bytes(b"MZ-boot")
    target = tmp_path / "out.exe"
    module.write_payload(setup, target, product="Cobrush", version="1.2.3", main="Cobrush.exe",
                         app_id="app.atelier.desktop", app=app, setup_files=[extra])
    data = target.read_bytes()
    source = (REPO_ROOT / "desktop/setup/src/payload.rs").read_text(encoding="utf-8")
    assert f'const MAGIC: &[u8; 8] = b"{module.PAYLOAD_MAGIC.decode()}";' in source
    assert 'pub const SETUP_ONLY: &str = "setup/";' in source
    for field in ("pub main: String", "pub app_id: String", "pub exe_len: u64"):
        assert field in source, field
    assert data.endswith(module.PAYLOAD_MAGIC) and data.startswith(b"MZ-setup")
    (length,) = struct.unpack("<Q", data[-16:-8])
    manifest = json.loads(data[-16 - length:-16])
    assert manifest["role"] == "install" and manifest["main"] == "Cobrush.exe"
    assert manifest["app_id"] == "app.atelier.desktop" and manifest["exe_len"] == len(b"MZ-setup")
    import zlib
    contents = {}
    for e in manifest["files"]:
        stored = data[e["offset"]:e["offset"] + e["size"]]
        contents[e["path"]] = zlib.decompress(stored, -15) if e["codec"] == "deflate" else stored
    assert contents == {"Cobrush.exe": b"MZ-app", "resources/app.asar": b"asar", "setup/boot.exe": b"MZ-boot"}
    codecs = {e["path"]: e["codec"] for e in manifest["files"]}
    assert codecs["Cobrush.exe"] == "deflate" and codecs["setup/boot.exe"] == "store"
    # The installer carries no runtime: the app downloads it on first start.
    assert not any(e["path"].startswith("seed/") for e in manifest["files"])
    assert 'Deflate,' in source and "flate2::read::DeflateDecoder" in source


def _product_name() -> str:
    import json
    return json.loads((REPO_ROOT / "desktop/package.json").read_text(encoding="utf-8"))["productName"]


def _earlier_names() -> tuple[list[str], list[str]]:
    """The earlier product names the Windows installer and the macOS shell each take over."""
    import re
    takeover = (REPO_ROOT / "desktop/setup/src/takeover.rs").read_text(encoding="utf-8")
    shell = (REPO_ROOT / "desktop/src/earlier-app.mjs").read_text(encoding="utf-8")
    rust = re.search(r"pub const EARLIER_PRODUCTS: &\[&str\] = &\[(.*?)\];", takeover, re.S)[1]
    js = re.search(r"export const EARLIER_NAMES = \[(.*?)\];", shell, re.S)[1]
    return re.findall(r'"([^"]+)"', rust), re.findall(r"'([^']+)'", js)


def test_an_install_under_the_earlier_name_is_taken_over():
    # docs/contracts/desktop-shell.md「Windows 安装程序」: the app was installed as Atelier before;
    # an install of the renamed app retires that one instead of sitting next to it.
    rust, js = _earlier_names()
    assert rust == js == ["Atelier"]
    assert _product_name() not in rust
    main = (REPO_ROOT / "desktop/setup/src/main.rs").read_text(encoding="utf-8")
    assert "takeover::find(&product, &main, &app_files)" in main
    assert "takeover::target_dir(" in main
    install = (REPO_ROOT / "desktop/setup/src/install.rs").read_text(encoding="utf-8")
    assert "takeover::retire(earlier, dir, &installed, &exe, &manifest.app_id)" in install
    # Retired only after the new install is registered: a failed install leaves the old one as is.
    assert install.index("register(payload, dir)?;") < install.index("takeover::retire(")


def test_the_takeover_never_runs_the_earlier_uninstaller_or_touches_the_runtime():
    # The earlier uninstaller removes the runtime both installs share (%LOCALAPPDATA%\game-atelier\runtime).
    takeover = (REPO_ROOT / "desktop/setup/src/takeover.rs").read_text(encoding="utf-8")
    code = takeover.split("#[cfg(test)]", 1)[0]
    for forbidden in ("Command", "uninstall(", "remove_dir_all", "remove_dir_with_retry"):
        assert forbidden not in code, forbidden
    # Its uninstaller is only read, for the list of files its installer recorded.
    assert "payload::read_manifest(&dir.join(install::UNINSTALLER))" in code
    assert "&install::runtime_parent()" in code
