"""和本机 Photoshop 说话：请求目录、取消标记、单请求队列、执行器（ps-bridge 第 1 批）。

调用方向只有 viewer-server → Photoshop：服务端在本机用系统脚本接口让 PS 执行仓库里固定的
`atelier_ps.jsx`，参数经 JSON 文件传入，结果写回执文件。浏览器只传项目与节点 id，
这里不接受任何来自请求的文件路径。
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from character_workflow.lib import data_root

SCRIPT = Path(__file__).with_name("atelier_ps.jsx")
PS_BUNDLE_ID = "com.adobe.Photoshop"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 64 * 1024 * 1024
REQUEST_TTL_S = 3600
# PS 弹着对话框时调用会一直挂着；超时后脚本仍会在对话框关闭后执行（第 0 批探针第 7 项），
# 所以超时一律写取消标记，脚本开头见到就退出。
DEFAULT_TIMEOUT_S = 60
_ERROR_CODE = re.compile(r"\((-?\d+)\)\s*$")

# 第 0 批探针：PS 26.0 不认 `do javascript <文件引用>`（一律 8800），只能传文本、文本里 $.evalFile。
# 先判断 is running：PS 没开时 `tell application` 会把它启动。
_APPLESCRIPT = """on run argv
  set loaderText to item 1 of argv
  set cfgPath to item 2 of argv
  set waitSeconds to (item 3 of argv) as integer
  if application id "com.adobe.Photoshop" is running then
    with timeout of waitSeconds seconds
      tell application id "com.adobe.Photoshop"
        return do javascript loaderText with arguments {cfgPath}
      end tell
    end timeout
  else
    return "NOT_RUNNING"
  end if
end run
"""


class PsError(Exception):
    """给用户看的一句话 + 机器码 + HTTP 状态；由路由翻成 PluginError。"""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Executor(Protocol):
    def running(self) -> bool: ...
    def installed(self) -> bool: ...
    def call(self, request_dir: Path, config: dict[str, Any], timeout_s: int) -> dict[str, Any]: ...


def responsible_app() -> str | None:
    """macOS 的自动化授权记在发起进程的「负责应用」名下（探针第 2 项）：桌面应用拉起时是 Atelier。"""
    if sys.platform != "darwin":
        return None
    try:
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        func = lib.responsibility_get_pid_responsible_for_pid
        func.argtypes, func.restype = [ctypes.c_int], ctypes.c_int
        owner = func(os.getpid())
        path = subprocess.run(["ps", "-o", "comm=", "-p", str(owner)], capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except (OSError, AttributeError, subprocess.SubprocessError):
        return None
    if not path:
        return None
    bundles = [part[:-4] for part in Path(path).parts if part.endswith(".app")]
    return bundles[0] if bundles else Path(path).name


class MacExecutor:
    def running(self) -> bool:
        # lsappinfo 走 LaunchServices：不发 Apple 事件、不触发授权、不经 System Events，PS 没开不会被拉起。
        try:
            found = subprocess.run(["lsappinfo", "find", f"bundleid={PS_BUNDLE_ID}"],
                                   capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return False
        return bool(found.stdout.strip())

    def installed(self) -> bool:
        roots = [Path("/Applications"), Path.home() / "Applications"]
        if any(next(root.glob("Adobe Photoshop*/Adobe Photoshop*.app"), None) for root in roots if root.is_dir()):
            return True
        try:
            found = subprocess.run(["mdfind", f"kMDItemCFBundleIdentifier == '{PS_BUNDLE_ID}'"],
                                   capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return False
        return bool(found.stdout.strip())

    def call(self, request_dir: Path, config: dict[str, Any], timeout_s: int) -> dict[str, Any]:
        if not self.running():
            raise PsError("PS_NOT_RUNNING", "Photoshop 未启动", 409)
        config_path = request_dir / "config.json"
        result_path = Path(config["result"])
        config_path.write_text(json.dumps(config, ensure_ascii=True), encoding="utf-8")
        script_path = request_dir / "call.applescript"
        script_path.write_text(_APPLESCRIPT, encoding="utf-8")
        loader = f"$.evalFile(new File({json.dumps(str(SCRIPT), ensure_ascii=True)}))"
        try:
            done = subprocess.run(["osascript", str(script_path), loader, str(config_path), str(timeout_s)],
                                  capture_output=True, text=True, timeout=timeout_s + 15)
        except subprocess.TimeoutExpired:
            cancel(request_dir)
            raise busy_timeout() from None
        if done.stdout.strip() == "NOT_RUNNING":
            raise PsError("PS_NOT_RUNNING", "Photoshop 未启动", 409)
        if done.returncode != 0:
            raise osascript_error(request_dir, done.stderr.strip())
        if not result_path.is_file():
            raise PsError("PS_FAILED", "Photoshop 没有返回结果，请检查 Photoshop 里的文档后再试", 502)
        try:
            return json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise PsError("PS_FAILED", "Photoshop 返回的结果读不出", 502) from None


class UnsupportedExecutor:
    def running(self) -> bool:
        return False

    def installed(self) -> bool:
        return False

    def call(self, request_dir: Path, config: dict[str, Any], timeout_s: int) -> dict[str, Any]:
        raise PsError("PS_UNSUPPORTED", "当前系统暂不支持 Photoshop 联动", 501)


EXECUTOR: Executor = MacExecutor() if sys.platform == "darwin" else UnsupportedExecutor()


def busy_timeout() -> PsError:
    # 两种原因都表现为调用挂到超时：PS 弹着对话框；或系统的自动化授权窗口在等用户点（第 0 批探针第 6、7 项）。
    return PsError("PS_BUSY", "Photoshop 没有响应，已取消这次操作；请关闭 Photoshop 里的对话框，"
                   "或在系统弹出的授权窗口里点「允许」后重试", 503)


def cancel(request_dir: Path) -> None:
    try:
        (request_dir / "cancelled").write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def osascript_error(request_dir: Path, stderr: str) -> PsError:
    match = _ERROR_CODE.search(stderr)
    code = int(match.group(1)) if match else None
    if code == -1712:
        cancel(request_dir)
        return busy_timeout()
    if code == -1743:
        app = responsible_app() or "Atelier"
        return PsError("PS_AUTOMATION_DENIED",
                       f"需要在「系统设置 → 隐私与安全性 → 自动化」里允许 {app} 控制 Photoshop", 403)
    if code in (-600, -609):
        return PsError("PS_NOT_RUNNING", "Photoshop 未启动", 409)
    detail = stderr.split("execution error:", 1)[-1].strip()[:200] or "未知错误"
    return PsError("PS_FAILED", f"Photoshop 执行失败：{detail}", 502)


# ── 请求 ───────────────────────────────────────────────────────────────

_busy = threading.Lock()


def requests_root() -> Path:
    return data_root.runtime_dir() / "ps-bridge" / "requests"


def _sweep(root: Path, keep: Path) -> None:
    """清掉一小时前的请求目录；超时留下的目录带着取消标记，等到这里才删。"""
    cutoff = time.time() - REQUEST_TTL_S
    for child in root.iterdir():
        try:
            if child != keep and child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue


@dataclass(frozen=True)
class Request:
    directory: Path

    def path(self, name: str) -> Path:
        return self.directory / name


def run(action: str, params: dict[str, Any], prepare: Callable[[Request], dict[str, Any]] | None = None,
        timeout_s: int = DEFAULT_TIMEOUT_S) -> tuple[dict[str, Any], Request]:
    """同一时刻只跑一个 PS 请求。返回 (回执, 请求)；调用方读完产物后调 `finish`。

    `prepare(request)` 在调用 PS 之前往请求目录里放输入文件（如置入用的 PNG），返回要并进配置的字段
    （其中的路径都在本次请求目录里，由服务端生成）。
    """
    if not _busy.acquire(blocking=False):
        raise PsError("PS_BUSY", "Photoshop 正在处理上一个请求", 409)
    request: Request | None = None
    try:
        root = requests_root()
        root.mkdir(parents=True, exist_ok=True)
        request = Request(root / uuid.uuid4().hex)
        request.directory.mkdir()
        _sweep(root, request.directory)
        extra = prepare(request) if prepare is not None else {}
        config = {**params, **extra, "action": action, "result": str(request.path("result.json")),
                  "cancel": str(request.path("cancelled"))}
        receipt = EXECUTOR.call(request.directory, config, timeout_s)
        if not isinstance(receipt, dict):
            raise PsError("PS_FAILED", "Photoshop 返回的结果读不出", 502)
        if receipt.get("ok") is not True:
            raise receipt_error(receipt)
        return receipt, request
    except BaseException:
        if request is not None:
            finish(request)
        raise
    finally:
        _busy.release()


def finish(request: Request) -> None:
    """删请求目录；带取消标记的留给下次清理（脚本可能还会迟到执行，届时要能看到标记）。"""
    if not request.path("cancelled").exists():
        shutil.rmtree(request.directory, ignore_errors=True)


def receipt_error(receipt: dict[str, Any]) -> PsError:
    # ExtendScript 的 String(new Error("X")) 是 "Error: X"。
    error = str(receipt.get("error") or "").removeprefix("Error: ")
    if error.startswith("NO_DOCUMENT"):
        return PsError("PS_NO_DOCUMENT", "Photoshop 里没有打开的文档", 409)
    if error.startswith("DOCUMENT_NOT_FOUND"):
        return PsError("PS_DOCUMENT_NOT_FOUND", "找不到这个文档（可能已关闭），请先读取 Photoshop 文档列表", 409)
    if error.startswith("TARGET_NOT_OPEN"):
        name = str(receipt.get("target_name") or "")
        return PsError("PS_TARGET_NOT_OPEN",
                       f"原文档「{name}」未打开，请先在 Photoshop 打开它" if name else "原文档未打开", 409)
    if error.startswith("CANCELLED"):
        return busy_timeout()
    if "8007" in error:
        return PsError("PS_CANCELLED", "操作在 Photoshop 里被取消了", 409)
    line = receipt.get("line")
    detail = error[:200] or "未知错误"
    return PsError("PS_FAILED", f"Photoshop 执行失败：{detail}" + (f"（第 {line} 行）" if line else ""), 502)


def read_png(request: Request, name: str) -> bytes:
    """路径闸门：只读本次请求目录里、签名正确、不超过 64 MiB 的 PNG（符号链接解析后也必须在目录里）。"""
    path = request.path(name).resolve()
    if request.directory.resolve() not in path.parents or not path.is_file():
        raise PsError("PS_FAILED", "Photoshop 没有导出图片", 502)
    if path.stat().st_size > MAX_PNG_BYTES:
        raise PsError("PS_TOO_LARGE", "导出的图片超过 64 MiB，请缩小选区后重试", 413)
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise PsError("PS_FAILED", "Photoshop 导出的不是 PNG", 502)
    return data


def png_size(data: bytes) -> tuple[int, int]:
    width, height = struct.unpack(">II", data[16:24])
    return width, height
