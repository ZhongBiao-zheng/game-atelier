"""Read-only status of the user's scheduled task; installation remains a console action."""
import json
from pathlib import Path
import subprocess
import sys


def service_status() -> dict:
    script = Path(__file__).resolve().parents[2] / "scripts/windows-service.ps1"
    command = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{script}" install'
    if sys.platform != "win32":
        return {"state": "unsupported", "install_command": None}
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
             str(script), "status"], capture_output=True, text=True, encoding="utf-8", timeout=8,
        )
        status = json.loads(result.stdout) if result.returncode == 0 else {}
        if status.get("state") not in {"installed", "not_installed", "needs_credentials"}:
            raise ValueError("unknown task status")
        return {**status, "install_command": command}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"state": "unknown", "install_command": command}
