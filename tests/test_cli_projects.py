"""create-project / assign-character CLI subcommands."""
import json

import pytest


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".runtime").mkdir()
    return tmp_path


def test_create_project_default_slug(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["create-project", "--name", "宝可梦游戏"])
    assert exit_code == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["name"] == "宝可梦游戏"
    assert payload["slug"]
    assert payload["id"].startswith("p-")
    assert (cli_env / "projects" / payload["slug"] / "MEMORY.md").exists()


def test_create_project_explicit_slug(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["create-project", "--name", "随便", "--slug", "my-explicit-slug"])
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["slug"] == "my-explicit-slug"


def test_assign_character_writes_assignment(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    main(["create-project", "--name", "G", "--slug", "g"])
    pf = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    project_id = pf["projects"][0]["id"]
    capsys.readouterr()  # 清掉 create 的输出

    exit_code = main(["assign-character", "alice", "--project", project_id])
    assert exit_code == 0
    pf2 = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    assert pf2["assignments"].get("alice") == project_id


def test_assign_character_no_project_unassigns(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    main(["create-project", "--name", "G", "--slug", "g"])
    pf = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    project_id = pf["projects"][0]["id"]
    main(["assign-character", "alice", "--project", project_id])
    capsys.readouterr()

    exit_code = main(["assign-character", "alice"])  # 无 --project
    assert exit_code == 0
    pf2 = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    assert "alice" not in pf2["assignments"]


def test_assign_character_unknown_project_returns_error(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["assign-character", "alice", "--project", "p-nonexistent"])
    assert exit_code != 0
    captured = capsys.readouterr()
    assert "项目不存在" in captured.err or "not found" in captured.err.lower()
