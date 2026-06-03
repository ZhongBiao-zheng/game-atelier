from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_DOCS = [
    "skills/character/SKILL.md",
    "skills/promo/SKILL.md",
    "skills/turnaround/SKILL.md",
    "skills/viewer-server/SKILL.md",
]
BUSINESS_SKILL_DOCS = [
    "skills/character/SKILL.md",
    "skills/promo/SKILL.md",
    "skills/turnaround/SKILL.md",
]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_character_workflow_docs_use_current_viewer_server_path():
    text = _read("skills/character/SKILL.md")
    assert "src/viewer_server/server.py start" in text


def test_skill_docs_use_non_blocking_viewer_server_start_for_skills():
    for path in BUSINESS_SKILL_DOCS:
        text = _read(path)
        assert "uv run python src/viewer_server/server.py start --background" in text


def test_business_skill_docs_explain_installed_viewer_server_start():
    cmd = (
        'python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" '
        "--run -m viewer_server.server start --background"
    )
    for path in BUSINESS_SKILL_DOCS:
        text = _read(path)
        assert cmd in text


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


def test_character_workflow_turn_start_contract_lists_new_fields():
    text = _read("skills/character/SKILL.md")
    assert '"spec_status"' in text
    assert '"available_keys"' in text
    assert '"preferred_alias"' in text


def test_character_workflow_docs_explain_dev_and_installed_bootstrap():
    text = _read("skills/character/SKILL.md")
    assert "Dev mode" in text
    assert "uv run python scripts/bootstrap.py --check" in text
    assert "Installed Plugin mode" in text
    assert 'python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --check' in text


def test_skill_docs_use_uv_for_dev_bootstrap():
    for path in SKILL_DOCS:
        text = _read(path)
        assert "uv run python scripts/bootstrap.py --check" in text
        assert "python3 scripts/bootstrap.py --check" not in text


def test_character_workflow_docs_include_codex_choice_protocol():
    text = _read("skills/character/SKILL.md")
    assert "Codex" in text
    assert "request_user_input" in text
    assert "两级选择" in text
    assert "AskUserQuestion" in text
    assert "不能伪造用户回答" in text
    assert "spec_status" in text


def test_character_workflow_docs_cover_identity_normalization():
    text = _read("skills/character/SKILL.md")
    assert "pending_identity_normalizations" in text
    assert "rename-character-id" in text
    assert "不能静默改名" in text
    assert "整理 Web 创建角色" in text
    assert "只处理当前角色" in text


def test_spec_protocol_mentions_cross_runtime_choice_tools():
    text = _read("skills/character/references/spec-protocol.md")
    assert "Claude Code" in text
    assert "AskUserQuestion" in text
    assert "Codex" in text
    assert "request_user_input" in text
