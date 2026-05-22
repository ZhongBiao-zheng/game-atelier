import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = REPO_ROOT / "scripts" / "bootstrap.py"


def run_bootstrap(args, env_overrides=None):
    env = {**dict(__import__("os").environ), **(env_overrides or {})}
    result = subprocess.run(
        [sys.executable, str(BOOTSTRAP), *args],
        capture_output=True, text=True, env=env,
    )
    return result


def test_check_reports_needs_data_root_when_no_config(tmp_path, monkeypatch):
    # Point platformdirs config dir at empty tmp_path via env
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))  # Windows
    result = run_bootstrap(
        ["--check"],
        env_overrides={
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "APPDATA": str(tmp_path / "appdata"),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["status"] == "needs_data_root"
    assert out["data_root"] is None
    assert "next_action" in out


def test_check_reports_data_root_when_env_var_set(tmp_path):
    (tmp_path / ".config").mkdir()
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["data_root"] == str(tmp_path)
    # status will be needs_uv / needs_venv / needs_first_key — anything but needs_data_root
    assert out["status"] != "needs_data_root"
