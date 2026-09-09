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


def test_check_plugin_ignores_local_qa_artifacts_but_counts_release_assets(tmp_path):
    (tmp_path / ".claude-plugin").mkdir()
    (tmp_path / ".claude-plugin" / "plugin.json").write_text(json.dumps({
        "name": "x", "version": "0.0.1", "description": "x",
    }))
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "bootstrap.py").write_text("")
    (tmp_path / "pyproject.toml").write_text("")
    (tmp_path / "web" / "dist").mkdir(parents=True)
    (tmp_path / "web" / "dist" / "index.html").write_text("ok")
    (tmp_path / ".scratch").mkdir()
    large = tmp_path / ".scratch" / "qa.bin"
    with large.open("wb") as file:
        file.truncate(11 * 1024 * 1024)
    command = [sys.executable, str(SCRIPT), "--repo", str(tmp_path)]
    assert subprocess.run(command, capture_output=True).returncode == 0
    large.rename(tmp_path / "release.bin")
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 1
    assert "exceeds 10MB cap" in result.stdout


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
