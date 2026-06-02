"""Regression: turn-start CLI 在新角色目录结构下能读到 spec.md。

迁移前 _read_spec() 找 characters/<id>.md，FAIL；
迁移后改为 characters/<id>/spec.md，PASS。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    (runtime / "draft").mkdir(parents=True)
    chars = tmp_path / "characters" / "holy"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 圣灵祭祀\n金白配色", encoding="utf-8")
    (runtime / "active-character.json").write_text(json.dumps({
        "active_id": "holy", "updated_at": "2026-05-19T10:00:00Z",
    }), encoding="utf-8")
    (runtime / "projects.json").write_text(json.dumps({
        "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
        "assignments": {"holy": "p-1"},
    }), encoding="utf-8")
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _run_cli(data_root: str) -> dict:
    env = os.environ.copy()
    env["GAME_ATELIER_DATA_ROOT"] = data_root
    env["PYTHONPATH"] = f"{REPO_ROOT / 'src'}{os.pathsep}{env.get('PYTHONPATH', '')}"
    out = subprocess.run(
        [sys.executable, "-m", "character_workflow", "turn-start"],
        capture_output=True, text=True, env=env,
    )
    assert out.returncode == 0, f"CLI failed: {out.stderr}"
    return json.loads(out.stdout)


def test_turn_start_reads_spec_from_nested_dir(runtime):
    """turn-start 必须从 characters/<id>/spec.md 读到内容。"""
    result = _run_cli(str(runtime))
    assert result["active_id"] == "holy"
    assert result["spec"] is not None, "spec should be loaded from <id>/spec.md"
    assert "圣灵祭祀" in result["spec"]
    assert "金白配色" in result["spec"]


def test_turn_start_returns_none_spec_when_dir_missing(runtime):
    """active 指向一个不存在的角色目录 → spec=None，不崩。"""
    (runtime / ".runtime" / "active-character.json").write_text(json.dumps({
        "active_id": "ghost", "updated_at": "2026-05-19T10:00:00Z",
    }), encoding="utf-8")
    result = _run_cli(str(runtime))
    assert result["active_id"] == "ghost"
    assert result["spec"] is None


def test_turn_start_drafts_still_work(runtime):
    """迁移不应破坏 draft 处理。"""
    (runtime / ".runtime" / "draft" / "20260519-100000.md").write_text("反馈一", encoding="utf-8")
    result = _run_cli(str(runtime))
    assert len(result["drafts"]) == 1
    assert "反馈一" in result["drafts"][0]["content"]
