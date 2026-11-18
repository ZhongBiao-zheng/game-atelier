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


def test_the_atelier_page_gets_only_three_window_commands():
    # docs/contracts/desktop-shell.md: drag, title-bar double click, theme. Nothing else.
    import json
    capabilities = REPO_ROOT / "desktop/src-tauri/capabilities"
    remote = [json.loads(p.read_text(encoding="utf-8")) for p in capabilities.glob("*.json")]
    remote = [c for c in remote if "remote" in c]
    assert len(remote) == 1
    assert remote[0]["remote"] == {"urls": ["http://127.0.0.1:*/*"]}
    assert sorted(remote[0]["permissions"]) == [
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-set-theme",
        "core:window:allow-start-dragging",
    ]


def test_shell_commands_are_declared_so_remote_pages_cannot_reach_them():
    # Undeclared app commands would be callable from any origin a capability lets in.
    build = (REPO_ROOT / "desktop/src-tauri/build.rs").read_text(encoding="utf-8")
    main = (REPO_ROOT / "desktop/src-tauri/src/main.rs").read_text(encoding="utf-8")
    handlers = main.split("generate_handler![", 1)[1].split("]", 1)[0]
    for command in (c.strip() for c in handlers.split(",") if c.strip()):
        assert f'"{command}"' in build, f"{command} is not declared in the app manifest"


# One startup rule, written twice: launch.ps1 (double-click, scheduled task) and the desktop shell
# on Windows (desktop/src-tauri/src/runtime.rs). Changing one without the other must fail here.
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


def _shell_windows_block() -> str:
    source = (REPO_ROOT / "desktop/src-tauri/src/runtime.rs").read_text(encoding="utf-8")
    start = source.index("#[cfg(windows)]\n        let mut cmd = {")
    end = source.index("\n        };", start)
    common = source[end:source.index("\n    }", end)]
    return source[start:end] + common


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


def test_desktop_shell_follows_the_windows_startup_rule():
    rule, block = WINDOWS_STARTUP_RULE, _shell_windows_block()
    join = lambda parts: "payload" + "".join(f'.join("{p}")' for p in parts)  # noqa: E731
    assert f'self.root.join("{rule["pointer"]}")' in block
    assert '.join("versions").join(&version)' in block
    assert f"Command::new({join(rule['interpreter'])})" in block
    assert f"arg({join(rule['entry'])})" in block
    assert f'.env("PYTHONPATH", {join(rule["pythonpath"])})' in block
    assert f'.env("PYTHONUTF8", "{rule["pythonutf8"]}")' in block
    for name in rule["cleared"]:
        assert f'.env_remove("{name}")' in block


def test_windows_installer_uninstaller_and_app_share_one_icon():
    # The stock NSIS icon on the installer and uninstaller reads as pirated software; the app exe
    # (and with it the Apps entry, the shortcuts and the tray) takes the first .ico in bundle.icon.
    import json
    desktop = REPO_ROOT / "desktop"
    bundle = json.loads((desktop / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["bundle"]
    ico = next(icon for icon in bundle["icon"] if icon.endswith(".ico"))
    nsis = bundle["windows"]["nsis"]
    assert nsis["installerIcon"] == ico == nsis["uninstallerIcon"]
    # Windows icons have no macOS safe-area margin: the .ico comes from the full-bleed source.
    script = json.loads((desktop / "package.json").read_text(encoding="utf-8"))["scripts"]["icons"]
    assert f"brand/atelier-icon.svg --output src-tauri/{Path(ico).parent.as_posix()}" in script
