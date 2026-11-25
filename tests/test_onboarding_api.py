import os

import pytest
from tests.local_client import LocalTestClient as TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


def test_onboarding_status_returns_bootstrap_check_payload(client):
    resp = client.get("/api/onboarding/status")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["status"] in (
        "needs_data_root", "needs_uv", "needs_venv",
        "needs_first_key", "needs_keys_repair", "ready",
    )
    assert "platform" in data


def test_post_data_root_writes_global_config(client, tmp_path, monkeypatch):
    # 目标已是 Atelier 数据目录（有 .config/）→ 直接切换指针，不复制。
    new_root = tmp_path / "switched-root"
    (new_root / ".config").mkdir(parents=True)
    cfg_file = tmp_path / "cfg" / "data-root"
    from character_workflow.lib import data_root as data_root_module

    monkeypatch.setattr(data_root_module, "_global_config_file", lambda: cfg_file)
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", os.environ["GAME_ATELIER_DATA_ROOT"])
    resp = client.post("/api/data-root", json={"path": str(new_root)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data_root"] == str(new_root.resolve())
    assert body["move"]["phase"] == "done"
    assert cfg_file.read_text(encoding="utf-8").strip() == str(new_root.resolve())
    assert os.environ["GAME_ATELIER_DATA_ROOT"] == str(new_root.resolve())


def test_post_data_root_validates_payload(client):
    resp = client.post("/api/data-root", json={})
    assert resp.status_code == 422


def _fake_applet(monkeypatch, *, chosen: str | None = None, error: str | None = None):
    """Stand in for the LaunchServices applet: record its source, write what the user picked."""
    sources = []

    def run(source, work):
        sources.append(source)
        if chosen is not None:
            (work / "chosen.txt").write_text(chosen, encoding="utf-8")
        if error is not None:
            (work / "error.txt").write_text(error, encoding="utf-8")

    monkeypatch.setattr("viewer_server.routes.sys.platform", "darwin")
    monkeypatch.setattr("viewer_server.routes._run_folder_applet", run)
    return sources


def test_folder_picker_returns_selected_path(client, tmp_path, monkeypatch):
    picked = tmp_path / "picked"
    picked.mkdir()
    sources = _fake_applet(monkeypatch, chosen=f"{picked}/")
    resp = client.post("/api/folder-picker", json={"title": "选择项目文件夹", "initial_path": str(tmp_path)})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": str(picked.resolve())}
    # The applet activates itself before asking, so the dialog takes keyboard focus.
    assert sources[0].startswith("activate\n")
    from viewer_server.routes import _osascript_string
    expected = f'choose folder with prompt "选择项目文件夹" default location POSIX file {_osascript_string(str(tmp_path))}'
    assert expected in sources[0]


def test_folder_picker_cancel_returns_null(client, monkeypatch):
    _fake_applet(monkeypatch)
    resp = client.post("/api/folder-picker", json={})
    assert resp.status_code == 200
    assert resp.json() == {"path": None}


def test_folder_picker_macos_error_is_reported(client, monkeypatch):
    _fake_applet(monkeypatch, error="权限不足")
    resp = client.post("/api/folder-picker", json={})
    assert resp.status_code == 500
    assert "权限不足" in resp.json()["detail"]


def test_folder_applet_is_compiled_then_opened_through_launch_services(tmp_path, monkeypatch):
    from viewer_server import routes
    calls = []

    class Result:
        returncode = 0
        stderr = ""

    monkeypatch.setattr(routes.subprocess, "run", lambda argv, **_: calls.append(argv) or Result())
    routes._run_folder_applet("activate", tmp_path)
    applet = str(tmp_path / routes._FOLDER_APPLET)
    assert calls == [["osacompile", "-o", applet, str(tmp_path / "picker.applescript")],
                     ["open", "-W", "-n", applet]]


def test_folder_picker_windows_returns_selected_path(client, tmp_path, monkeypatch):
    picked = tmp_path / "win-picked"
    picked.mkdir()
    calls = {}

    class Result:
        returncode = 0
        stdout = str(picked)
        stderr = ""

    def fake_run(cmd, **kwargs):
        calls["cmd"] = cmd
        calls["kwargs"] = kwargs
        return Result()

    monkeypatch.setattr("viewer_server.routes.sys.platform", "win32")
    monkeypatch.setattr("viewer_server.routes.subprocess.run", fake_run)

    resp = client.post("/api/folder-picker", json={"title": "选择项目文件夹"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": str(picked.resolve())}
    # 走 powershell + STA + UTF-8 解码
    assert calls["cmd"][0] == "powershell"
    assert "-STA" in calls["cmd"]
    assert calls["kwargs"].get("encoding") == "utf-8"


def test_folder_picker_windows_cancel_returns_null(client, monkeypatch):
    class Result:
        returncode = 0
        stdout = ""  # 取消时不写 stdout
        stderr = ""

    monkeypatch.setattr("viewer_server.routes.sys.platform", "win32")
    monkeypatch.setattr("viewer_server.routes.subprocess.run", lambda *_, **__: Result())

    resp = client.post("/api/folder-picker", json={"title": "选择项目文件夹"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": None}


def test_folder_picker_unsupported_platform_501(client, monkeypatch):
    monkeypatch.setattr("viewer_server.routes.sys.platform", "linux")
    resp = client.post("/api/folder-picker", json={"title": "选择项目文件夹"})
    assert resp.status_code == 501


# Silence unused import warning when running this file standalone.
_ = os
