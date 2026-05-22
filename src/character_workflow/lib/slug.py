"""项目 slug 生成 —— 中文项目名 → 拼音 → kebab-case 目录名。

规则:
1. 中文走 pypinyin 转拼音(无音标),英文/数字直通
2. 全部小写
3. 非 [a-z0-9] 一律转 `-`,连续 `-` 折叠,首尾 `-` 剥掉
4. 长度上限 32 字符,超出截断
5. dedupe 在调用方做(传入 existing slug 集合,撞了加 `-N` 后缀)
"""
from __future__ import annotations

import re

from pypinyin import Style, lazy_pinyin


_MAX_LEN = 32
_NON_SLUG_CHAR = re.compile(r"[^a-z0-9]+")


def generate(name: str) -> str:
    """name → slug。空 name 抛 ValueError。"""
    if not name or not name.strip():
        raise ValueError("cannot generate slug from empty name")

    parts = lazy_pinyin(name.strip(), style=Style.NORMAL)
    joined = "-".join(parts).lower()
    cleaned = _NON_SLUG_CHAR.sub("-", joined).strip("-")
    if not cleaned:
        raise ValueError(f"slug generation produced empty result for {name!r}")
    return cleaned[:_MAX_LEN].rstrip("-")


def dedupe(candidate: str, existing: set[str]) -> str:
    """如果 candidate 已在 existing,加 -2 / -3 后缀直到不冲突。"""
    if candidate not in existing:
        return candidate
    n = 2
    while f"{candidate}-{n}" in existing:
        n += 1
    return f"{candidate}-{n}"
