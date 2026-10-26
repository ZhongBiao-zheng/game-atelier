import json
import os
from pathlib import Path
import subprocess

import pytest

from viewer_server import windows_service

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/windows-service.ps1"


@pytest.mark.parametrize("state", ["installed", "not_installed", "needs_credentials"])
def test_status_reads_only_the_task_and_preserves_credential_state(monkeypatch, state):
    monkeypatch.setattr(windows_service.sys, "platform", "win32")

    def run(command, **kwargs):
        assert command[-1] == "status"
        return subprocess.CompletedProcess(command, 0, json.dumps({"state": state}), "")

    monkeypatch.setattr(windows_service.subprocess, "run", run)
    status = windows_service.service_status()
    assert status["state"] == state
    assert status["install_command"].endswith('" install')


def test_status_failure_is_visible(monkeypatch):
    monkeypatch.setattr(windows_service.sys, "platform", "win32")
    monkeypatch.setattr(windows_service.subprocess, "run", lambda *a, **k:
                        subprocess.CompletedProcess(a, 1, "", "denied"))
    assert windows_service.service_status()["state"] == "unknown"


@pytest.mark.skipif(os.name != "nt", reason="PowerShell syntax and ScheduledTasks require Windows")
def test_windows_script_parses_and_reads_status_without_installing():
    # Parse the complete script, including the installation branches, without changing OS settings.
    result = subprocess.run([
        "powershell.exe", "-NoProfile", "-Command",
        "$tokens=$null; $errors=$null; "
        "[System.Management.Automation.Language.Parser]::ParseFile($env:ATELIER_TEST_SCRIPT, "
        "[ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw $errors };",
    ], capture_output=True, text=True, env={**os.environ, "ATELIER_TEST_SCRIPT": str(SCRIPT)})
    assert result.returncode == 0, result.stderr
    status = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                             "-File", str(SCRIPT), "status"], capture_output=True, text=True)
    assert status.returncode == 0, status.stderr
    assert json.loads(status.stdout)["state"] in {"not_installed", "installed", "needs_credentials"}
