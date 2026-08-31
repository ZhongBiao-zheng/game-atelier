from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_shared_prompt_contract_requires_ordered_descriptions_for_every_reference():
    text = _read("docs/references/art-prompt-system.md")
    assert "每张参考图" in text
    assert "简短可见描述" in text
    assert "角色图" in text and "场景图" in text
    assert "media_ids" in text and "顺序" in text
    assert "workshop_prepare_generation" in text


def test_promo_supports_multiple_references_without_single_image_fallback():
    skill = _read("skills/promo/SKILL.md")
    guide = _read("skills/promo/references/prompt-promo-zh.md")
    combined = skill + guide
    assert "只能上传一张" not in combined
    assert "一次只稳定处理一张参考图" not in combined
    assert "每个出镜角色" in combined
    assert "场景参考图" in combined
    assert "media_ids" in combined and "顺序" in combined


def test_promo_identity_anchor_can_be_portrait_turnaround_or_user_upload():
    skill = _read("skills/promo/SKILL.md")
    router = _read("skills/game-atelier/SKILL.md")
    for text in (skill, router):
        assert "portrait" in text
        assert "turnaround" in text
        assert "用户上传" in text
    assert "还没有立绘" not in skill


def test_new_character_flow_requires_web_registration_into_source_and_typed_slot():
    skill = _read("skills/character/SKILL.md")
    assert "Atelier 上传" in skill
    assert "workshop_list_media" in skill
    assert "workshop_read_media" in skill
    assert "source/" in skill
    assert "portrait" in skill and "turnaround" in skill
    assert "不自动定稿" in skill


def test_each_image_skill_uses_shared_reference_manifest_contract():
    for path in (
        "skills/character/SKILL.md",
        "skills/promo/SKILL.md",
        "skills/turnaround/SKILL.md",
    ):
        text = _read(path)
        assert "参考图清单" in text, path
