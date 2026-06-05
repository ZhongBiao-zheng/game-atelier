"""append-memory CLI subcommand."""
import json

import pytest


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / ".runtime").mkdir()
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## game-atelier\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    return tmp_path


def test_append_memory_workspace_scope(cli_env):
    from character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 test · note · prompt:`x`",
                      "--scope", "workspace"])
    assert exit_code == 0
    text = (cli_env / "MEMORY.md").read_text(encoding="utf-8")
    assert "- 2026-05-21 test · note" in text


def test_append_memory_project_scope_with_assignment(cli_env):
    """有 active + 归属 → 写到项目级 MEMORY.md。"""
    (cli_env / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "alice", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (cli_env / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "my-game", "name": "Game", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {"alice": "p-1"},
        }),
        encoding="utf-8",
    )
    (cli_env / "projects" / "my-game").mkdir(parents=True)
    (cli_env / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Proj\n## game-atelier\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )

    from character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 alice · proj-note · prompt:`x`",
                      "--scope", "project"])
    assert exit_code == 0
    text = (cli_env / "projects" / "my-game" / "MEMORY.md").read_text(encoding="utf-8")
    assert "proj-note" in text


def test_append_memory_project_scope_unassigned_returns_2(cli_env, capsys):
    """未归属 → 退出码 2 + stderr 明确错误。"""
    (cli_env / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "orphan", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (cli_env / ".runtime" / "projects.json").write_text(
        json.dumps({"projects": [], "assignments": {}}),
        encoding="utf-8",
    )

    from character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 orphan · x",
                      "--scope", "project"])
    assert exit_code == 2
    captured = capsys.readouterr()
    assert "未归属" in captured.err or "not assigned" in captured.err
