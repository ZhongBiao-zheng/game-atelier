from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_DOCS = ["skills/viewer-server/SKILL.md"]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")








def test_skill_docs_use_plugin_root_var_not_hardcoded_install_path():
    """市场实装路径是 ~/.claude/plugins/cache/<市场>/<插件>/<版本>/，

    硬编码 ~/.claude/plugins/game-atelier/ 在真机不存在 → bootstrap 全 404。
    Skill 必须用 CC 注入的 ${CLAUDE_PLUGIN_ROOT}。
    """
    for path in SKILL_DOCS:
        text = _read(path)
        # 命令形态的硬编码路径才是 bug；告诫语里作反例提及（后不接 scripts/）放行
        assert "~/.claude/plugins/game-atelier/scripts/bootstrap.py" not in text, path
        assert "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" in text, path


def test_skill_docs_warn_windows_python3_store_alias_pitfall():
    """Windows 的 python3 常是损坏 Store 别名（--version 假装正常，跑脚本 exit 49）。

    SKILL 必须指引 Windows 用 python，否则模型只能瞎试到 python 才通。
    """
    for path in SKILL_DOCS:
        text = _read(path)
        assert "Windows" in text and "exit 49" in text, path
        assert "Windows 用 `python`" in text, path


def test_skill_docs_do_not_use_stale_viewer_server_path():
    for path in SKILL_DOCS:
        text = _read(path)
        assert "skill/viewer_server/server.py" not in text


def test_skill_docs_do_not_require_bare_python_command():
    for path in SKILL_DOCS:
        text = _read(path)
        assert "python ~/.claude/plugins/game-atelier/scripts/bootstrap.py" not in text


def test_skill_docs_tree_does_not_use_stale_skill_reference_paths():
    for path in (REPO_ROOT / "skills").rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        assert "skill/character_workflow/" not in text, str(path)
        assert "skill/character_promo/" not in text, str(path)
        assert "skill/character_turnaround/" not in text, str(path)






def test_skill_docs_use_uv_for_dev_bootstrap():
    for path in SKILL_DOCS:
        text = _read(path)
        assert "uv run python scripts/bootstrap.py --check" in text
        assert "python3 scripts/bootstrap.py --check" not in text






def test_skill_docs_have_codex_mode_without_uv_run():
    """Codex 不设 ${CLAUDE_PLUGIN_ROOT}，必须有 Codex 分支，且 per-turn 明确禁用 uv run。"""
    for path in SKILL_DOCS:
        text = _read(path)
        assert "Codex mode" in text, path
        assert "$BOOT" in text, path
        assert "绝不" in text and "uv run" in text, path




def test_skill_docs_memory_decoupled_from_agent_home():
    """记忆解耦：SKILL 不再指示读代理私人记忆 ~/.claude/MEMORY.md（global 层已并入 data_root）。"""
    for path in SKILL_DOCS:
        text = _read(path)
        assert "~/.claude/MEMORY.md" not in text, path
