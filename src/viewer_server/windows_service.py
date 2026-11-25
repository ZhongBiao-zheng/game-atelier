"""Windows 常驻服务（任务计划程序里的 GameAtelier）：读状态，或拉起提权 PowerShell 安装（D16）。"""
import json
from pathlib import Path
import subprocess
import sys

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts/windows-service.ps1"
# 安装窗口里还要用户在任务计划程序保存凭据、回答睡眠设置；UAC 弹窗本身可能放着没人点。
_INSTALL_LAUNCH_TIMEOUT = 180


class ServiceInstallError(Exception):
    """安装没拉起来：message 是一句给人看的原因，raw 是 PowerShell 原文。"""

    def __init__(self, message: str, raw: str = ""):
        super().__init__(message)
        self.raw = raw


def _install_command() -> str:
    return f'powershell -NoProfile -ExecutionPolicy Bypass -File "{_SCRIPT}" install'


def service_status() -> dict:
    command = _install_command()
    if sys.platform != "win32":
        return {"state": "unsupported", "install_command": None}
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
             str(_SCRIPT), "status"], capture_output=True, text=True, encoding="utf-8", timeout=8,
        )
        status = json.loads(result.stdout) if result.returncode == 0 else {}
        if status.get("state") not in {"installed", "not_installed", "needs_credentials"}:
            raise ValueError("unknown task status")
        return {**status, "install_command": command}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"state": "unknown", "install_command": command}


def install_service() -> None:
    """以管理员身份打开一个 PowerShell 窗口跑安装脚本（系统弹 UAC）。

    安装脚本本身是交互式的（打开任务计划程序让用户保存凭据），所以这里只负责把它提权拉起来；
    窗口带 -NoExit，脚本报错时用户能看到原因。用户在 UAC 里点「否」或被策略拦下时抛 ServiceInstallError。
    """
    if sys.platform != "win32":
        raise ServiceInstallError("只有 Windows 支持常驻服务")
    # PowerShell 单引号字符串里的单引号要写成两个。
    inner = f'-NoProfile -ExecutionPolicy Bypass -NoExit -File "{_SCRIPT}" install'.replace("'", "''")
    launcher = f"Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList '{inner}'"
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", launcher],
            capture_output=True, text=True, encoding="utf-8", timeout=_INSTALL_LAUNCH_TIMEOUT,
        )
    except subprocess.TimeoutExpired as error:
        raise ServiceInstallError("等待管理员授权超时", str(error)) from error
    except OSError as error:
        raise ServiceInstallError("无法启动 PowerShell", str(error)) from error
    if result.returncode != 0:
        raw = (result.stderr or result.stdout or "").strip()
        raise ServiceInstallError("没有拿到管理员权限，安装没有开始", raw)
