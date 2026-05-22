"""Slug 生成 — 中文 → 拼音 → kebab-case。"""
import pytest

from skill.character_workflow.lib import slug


def test_pure_ascii_passthrough():
    assert slug.generate("Hard Mecha v2") == "hard-mecha-v2"


def test_chinese_to_pinyin():
    # pypinyin lazy_pinyin yields one token per char; 宝可梦风格-精灵游戏 → bao-ke-meng-feng-ge-...-you-xi
    # full result is 34 chars after joining, so truncated at 32
    assert slug.generate("宝可梦风格-精灵游戏") == "bao-ke-meng-feng-ge-jing-ling-yo"


def test_truncate_to_32_chars():
    result = slug.generate("非常非常非常非常非常长的中文项目名" * 5)
    assert len(result) <= 32


def test_dedupe_with_suffix():
    existing = {"my-game", "my-game-2"}
    assert slug.dedupe("my-game", existing) == "my-game-3"


def test_dedupe_no_collision():
    assert slug.dedupe("fresh", {"taken"}) == "fresh"


def test_empty_name_raises():
    with pytest.raises(ValueError, match="empty"):
        slug.generate("")


def test_mixed_chinese_english():
    # 测试 v2 → ['ce', 'shi', ' v2'] → joined: 'ce-shi- v2' → cleaned: 'ce-shi-v2'
    assert slug.generate("测试 v2") == "ce-shi-v2"


def test_punctuation_normalized():
    assert slug.generate("foo_bar__baz") == "foo-bar-baz"
    assert slug.generate("a.b.c") == "a-b-c"
