from pathlib import Path
import os
import pytest
from character_workflow.lib import data_root


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("CHARACTER_WORKFLOW_DATA_ROOT", raising=False)


def test_resolve_uses_env_var_first(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    assert data_root.resolve_data_root() == tmp_path.resolve()


def test_resolve_falls_back_to_default_when_unset(monkeypatch, tmp_path):
    # Pretend platformdirs config dir is empty
    monkeypatch.setattr(data_root, "_global_config_file", lambda: tmp_path / "nonexistent")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    expected = (tmp_path / "home" / "character-workflow").resolve()
    assert data_root.resolve_data_root() == expected


def test_resolve_reads_global_config_when_env_unset(monkeypatch, tmp_path):
    cfg = tmp_path / "data-root"
    cfg.write_text(str(tmp_path / "custom-root") + "\n")
    monkeypatch.setattr(data_root, "_global_config_file", lambda: cfg)
    assert data_root.resolve_data_root() == (tmp_path / "custom-root").resolve()


def test_resolve_global_config_strips_whitespace(monkeypatch, tmp_path):
    cfg = tmp_path / "data-root"
    cfg.write_text(f"  {tmp_path / 'a'}  \n\n")
    monkeypatch.setattr(data_root, "_global_config_file", lambda: cfg)
    assert data_root.resolve_data_root() == (tmp_path / "a").resolve()


def test_subdir_helpers(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    assert data_root.config_dir() == tmp_path / ".config"
    assert data_root.runtime_dir() == tmp_path / ".runtime"
    assert data_root.venv_dir() == tmp_path / ".venv"
    assert data_root.projects_dir() == tmp_path / "projects"
    assert data_root.characters_dir() == tmp_path / "characters"
    assert data_root.workspace_memory() == tmp_path / "MEMORY.md"
    assert data_root.workspace_worldview() == tmp_path / "worldview.md"
    assert data_root.keys_file() == tmp_path / ".config" / "keys.json"


def test_venv_python_posix(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(data_root.sys, "platform", "linux")
    assert data_root.venv_python() == tmp_path / ".venv" / "bin" / "python"


def test_venv_python_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(data_root.sys, "platform", "win32")
    assert data_root.venv_python() == tmp_path / ".venv" / "Scripts" / "python.exe"
