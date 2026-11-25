"""画布与创作台的 Agent 共用同一套行事规则，工作区只补充各自的工具用法。"""

from character_workflow.lib import canvas_agent_runtime as canvas
from character_workflow.lib import studio_agent as studio
from character_workflow.lib.agent_instructions import CORE


def test_both_workspaces_share_core_and_only_add_tool_sections():
    for instructions in (canvas.INSTRUCTIONS, studio.INSTRUCTIONS):
        assert instructions.startswith(CORE)
        extra = instructions.removeprefix(CORE)
        # 产出、多方案、汇报只写在 CORE；工作区段落不能另立一套。
        for heading in ("## 汇报", "## 多方案", "## 每一轮都要有产出"):
            assert heading not in extra
        assert "明确要求生成" not in extra
        assert instructions.count("用中文回复") == 1


def test_core_ends_every_turn_with_output_and_leaves_confirmation_to_permissions():
    assert "## 每一轮都要有产出" in CORE
    assert "不要问「要不要生成」" in CORE
    assert "以 `→ ` 开头" in CORE


def test_only_explicit_requests_trigger_multiple_images():
    assert "没说张数就出 1 张" in CORE
    assert "明确要比较但没给数字时出 3 张" in CORE
    assert "需求适合探索多个方向" not in CORE
