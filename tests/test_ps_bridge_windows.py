"""PS 联动第 3 批：Windows 执行器。CI 不碰真实 Photoshop，COM 换成假实现，任何平台都能跑。"""
from __future__ import annotations

import importlib
import json
import threading
from pathlib import Path

import pytest

from character_workflow.lib import plugin_registry, plugin_server

PLUGIN_ID = "ps-bridge"


class FakeComError(Exception):
    """形状同 pywintypes.com_error：args[0] 是 hresult。"""


class FakeApp:
    def __init__(self, result_text: str | None = '{"ok": true}', error: BaseException | None = None,
                 gate: threading.Event | None = None) -> None:
        self.result_text, self.error, self.gate = result_text, error, gate
        self.calls: list[tuple[str, list, int]] = []

    def DoJavaScript(self, code: str, arguments: list, mode: int):  # noqa: N802 —— COM 方法名
        self.calls.append((code, arguments, mode))
        if self.gate is not None:
            self.gate.wait(5)  # 模拟 PS 弹着对话框；用例里一定会 set
        if self.error is not None:
            raise self.error
        config = json.loads(Path(arguments[0]).read_text(encoding="utf-8"))
        if self.result_text is not None:
            Path(config["result"]).write_text(self.result_text, encoding="utf-8")
        return ""


@pytest.fixture
def win(isolated_data_root):
    plugin_registry.set_enabled(PLUGIN_ID, True)
    record = plugin_registry.find(PLUGIN_ID)
    plugin_server._api(record)
    yield importlib.import_module(f"{plugin_server._module_name(PLUGIN_ID)}.executor_windows")
    plugin_server.unload(PLUGIN_ID)


def make(win, app=None, session: int = 1, running: bool = True):
    def connect():
        if not running:
            raise win.NotRunning()
        return app
    return win.WindowsExecutor(connect=connect, session_id=lambda: session, installed=lambda: True)


def request(tmp_path: Path, name: str = "请求") -> tuple[Path, dict]:
    directory = tmp_path / name
    directory.mkdir()
    return directory, {"action": "version", "result": str(directory / "result.json"),
                       "cancel": str(directory / "cancelled"), "out_png": str(directory / "export.png"),
                       "scope": "document"}


def wait_unstuck(executor, gate: threading.Event) -> None:
    gate.set()
    tick = threading.Event()
    for _ in range(500):
        if not executor._stuck.is_set():
            return
        tick.wait(0.01)
    raise AssertionError("工作线程没有返回")


def test_not_running_is_reported_without_launching(win, tmp_path):
    executor = make(win, running=False)
    assert executor.running() is False
    with pytest.raises(win.bridge.PsError) as error:
        executor.call(*request(tmp_path), 5)
    assert error.value.code == "PS_NOT_RUNNING"


def test_paths_reach_extendscript_with_forward_slashes(win, tmp_path):
    app = FakeApp()
    directory, config = request(tmp_path)
    assert make(win, app).call(directory, config, 5) == {"ok": True}
    code, arguments, mode = app.calls[0]
    config_arg = (directory / "config.json").as_posix()
    assert mode == 1 and "\\" not in code.replace("\\u", "")
    assert code.startswith("var ATELIER_CONFIG_PATH = ") and "$.evalFile(new File(" in code
    assert json.loads(code.split("=", 1)[1].split(";", 1)[0]) == config_arg
    assert arguments == [config_arg]
    raw = (directory / "config.json").read_text(encoding="utf-8")
    written = json.loads(raw)
    assert all(written[key] == Path(config[key]).as_posix() for key in ("result", "cancel", "out_png"))
    assert written["scope"] == "document"
    assert raw.isascii() and "\\u" in raw, "中文路径以 \\uXXXX 写出"


@pytest.mark.parametrize("hresult", [-2147418111, -2147417846])
def test_busy_hresults_cancel_and_say_photoshop_is_busy(win, tmp_path, hresult):
    directory, config = request(tmp_path)
    with pytest.raises(win.bridge.PsError) as error:
        make(win, FakeApp(error=FakeComError(hresult, "rejected", None, None))).call(directory, config, 5)
    assert error.value.code == "PS_BUSY"
    assert (directory / "cancelled").exists()


def test_other_com_errors_are_failures(win, tmp_path):
    directory, config = request(tmp_path)
    with pytest.raises(win.bridge.PsError) as error:
        make(win, FakeApp(error=FakeComError(-2147352567, "脚本错误", None, None))).call(directory, config, 5)
    assert error.value.code == "PS_FAILED" and not (directory / "cancelled").exists()


def test_a_hung_call_times_out_and_blocks_until_it_returns(win, tmp_path):
    gate = threading.Event()
    executor = make(win, FakeApp(gate=gate))
    directory, config = request(tmp_path)
    with pytest.raises(win.bridge.PsError) as first:
        executor.call(directory, config, 0.05)
    assert first.value.code == "PS_BUSY" and (directory / "cancelled").exists()
    with pytest.raises(win.bridge.PsError) as second:
        executor.call(*request(tmp_path, "再来"), 5)
    assert second.value.code == "PS_BUSY", "上一个调用还挂着时不再进 COM"
    wait_unstuck(executor, gate)
    executor._connect = lambda: FakeApp()
    assert executor.call(*request(tmp_path, "之后"), 5) == {"ok": True}, "线程返回后清掉卡住标记"


def test_service_session_is_unsupported_and_never_touches_com(win, tmp_path):
    app = FakeApp()
    executor = make(win, app, session=0)
    assert executor.running() is False
    assert executor.unsupported_reason() == win.SERVICE_SESSION
    with pytest.raises(win.bridge.PsError) as error:
        executor.call(*request(tmp_path), 5)
    assert error.value.code == "PS_UNSUPPORTED" and error.value.message == win.SERVICE_SESSION
    assert app.calls == []


@pytest.mark.parametrize("text", [None, "不是 JSON"])
def test_missing_or_broken_results_are_failures(win, tmp_path, text):
    with pytest.raises(win.bridge.PsError) as error:
        make(win, FakeApp(result_text=text)).call(*request(tmp_path), 5)
    assert error.value.code == "PS_FAILED"


def test_com_is_initialised_on_the_thread_that_talks_to_photoshop(win, tmp_path):
    seen: list[tuple[str, int]] = []
    app = FakeApp()
    executor = win.WindowsExecutor(
        connect=lambda: seen.append(("connect", threading.get_ident())) or app,
        session_id=lambda: 1, installed=lambda: True,
        com_init=lambda: seen.append(("init", threading.get_ident())),
        com_uninit=lambda: seen.append(("uninit", threading.get_ident())))
    executor.call(*request(tmp_path), 5)
    assert [name for name, _ in seen] == ["init", "connect", "uninit"]
    assert len({ident for _, ident in seen}) == 1 and seen[0][1] != threading.get_ident()


def test_status_and_actions_explain_the_service_mode(win, monkeypatch):
    from character_workflow.lib.canvas_projects import create_canvas_project
    monkeypatch.setattr(win.bridge, "EXECUTOR", make(win, FakeApp(), session=0))
    project_id = create_canvas_project("PS").project_id
    status, _ = plugin_server.call(PLUGIN_ID, "POST", "/status", project_id=project_id, origin="host",
                                   params={"probe": True})
    assert status["supported"] is False and status["unsupported_reason"] == win.SERVICE_SESSION
    assert status["running"] is False and status["version"] is None
    with pytest.raises(plugin_server.PluginError) as error:
        plugin_server.call(PLUGIN_ID, "POST", "/import", project_id=project_id, origin="host",
                           params={"scope": "merged"})
    assert (error.value.code, error.value.status, error.value.message) == ("PS_UNSUPPORTED", 501, win.SERVICE_SESSION)
