"""Skills use MCP for business work; explicit local startup remains a separate concern."""
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BUSINESS_SKILLS = (
    "character", "promo", "turnaround", "game-atelier", "ui", "ui-anchor",
    "ui-page", "ui-screens", "video",
)


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_business_skills_use_shared_mcp_workflow_without_shell_startup_or_execution():
    for name in BUSINESS_SKILLS:
        text = _read(f"skills/{name}/SKILL.md")
        assert "../../docs/references/workshop-mcp-workflow.md" in text, name
        assert "workshop_list_projects" in text, name
        assert "workshop_get_context" in text, name
        assert "批准" in text, name
        if name in {"character", "promo", "turnaround", "ui-page", "video"}:
            assert "人工批准" in text, name
        for obsolete in ("turn-start", "run-job", "run-latest", "submit-screen",
                         "submit-video-production", "retry-job", "bootstrap.py", "uv run"):
            assert obsolete not in text, (name, obsolete)


def test_explicit_startup_uses_current_nonblocking_commands_and_plugin_root():
    text = _read("skills/viewer-server/SKILL.md")
    assert "uv run python src/viewer_server/server.py start --background" in text
    assert (
        'python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" '
        "--run -m viewer_server.server start --background"
    ) in text
    assert "uv run python scripts/bootstrap.py --check" in text
    assert "Dev mode" in text and "Installed Plugin mode" in text
    assert "Codex mode" in text and "$BOOT" in text
    assert "Windows 用 `python`" in text and "exit 49" in text
    assert "127.0.0.1" in text
    assert "不改为 0.0.0.0" in text


def test_skill_docs_tree_has_no_stale_paths_or_private_agent_memory_requirements():
    for path in (REPO_ROOT / "skills").rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        for obsolete in ("skill/character_workflow/", "skill/character_promo/",
                         "skill/character_turnaround/", "skill/viewer_server/server.py",
                         "~/.claude/plugins/game-atelier/scripts/bootstrap.py",
                         "~/.claude/MEMORY.md", "~/.codex/MEMORY.md"):
            assert obsolete not in text, (str(path), obsolete)


def test_character_choice_and_identity_boundaries_survive_transport_change():
    text = _read("skills/character/SKILL.md")
    for rule in ("Codex", "request_user_input", "两级选择", "AskUserQuestion",
                 "不能伪造用户回答", "不能静默改名", "只处理当前角色",
                 "character_spec", "workshop_write_document"):
        assert rule in text, rule
    spec = _read("skills/character/references/spec-protocol.md")
    assert "Claude Code" in spec and "AskUserQuestion" in spec
    assert "Codex" in spec and "request_user_input" in spec
    assert "workshop_read_document" in spec and "expected_revision" in spec


def test_read_only_diagnosis_is_not_permission_to_generate_or_forge_missing_data():
    text = _read("skills/game-atelier/SKILL.md")
    assert "不准备生成" in text
    assert "尚未核实" in text
    assert "总控建议不构成任何批准" in text
