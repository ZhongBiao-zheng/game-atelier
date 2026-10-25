from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_shared_prompt_contract_requires_ordered_descriptions_for_every_reference():
    text = _read("docs/references/art-prompt-system.md")
    assert "每张参考图" in text
    assert "简短可见描述" in text
    assert "角色图" in text and "场景图" in text
    assert "--reference-image" in text and "可重复" in text
