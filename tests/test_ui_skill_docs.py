"""B0/B1 —— UI 总控 + 策划锚 skill 文档与模板的结构守卫。"""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SEVEN_FIELDS = [
    "当前步骤：",
    "完成状态：",
    "本步产物：",
    "需要你检查：",
    "可选操作：",
    "进入下一步的条件：",
    "下一步可直接说的话：",
]

ANCHOR_TEMPLATES = [
    "docs/references/gdd-template.md",
    "docs/references/prd-template.md",
    "docs/references/interaction-template.md",
]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_anchor_templates_exist_with_status_frontmatter():
    for path in ANCHOR_TEMPLATES:
        text = _read(path)
        assert "status: draft | approved" in text, path
        assert "project: <project-slug>" in text, path


def test_ui_anchor_skill_references_all_templates_and_gate():
    text = _read("skills/ui-anchor/SKILL.md")
    for tpl in ("gdd-template.md", "prd-template.md", "interaction-template.md"):
        assert tpl in text
    # 正式门禁 + 豁免记录在案
    assert "正式门禁" in text
    assert "waiver.md" in text
    # 交叉检查三条
    assert "交叉检查" in text


def test_ui_orchestrator_routes_and_gates():
    text = _read("skills/ui/SKILL.md")
    assert "ui-anchor" in text
    # UI 规范写 style.md ui.* 节，不另立平行契约
    assert "ui.*" in text and "style.md" in text
    # 未上线阶段必须如实告知，不伪造
    assert "未上线" in text
    # 锚文档门禁
    assert "approved" in text


def test_screen_brief_template_exists_with_frontmatter():
    text = _read("docs/references/screen-brief-template.md")
    assert "project: <project-slug>" in text
    assert "screen: <screen-id>" in text
    assert "反向限制" in text


def test_ui_page_skill_gates_and_submit_chain():
    text = _read("skills/ui-page/SKILL.md")
    # 正式门禁：三锚 approved（或 waiver）+ style.md 存在，不过不生图
    assert "approved" in text and "waiver" in text and "style.md" in text
    # 走 job 体系：submit-screen 提交 + run-job 确认执行
    assert "submit-screen" in text and "run-job" in text
    # brief 模板引用 + 产物归项目
    assert "screen-brief-template.md" in text
    assert "projects/<slug>/screens/" in text


def test_ui_page_style_switch_mode():
    """B3：风格切换模式必须锁结构、记来源关系、定稿后回写 style.md ui.*。"""
    text = _read("skills/ui-page/SKILL.md")
    assert "风格切换模式" in text
    assert "--style-variant" in text and "--base-version" in text
    assert "set-screen-canonical" in text
    # 真正的产出是契约回写，不是候选图本身
    assert "ui.typography" in text and "approved" in text
    # 结构锁定 + 旧候选保留是硬纪律
    assert "结构锁定" in text or "结构不变" in text
    assert "保留不删" in text


def test_seven_field_closing_block_in_all_workflow_skills():
    for path in (
        "skills/ui/SKILL.md",
        "skills/ui-anchor/SKILL.md",
        "skills/ui-page/SKILL.md",
        "skills/character/SKILL.md",
        "skills/promo/SKILL.md",
        "skills/turnaround/SKILL.md",
    ):
        text = _read(path)
        for field in SEVEN_FIELDS:
            assert field in text, f"{path} missing {field!r}"


def test_ui_skills_use_plugin_root_var_not_hardcoded_path():
    for path in ("skills/ui/SKILL.md", "skills/ui-anchor/SKILL.md", "skills/ui-page/SKILL.md"):
        text = _read(path)
        assert "~/.claude/plugins/game-atelier/" not in text, path
        assert "${CLAUDE_PLUGIN_ROOT}" in text, path
