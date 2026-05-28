import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_plugin.py"


def test_check_plugin_passes_on_current_repo():
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "OK: plugin checks passed" in result.stdout


def test_check_plugin_fails_when_manifest_missing(tmp_path):
    fake_repo = tmp_path / "fake-repo"
    fake_repo.mkdir()
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--repo", str(fake_repo)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert ".claude-plugin/plugin.json missing" in result.stdout


def test_check_plugin_fails_on_invalid_json(tmp_path):
    fake_repo = tmp_path / "fake-repo"
    (fake_repo / ".claude-plugin").mkdir(parents=True)
    (fake_repo / ".claude-plugin" / "plugin.json").write_text("{ not valid json")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--repo", str(fake_repo)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "invalid JSON" in result.stdout


def test_check_plugin_fails_when_skills_dir_missing(tmp_path):
    fake_repo = tmp_path / "fake-repo"
    (fake_repo / ".claude-plugin").mkdir(parents=True)
    (fake_repo / ".claude-plugin" / "plugin.json").write_text(json.dumps({
        "name": "x", "version": "0.0.1", "description": "x",
        "skills": "./skills",
    }))
    (fake_repo / "scripts").mkdir()
    (fake_repo / "scripts" / "bootstrap.py").write_text("")
    (fake_repo / "pyproject.toml").write_text("")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--repo", str(fake_repo)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "skills dir not found" in result.stdout
