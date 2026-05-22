"""Shared context loader for the character Skill suite.

Three读取入口：
- `load_worldview()` —— 项目根 `worldview.md`
- `load_lessons(kind)` —— `references/lessons/<kind>.md`，按出图类型分卷
- `load_spec(character_id)` —— `characters/<id>/spec.md`

返回值统一是 `str`（文件不存在 / 读不到时返回 ""，并在 stderr 留一行告警）。
组合接口 `load_character_context()` 把三段拼成 TypedDict，喂给 prompt_builder。

Token 预算告警（详 §11.6）写在加载函数里，画师能直接在 server 日志看到 prompt 膨胀。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TypedDict


WORLDVIEW_SOFT_LIMIT_CHARS = 2000
LESSONS_SOFT_LIMIT_ENTRIES = 50

VALID_KINDS = ("portrait", "promo", "turnaround")


class CharacterContext(TypedDict):
    worldview: str
    lessons: str
    spec: str
    character_id: str


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd()))


def _skill_root() -> Path:
    """character_workflow/lib/ → character_workflow/"""
    return Path(__file__).resolve().parent.parent


def _read_text(p: Path) -> str:
    """UTF-8 / UTF-8 BOM 都接受；不存在 / IO 错 → 空串 + stderr。"""
    if not p.exists():
        return ""
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError as e:
        print(f"[context_loader] read failed: {p} ({e})", file=sys.stderr)
        return ""
    return text


def load_worldview() -> str:
    p = _project_root() / "worldview.md"
    text = _read_text(p)
    if not text:
        print("[context_loader] worldview.md missing or empty — skill will run with no project background", file=sys.stderr)
        return ""
    n = len(text)
    print(f"[context_loader] worldview.md: {n} chars", file=sys.stderr)
    if n > WORLDVIEW_SOFT_LIMIT_CHARS:
        print(
            f"[context_loader] WARN worldview {n} chars exceeds soft limit "
            f"{WORLDVIEW_SOFT_LIMIT_CHARS} — prompt 会变胖，考虑分卷",
            file=sys.stderr,
        )
    return text


def load_lessons(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    p = _skill_root() / "references" / "lessons" / f"{kind}.md"
    text = _read_text(p)
    if not text:
        return ""
    entries = sum(1 for line in text.splitlines() if line.startswith("- "))
    print(f"[context_loader] lessons/{kind}.md: {len(text)} chars, {entries} entries", file=sys.stderr)
    if entries > LESSONS_SOFT_LIMIT_ENTRIES:
        print(
            f"[context_loader] WARN lessons/{kind} {entries} entries exceeds soft limit "
            f"{LESSONS_SOFT_LIMIT_ENTRIES} — 建议人工分卷归档",
            file=sys.stderr,
        )
    return text


def load_spec(character_id: str) -> str:
    if not character_id:
        return ""
    p = _project_root() / "characters" / character_id / "spec.md"
    if not p.exists():
        raise FileNotFoundError(f"spec not found: {p}")
    return _read_text(p)


def load_character_context(character_id: str, kind: str) -> CharacterContext:
    """组合接口：一次拉齐三段上下文。spec 不存在抛 FileNotFoundError。"""
    return CharacterContext(
        worldview=load_worldview(),
        lessons=load_lessons(kind),
        spec=load_spec(character_id),
        character_id=character_id,
    )


# ---------------------------------------------------------------------------
# 三层 lessons + 项目级 worldview（Task 7 新增）
# ---------------------------------------------------------------------------

def _global_memory_path() -> Path:
    return Path(os.environ.get("HOME", "~")).expanduser() / ".claude" / "MEMORY.md"


def _workspace_memory_path() -> Path:
    return _project_root() / "MEMORY.md"


def _project_memory_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "MEMORY.md"


def _project_worldview_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "worldview.md"


_KIND_HEADERS = {
    "portrait": "Portrait",
    "promo": "Promo",
    "turnaround": "Turnaround",
}


def _extract_kind_section(text: str, kind: str, depth: int) -> str:
    """从 MEMORY.md 文本里抽出指定 kind 的 section 内容。

    depth = 3 时找 `### {Kind}`（工作区 / 项目层）
    depth = 4 时找 `#### {Kind}`（全局层，在 ## Skills Memory > ### character-workflow 下）
    遇到同级或更高级别 header 时停止 capture；深度更深的 header 不停。
    """
    if not text:
        return ""
    if kind not in _KIND_HEADERS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    header = "#" * depth + " " + _KIND_HEADERS[kind]
    lines = text.splitlines()
    out: list[str] = []
    capture = False
    for line in lines:
        stripped = line.strip()
        if stripped == header:
            capture = True
            continue
        if capture and stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= depth:
                break
        if capture:
            out.append(line)
    return "\n".join(out).strip()


def load_lessons_global(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    text = _read_text(_global_memory_path())
    return _extract_kind_section(text, kind, depth=4)


def load_lessons_workspace(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    text = _read_text(_workspace_memory_path())
    return _extract_kind_section(text, kind, depth=3)


def load_lessons_project(slug: str | None, kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    if not slug:
        return ""
    path = _project_memory_path(slug)
    if not path.exists():
        return ""
    return _extract_kind_section(_read_text(path), kind, depth=3)


def load_project_worldview(slug: str | None) -> str:
    if not slug:
        return ""
    path = _project_worldview_path(slug)
    if not path.exists():
        return ""
    return _read_text(path)
