"""ADR-0017：知识在 Skill、手可换。每个业务 Skill 同时保留 CLI 路径与 MCP 路径的选择规则。"""
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ["character", "promo", "turnaround", "ui-anchor", "ui-page", "ui-screens", "ui", "video",
          "game-atelier"]


@pytest.mark.parametrize("name", SKILLS)
def test_skill_keeps_cli_path_and_declares_mcp_choice(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    assert "## 手的选择" in text
    assert "workshop-mcp-workflow.md" in text
    assert "execute_generation" in text


def test_shared_mcp_workflow_does_not_forbid_cli_fallback_or_chat_approval():
    text = (ROOT / "docs" / "references" / "workshop-mcp-workflow.md").read_text(encoding="utf-8")
    assert "不以 shell" not in text
    assert "不存在 Agent 批准工具" not in text
    assert "workshop_approve_generation" in text
    assert "workshop_append_lesson" in text
