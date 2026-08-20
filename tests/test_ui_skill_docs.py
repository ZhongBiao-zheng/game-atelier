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
    # B4 后 ui-screens 已上线，路由表直接调起
    assert "ui-screens" in text and "未上线，B4" not in text
    # UI 规范写当前方案 style.md 的 ui.* 节
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
    assert "projects/<slug>/ui/<scheme-id>/screens/" in text


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


def test_screen_taxonomy_reference_exists():
    """B4：玩家旅程审计表——8 步旅程 + 分类池 + 优先级三档 + 宁缺毋滥。"""
    text = _read("docs/references/screen-taxonomy.md")
    assert "玩家旅程 8 步审计" in text
    assert "must-have" in text and "genre-specific" in text and "optional" in text
    # 按项目适配选择是硬原则，防默认全量堆页
    assert "不要默认全量加入" in text


def test_screen_map_template_exists_with_contract():
    """B4：screen-map 模板——清单表 + 每页契约与 brief 对齐 + prd 为上游。"""
    text = _read("docs/references/screen-map-template.md")
    assert "status: draft | approved" in text
    # 清单表六列
    for col in ("screen-id", "优先级", "状态", "依赖"):
        assert col in text
    # 每页契约节名与字段（与 screen-brief 对齐，ui-page 直接取用）
    assert "## screen.<screen-id>" in text
    for field in ("purpose", "布局分区", "组件", "状态"):
        assert field in text
    # 开发字段裁剪 + prd 上游一致性
    assert "data_needs" in text and "不写" in text
    assert "以 prd 为准" in text


def test_ui_screens_skill_gates_and_flow():
    """B4：ui-screens——双门禁、画师批范围、只产 map 不生图、prd 回写。"""
    text = _read("skills/ui-screens/SKILL.md")
    # 双门禁：三锚 approved/waiver + 风格已定稿
    assert "approved" in text and "waiver" in text
    assert "ui.*" in text and "style.md" in text
    # 审计 → 批范围 → 写 map → 交棒 ui-page
    assert "screen-taxonomy.md" in text
    assert "screen-map-template.md" in text
    assert "screen-map.md" in text
    assert "ui-page" in text
    # 范围由画师批 + 新增页先回写 prd + 不生图
    assert "画师批" in text
    assert "回写 prd" in text
    assert "不生图" in text


def test_ui_page_reads_screen_map():
    """B4：ui-page 定 screen-id 与写 brief 时优先取 screen-map 契约基础。"""
    text = _read("skills/ui-page/SKILL.md")
    assert "screen-map.md" in text
    assert "## screen.<id>" in text or "screen.<id>" in text


def test_stale_propagation_discipline_in_skills():
    """A3：改锚点 / style.md 前列受影响定稿并确认；style.md 回写后刷新指纹。"""
    char = _read("skills/character/SKILL.md")
    assert "stale-report" in char and "spec 已变更" in char
    ui_page = _read("skills/ui-page/SKILL.md")
    assert "stale-report" in ui_page and "刷新指纹" in ui_page
    ui = _read("skills/ui/SKILL.md")
    assert "stale-report" in ui and "风格已变更" in ui


def test_seven_field_closing_block_in_all_workflow_skills():
    for path in (
        "skills/game-atelier/SKILL.md",
        "skills/ui/SKILL.md",
        "skills/ui-anchor/SKILL.md",
        "skills/ui-page/SKILL.md",
        "skills/ui-screens/SKILL.md",
        "skills/character/SKILL.md",
        "skills/promo/SKILL.md",
        "skills/turnaround/SKILL.md",
    ):
        text = _read(path)
        for field in SEVEN_FIELDS:
            assert field in text, f"{path} missing {field!r}"


def test_ui_skills_use_plugin_root_var_not_hardcoded_path():
    for path in (
        "skills/ui/SKILL.md",
        "skills/ui-anchor/SKILL.md",
        "skills/ui-page/SKILL.md",
        "skills/ui-screens/SKILL.md",
    ):
        text = _read(path)
        assert "~/.claude/plugins/game-atelier/" not in text, path
        assert "${CLAUDE_PLUGIN_ROOT}" in text, path
