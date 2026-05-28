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


def test_init_data_root_creates_skeleton(tmp_path):
    target = tmp_path / "data"
    cfg_home = tmp_path / "config"
    result = run_bootstrap(
        ["--init-data-root", str(target)],
        env_overrides={
            "XDG_CONFIG_HOME": str(cfg_home),
            "APPDATA": str(cfg_home),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode == 0, result.stderr
    for sub in (".config", ".runtime", "projects", "characters"):
        assert (target / sub).is_dir(), f"missing {sub}"


def _make_fake_uv(bin_dir: Path) -> Path:
    """Drop a stub `uv` executable that mimics `uv sync --project ...` by
    creating <UV_PROJECT_ENVIRONMENT>/bin/python (or Scripts/python.exe on win32).
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        # Skip win32 — this stub uses /bin/sh.
        pytest.skip("fake uv stub requires POSIX shell")
    uv = bin_dir / "uv"
    uv.write_text(
        "#!/bin/sh\n"
        "# fake uv: create <UV_PROJECT_ENVIRONMENT>/bin/python and exit 0\n"
        "venv=\"$UV_PROJECT_ENVIRONMENT\"\n"
        "if [ -z \"$venv\" ]; then\n"
        "  echo 'no UV_PROJECT_ENVIRONMENT' >&2; exit 99\n"
        "fi\n"
        "mkdir -p \"$venv/bin\"\n"
        "cat > \"$venv/bin/python\" <<'PY'\n"
        "#!/bin/sh\n"
        "exit 0\n"
        "PY\n"
        "chmod +x \"$venv/bin/python\"\n"
        "exit 0\n"
    )
    uv.chmod(uv.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return uv


def test_ensure_venv_creates_venv_and_writes_hash(tmp_path):
    data_root = tmp_path / "data"
    data_root.mkdir()
    (data_root / ".config").mkdir()
    fake_bin = tmp_path / "fakebin"
    _make_fake_uv(fake_bin)
    result = run_bootstrap(
        ["--ensure-venv"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": str(data_root),
            "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
        },
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["status"] == "ok"
    assert (data_root / ".venv" / "bin" / "python").exists()
    hash_file = data_root / ".config" / "venv-hash"
    assert hash_file.exists()
    assert hash_file.read_text().strip() == _pyproject_hash()


def test_ensure_venv_fails_without_data_root(tmp_path):
    result = run_bootstrap(
        ["--ensure-venv"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "APPDATA": str(tmp_path / "appdata"),
        },
    )
    assert result.returncode != 0
    out = json.loads(result.stdout) if result.stdout.strip() else {}
    # error reporting may go to stdout or stderr — accept either, but status must not be ok
    assert out.get("status") != "ok"


def test_ensure_venv_fails_without_uv(tmp_path):
    data_root = tmp_path / "data"
    data_root.mkdir()
    (data_root / ".config").mkdir()
    result = run_bootstrap(
        ["--ensure-venv"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": str(data_root),
            "PATH": "",
        },
    )
    assert result.returncode != 0
    out = json.loads(result.stdout) if result.stdout.strip() else {}
    assert out.get("status") != "ok"


def test_init_data_root_writes_global_config(tmp_path):
    target = tmp_path / "data"
    cfg_home = tmp_path / "config"
    result = run_bootstrap(
        ["--init-data-root", str(target)],
        env_overrides={
            "XDG_CONFIG_HOME": str(cfg_home),
            "APPDATA": str(cfg_home),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["data_root"] == str(target.resolve())
    # The global config file is named "data-root" and lives somewhere under cfg_home
    matches = list(cfg_home.rglob("data-root"))
    assert len(matches) == 1, f"expected one data-root config file, got {matches}"
    assert matches[0].read_text().strip() == str(target.resolve())


def test_run_fails_when_no_data_root(tmp_path):
    result = run_bootstrap(
        ["--run", "-c", "print('hi')"],
        env_overrides={
            "XDG_CONFIG_HOME": str(tmp_path / "cfg"),
            "APPDATA": str(tmp_path / "cfg"),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode != 0
    assert "data_root" in result.stdout


def test_run_fails_when_venv_missing(tmp_path):
    data_root = tmp_path / "data"
    data_root.mkdir()
    (data_root / ".config").mkdir()
    result = run_bootstrap(
        ["--run", "-c", "print('hi')"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(data_root)},
    )
    assert result.returncode != 0
    assert "venv not built" in result.stdout


def test_run_forwards_to_venv_python(tmp_path):
    data_root = tmp_path / "data"
    if sys.platform == "win32":
        venv_py = data_root / ".venv" / "Scripts" / "python.exe"
    else:
        venv_py = data_root / ".venv" / "bin" / "python"
    venv_py.parent.mkdir(parents=True)
    if sys.platform == "win32":
        import shutil as _sh
        _sh.copy(sys.executable, venv_py)
    else:
        venv_py.write_text(f"#!{sys.executable}\n")
        venv_py.chmod(0o755)
        # Link to real interpreter via symlink for execution
        venv_py.unlink()
        venv_py.symlink_to(sys.executable)
    result = run_bootstrap(
        ["--run", "-c", "print('forwarded')"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(data_root)},
    )
    assert result.returncode == 0, result.stderr
    assert "forwarded" in result.stdout
