"""doctor 环境自诊断测试。"""
import pytest

from character_workflow.lib import doctor


def _codes(result):
    return {f["code"] for f in result["findings"]}


def _by_code(result, code):
    return next(f for f in result["findings"] if f["code"] == code)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "data").mkdir()
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    return tmp_path


def test_data_root_resolved_from_env(env):
    result = doctor.diagnose()
    assert result["data_root_source"] == "env"
    assert "data_root_resolved" in _codes(result)
    assert result["ok"] is True


def test_cwd_neq_data_root_flagged(env):
    result = doctor.diagnose()
    assert "cwd_neq_data_root" in _codes(result)


def test_data_root_is_git_warns(env, tmp_path):
    (tmp_path / "data" / ".git").mkdir()
    result = doctor.diagnose()
    f = _by_code(result, "data_root_is_git")
    assert f["level"] == "warn"
    assert f["suggestion"]


def test_venv_missing_warns(env):
    result = doctor.diagnose()
    f = _by_code(result, "venv_missing")
    assert f["level"] == "warn"


def test_venv_ready_when_present(env, tmp_path):
    import sys
    venv = tmp_path / "data" / ".venv"
    if sys.platform == "win32":
        (venv / "Scripts").mkdir(parents=True)
        (venv / "Scripts" / "python.exe").write_text("")
    else:
        (venv / "bin").mkdir(parents=True)
        (venv / "bin" / "python").write_text("")
    result = doctor.diagnose()
    assert "venv_ready" in _codes(result)


def test_agent_reported(env):
    result = doctor.diagnose()
    assert "agent_detected" in _codes(result)
    assert set(result["agent"]) == {"tool", "convention_file", "agent_home"}


def test_cwd_is_data_root_ok(tmp_path, monkeypatch):
    dr = tmp_path / "data"
    dr.mkdir()
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(dr))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(dr)
    result = doctor.diagnose()
    assert "cwd_is_data_root" in _codes(result)
