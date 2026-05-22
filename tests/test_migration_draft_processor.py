"""Regression: 角色目录迁移不应影响 draft_processor 的行为。

draft_processor 本身不依赖 characters/，但要确保迁移过程中没人
"顺手"改了它，导致反馈通道在新角色目录下断掉。
"""
import pytest

from character_workflow.lib.draft_processor import process_drafts


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "draft").mkdir(parents=True)
    # 模拟迁移后存在 characters/<id>/spec.md（draft_processor 不应该读它）
    chars = tmp_path / "characters" / "shadow"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# shadow", encoding="utf-8")
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    monkeypatch.chdir(tmp_path)
    return runtime


def test_process_drafts_works_with_nested_characters_dir(runtime):
    (runtime / "draft" / "20260519-100000.md").write_text("光线再阴一点", encoding="utf-8")
    (runtime / "draft" / "20260519-100001.md").write_text("披风颜色调暗", encoding="utf-8")
    result = process_drafts()
    assert len(result) == 2
    contents = [r["content"] for r in result]
    assert "光线再阴一点" in contents
    assert "披风颜色调暗" in contents
    # 处理完原始 draft/ 应为空，processed/ 收齐
    assert not list((runtime / "draft").glob("*.md"))
    assert len(list((runtime / "draft-processed").glob("*.md"))) == 2


def test_process_drafts_does_not_touch_characters_dir(runtime):
    """draft 处理后角色目录里的 spec.md 不应被改动 / 删除。"""
    spec = runtime.parent / "characters" / "shadow" / "spec.md"
    before = spec.read_text(encoding="utf-8")
    (runtime / "draft" / "feedback.md").write_text("any", encoding="utf-8")
    process_drafts()
    assert spec.exists()
    assert spec.read_text(encoding="utf-8") == before
