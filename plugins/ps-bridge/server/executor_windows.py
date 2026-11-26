"""PS 联动的 Windows 执行器（第 3 批）：经 COM 调 Photoshop.Application.DoJavaScript。

执行与 macOS 相同的 atelier_ps.jsx。三处可注入（用例换成假 COM）：
- connect()：拿到正在运行的 PS COM 对象；没在运行时抛 NotRunning。默认 GetActiveObject，绝不 Dispatch（会启动 PS）。
- session_id()：本进程所在的 Windows 会话；0 = 非交互会话（常驻任务），连不到用户桌面上的 PS。
- installed()：注册表里有没有 Photoshop.Application。
COM 对象不跨线程：每次连接都在当前线程里 CoInitialize / CoUninitialize。
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

from . import bridge

RPC_E_CALL_REJECTED = -2147418111          # 0x80010001
RPC_E_SERVERCALL_RETRYLATER = -2147417846  # 0x8001010A
_BUSY_HRESULTS = {RPC_E_CALL_REJECTED, RPC_E_SERVERCALL_RETRYLATER}
SERVICE_SESSION = "常驻模式下不能连接 Photoshop，请用桌面应用或启动器运行 Cobrush"
BUSY = "Photoshop 没有响应，已取消这次操作；请关闭 Photoshop 里的对话框后重试"


class NotRunning(Exception):
    pass


def _connect() -> Any:
    import pywintypes
    import win32com.client
    try:
        return win32com.client.GetActiveObject("Photoshop.Application")
    except pywintypes.com_error:
        raise NotRunning() from None


def _session_id() -> int:
    import ctypes
    session = ctypes.c_ulong()
    if not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        return -1
    return session.value


def _installed() -> bool:
    import winreg
    try:
        winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Photoshop.Application\CLSID").Close()
        return True
    except OSError:
        return False


def _hresult(error: BaseException) -> int | None:
    args = getattr(error, "args", ())
    return args[0] if args and isinstance(args[0], int) else None


class WindowsExecutor:
    def __init__(self, connect: Callable[[], Any], session_id: Callable[[], int], installed: Callable[[], bool],
                 com_init: Callable[[], None] | None = None,
                 com_uninit: Callable[[], None] | None = None) -> None:
        self._connect, self._session_id, self._installed = connect, session_id, installed
        self._com_init, self._com_uninit = com_init, com_uninit
        self._stuck = threading.Event()  # 上一次调用超时后，工作线程还挂在 COM 里

    def unsupported_reason(self) -> str | None:
        return SERVICE_SESSION if self._session_id() == 0 else None

    def running(self) -> bool:
        if self.unsupported_reason() is not None:
            return False
        try:
            self._in_com(self._connect)
            return True
        except NotRunning:
            return False

    def installed(self) -> bool:
        return self._installed()

    def _in_com(self, work: Callable[[], Any]) -> Any:
        if self._com_init:
            self._com_init()
        try:
            return work()
        finally:
            if self._com_uninit:
                self._com_uninit()

    def call(self, request_dir: Path, config: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        reason = self.unsupported_reason()
        if reason is not None:
            raise bridge.PsError("PS_UNSUPPORTED", reason, 501)
        if self._stuck.is_set():
            raise bridge.PsError("PS_BUSY", BUSY, 503)
        # ExtendScript 的 File 认正斜杠；ensure_ascii 让中文路径以 \uXXXX 写出，不受代码页影响。
        # 配置里的路径都由服务端生成、都在本次请求目录里（bridge.run 与各 prepare），按前缀转换。
        inside = str(request_dir)
        posix = {key: Path(value).as_posix() if isinstance(value, str) and value.startswith(inside) else value
                 for key, value in config.items()}
        config_path = request_dir / "config.json"
        config_path.write_text(json.dumps(posix, ensure_ascii=True), encoding="utf-8")
        config_arg = config_path.as_posix()
        # 配置路径同时放进全局变量与 arguments：不依赖 pywin32 把列表转成 SAFEARRAY 后脚本能否读到。
        loader = (f"var ATELIER_CONFIG_PATH = {json.dumps(config_arg, ensure_ascii=True)};"
                  f"$.evalFile(new File({json.dumps(bridge.SCRIPT.as_posix(), ensure_ascii=True)}))")
        outcome: dict[str, Any] = {}

        def work() -> None:
            try:
                outcome["value"] = self._connect().DoJavaScript(loader, [config_arg], 1)  # 1 = 不弹调试器
            except BaseException as error:  # noqa: BLE001 —— 交回请求线程分类
                outcome["error"] = error
            finally:
                self._stuck.clear()

        self._stuck.set()
        thread = threading.Thread(target=self._in_com, args=(work,), daemon=True, name="ps-bridge-com")
        thread.start()
        thread.join(timeout_s)
        if thread.is_alive():
            # COM 调用还挂着（多半是 PS 弹着对话框）：写取消标记，让迟到执行的脚本直接退出；
            # 卡住标记保持置位，直到那个线程真正返回。
            bridge.cancel(request_dir)
            raise bridge.PsError("PS_BUSY", BUSY, 503)
        error = outcome.get("error")
        if isinstance(error, NotRunning):
            raise bridge.PsError("PS_NOT_RUNNING", "Photoshop 未启动", 409)
        if error is not None:
            if _hresult(error) in _BUSY_HRESULTS:
                bridge.cancel(request_dir)
                raise bridge.PsError("PS_BUSY", BUSY, 503)
            raise bridge.PsError("PS_FAILED", f"Photoshop 执行失败：{str(error)[:200]}", 502)
        result_path = Path(config["result"])
        if not result_path.is_file():
            raise bridge.PsError("PS_FAILED", "Photoshop 没有返回结果，请检查 Photoshop 里的文档后再试", 502)
        try:
            return json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise bridge.PsError("PS_FAILED", "Photoshop 返回的结果读不出", 502) from None


def windows_executor() -> WindowsExecutor:
    import pythoncom
    return WindowsExecutor(_connect, _session_id, _installed, pythoncom.CoInitialize, pythoncom.CoUninitialize)
