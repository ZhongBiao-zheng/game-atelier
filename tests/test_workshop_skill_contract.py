"""ADR-0017：知识在 Skill、手可换。每个业务 Skill 保留 CLI 路径并声明 MCP 选择；
工具映射与批准细则单点维护在 workshop-mcp-workflow.md，只有会提交生成的 Skill 内联批准门（#93）。"""
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GENERATING = ["character", "promo", "turnaround", "ui-page", "video"]
ROUTING = ["ui", "ui-anchor", "ui-screens", "game-atelier"]


@pytest.mark.parametrize("name", GENERATING + ROUTING)
def test_skill_keeps_cli_path_and_points_to_shared_mcp_mapping(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    assert "## 手的选择" in text
    assert "workshop-mcp-workflow.md" in text
    # 工具映射只在共享文档里维护，SKILL.md 不再逐字复制一份。
    assert "替代本文的 turn-start" not in text


@pytest.mark.parametrize("name", GENERATING)
def test_generating_skill_keeps_approval_gate_inline(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    assert "execute_generation" in text
    assert "workshop_approve_generation" in text


@pytest.mark.parametrize("name", ROUTING)
def test_routing_skill_does_not_duplicate_approval_gate(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    assert "workshop_approve_generation" not in text


def test_shared_mcp_workflow_carries_mapping_and_allows_cli_fallback_and_chat_approval():
    text = (ROOT / "docs" / "references" / "workshop-mcp-workflow.md").read_text(encoding="utf-8")
    assert "### CLI 命令 ↔ MCP 工具" in text
    assert "不以 shell" not in text
    assert "不存在 Agent 批准工具" not in text
    assert "workshop_approve_generation" in text
    assert "workshop_append_lesson" in text
