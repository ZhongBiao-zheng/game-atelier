"""Lessons append helper — POSIX 单行原子追加。

§11.7：单画师 + 单进程假设。一条经验 < 4096 字节（PIPE_BUF），
`open("a")` 写入是原子的，无需锁。Skill turn 收尾问 Y/N 后调这里。

不做：自动去重、内容验证（一条必须以 "- " 起头之类）—— 都靠 Skill / 人工。
"""
from __future__ import annotations

from pathlib import Path


VALID_KINDS = ("portrait", "promo", "turnaround")


def _lessons_path(kind: str) -> Path:
    """character_workflow/lib/lessons.py → character_workflow/references/lessons/<kind>.md"""
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    skill_root = Path(__file__).resolve().parent.parent
    return skill_root / "references" / "lessons" / f"{kind}.md"


def append_lesson(kind: str, line: str) -> Path:
    """原子追加一条经验。line 是完整 markdown 行，函数自己补 `\\n`。

    line 太长（>= 4000 字节，留余量）抛 ValueError，避免突破 PIPE_BUF 原子边界。
    line 含换行抛 ValueError —— 一条经验必须单行。
    返回最终写入的 lessons 文件路径。
    """
    if "\n" in line or "\r" in line:
        raise ValueError("lesson line must be single-line (no newline allowed)")
    encoded = line.encode("utf-8")
    if len(encoded) >= 4000:
        raise ValueError(f"lesson line too long: {len(encoded)} bytes (limit 4000)")

    path = _lessons_path(kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 第一次追加时，如果文件还不存在，让 open("a") 直接建。
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return path
