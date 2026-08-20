"""Tests for skill.character_workflow.lib.prompt_builder."""
import pytest

from character_workflow.lib.context_loader import CharacterContext
from character_workflow.lib.prompt_builder import (
    assemble_character_prompt, render,
)


def test_render_substitutes_placeholders():
    out = render("Hello {name}, kind={kind}", {"name": "圣灵", "kind": "portrait"})
    assert out == "Hello 圣灵, kind=portrait"


def test_render_missing_field_raises_keyerror_with_name():
    with pytest.raises(KeyError, match="missing field: name"):
        render("Hello {name}", {})


def test_render_extra_fields_ignored():
    out = render("Hi {name}", {"name": "x", "extra": "ignored"})
    assert out == "Hi x"


def test_render_with_persona_wraps_sections():
    out = render("body", {}, persona="美宣专家")
    assert "# 专家人设" in out
    assert "美宣专家" in out
    assert "# 任务" in out
    assert "body" in out


def test_assemble_character_prompt_all_sections():
    ctx: CharacterContext = {
        "worldview": "东方仙侠",
        "lessons": "- 经验一",
        "spec": "# 圣灵\n金白",
        "character_id": "holy",
        "project_style": "暖色厚涂",
        "parent_identity_anchor": "",
        "variant_difference": "",
        "asset_slot": "portrait",
    }
    out = assemble_character_prompt(ctx, persona="角色档案专家", task="补完 spec")
    assert "# 专家人设" in out and "角色档案专家" in out
    assert "# 项目世界观" in out and "东方仙侠" in out
    assert "# 历代经验" in out and "经验一" in out
    assert "# 当前角色 spec (holy)" in out and "金白" in out
    assert "# 任务" in out and "补完 spec" in out
    # 顺序：persona → worldview → lessons → spec → task
    parts = ["专家人设", "项目世界观", "项目风格", "历代经验", "当前角色 spec", "当前槽位", "任务"]
    idxs = [out.index(p) for p in parts]
    assert idxs == sorted(idxs)


def test_assemble_skips_empty_sections():
    ctx: CharacterContext = {
        "worldview": "",
        "lessons": "  \n  ",  # whitespace only, should also be skipped
        "spec": "# 圣灵",
        "character_id": "holy",
        "project_style": "",
        "parent_identity_anchor": "",
        "variant_difference": "",
        "asset_slot": "portrait",
    }
    out = assemble_character_prompt(ctx, persona="", task="任务")
    assert "# 专家人设" not in out
    assert "# 项目世界观" not in out
    assert "# 历代经验" not in out
    assert "# 当前角色 spec" in out
    assert "# 当前槽位\n\nportrait" in out
    assert "# 任务" in out


def test_assemble_variant_context_precedes_child_spec():
    ctx: CharacterContext = {
        "worldview": "",
        "lessons": "",
        "spec": "# 曹操·夏日\n白色短袍",
        "character_id": "cao-cao-summer",
        "project_style": "半写实国风",
        "parent_identity_anchor": "黑狐耳、金瞳",
        "variant_difference": "白色短袍",
        "asset_slot": "promo",
    }

    out = assemble_character_prompt(ctx, persona="", task="生成美宣")

    parts = ["项目风格", "母角色身份锚", "皮肤差异", "当前角色 spec", "当前槽位", "任务"]
    assert [out.index(part) for part in parts] == sorted(out.index(part) for part in parts)
    assert "promo" in out
