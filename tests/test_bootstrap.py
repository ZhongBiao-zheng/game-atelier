import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = REPO_ROOT / "scripts" / "bootstrap.py"
UV_AVAILABLE = shutil.which("uv") is not None


def run_bootstrap(args, env_overrides=None):
    env = {**dict(os.environ), **(env_overrides or {})}
    result = subprocess.run(
        [sys.executable, str(BOOTSTRAP), *args],
        capture_output=True, text=True, env=env,
    )
    return result


def _pyproject_hash() -> str:
    return hashlib.sha256(
        (REPO_ROOT / "pyproject.toml").read_bytes()
    ).hexdigest()


def _make_fake_venv(data_root: Path, hash_matches: bool = True) -> None:
    """Construct a venv-shaped tree under <data_root>/.venv plus a venv-hash file."""
    if sys.platform == "win32":
        py = data_root / ".venv" / "Scripts" / "python.exe"
    else:
        py = data_root / ".venv" / "bin" / "python"
    py.parent.mkdir(parents=True, exist_ok=True)
    py.write_text("#!/bin/sh\nexit 0\n")
    py.chmod(py.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    (data_root / ".config").mkdir(parents=True, exist_ok=True)
    hash_file = data_root / ".config" / "venv-hash"
    hash_file.write_text(_pyproject_hash() if hash_matches else "stale-hash")


def test_check_reports_needs_data_root_when_no_config(tmp_path, monkeypatch):
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


def test_check_needs_uv_when_uv_missing(tmp_path):
    (tmp_path / ".config").mkdir()
    result = run_bootstrap(
        ["--check"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path),
            "PATH": "",  # so shutil.which("uv") returns None
        },
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["status"] == "needs_uv"
    assert out["uv_path"] is None
    assert "next_action" in out


def test_check_needs_venv_when_venv_missing(tmp_path):
    (tmp_path / ".config").mkdir()
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    # On CI uv may be missing — allow either, but locally we expect needs_venv.
    if UV_AVAILABLE:
        assert out["status"] == "needs_venv"
    else:
        assert out["status"] in ("needs_venv", "needs_uv")


def test_check_needs_first_key_when_venv_exists_but_keys_empty(tmp_path):
    _make_fake_venv(tmp_path, hash_matches=True)
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    if UV_AVAILABLE:
        assert out["status"] == "needs_first_key"
    else:
        assert out["status"] in ("needs_first_key", "needs_uv")


def test_check_needs_keys_repair_when_keys_corrupted(tmp_path):
    _make_fake_venv(tmp_path, hash_matches=True)
    (tmp_path / ".config" / "keys.json").write_text("{ not valid json")
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    if UV_AVAILABLE:
        assert out["status"] == "needs_keys_repair"
    else:
        assert out["status"] in ("needs_keys_repair", "needs_uv")


def test_check_returns_ready_when_keys_present(tmp_path):
    _make_fake_venv(tmp_path, hash_matches=True)
    (tmp_path / ".config" / "keys.json").write_text(
        json.dumps({"keys": [{"id": "k1", "label": "test"}]})
    )
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    if UV_AVAILABLE:
        assert out["status"] == "ready"
    else:
        assert out["status"] in ("ready", "needs_uv")
