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

import sys
from pathlib import Path
from typing import TypedDict

from character_workflow.lib import data_root


WORLDVIEW_SOFT_LIMIT_CHARS = 2000
LESSONS_SOFT_LIMIT_ENTRIES = 50

VALID_KINDS = ("portrait", "promo", "turnaround")


class CharacterContext(TypedDict):
    worldview: str
    lessons: str
    spec: str
    character_id: str
    project_style: str
    parent_identity_anchor: str
    variant_difference: str
    asset_slot: str


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
    p = data_root.workspace_worldview()
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
    p = data_root.characters_dir() / character_id / "spec.md"
    if not p.exists():
        raise FileNotFoundError(f"spec not found: {p}")
    return _read_text(p)


def load_character_context(character_id: str, kind: str) -> CharacterContext:
    """组合接口：一次拉齐三段上下文。spec 不存在抛 FileNotFoundError。"""
    from character_workflow.lib.character_variants import (
        parent_identity_anchor,
        read_character_variant,
    )
    from character_workflow.lib.projects import read_projects

    projects = read_projects()
    project_id = projects.assignments.get(character_id)
    project = next((item for item in projects.projects if item.id == project_id), None)
    variant = read_character_variant(character_id)
    return CharacterContext(
        worldview=load_worldview(),
        lessons=load_lessons(kind),
        spec=load_spec(character_id),
        character_id=character_id,
        project_style=load_project_style(project.slug if project else None),
        parent_identity_anchor=(
            parent_identity_anchor(variant.parent_character_id) if variant else ""
        ),
        variant_difference=variant.difference if variant else "",
        asset_slot=kind,
    )


# ---------------------------------------------------------------------------
# 三层 lessons + 项目级 worldview（Task 7 新增）
# ---------------------------------------------------------------------------

def _workspace_memory_path() -> Path:
    return data_root.workspace_memory()


def _project_memory_path(slug: str) -> Path:
    return data_root.projects_dir() / slug / "MEMORY.md"


def _project_worldview_path(slug: str) -> Path:
    return data_root.projects_dir() / slug / "worldview.md"


_KIND_HEADERS = {
    "portrait": "Portrait",
    "promo": "Promo",
    "turnaround": "Turnaround",
}


def _extract_kind_section(text: str, kind: str, depth: int) -> str:
    """从 MEMORY.md 文本里抽出指定 kind 的 section 内容。

    depth = 3 时找 `### {Kind}`（workspace / project 层，均在 `## game-atelier` 下）。
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


def _project_style_path(slug: str) -> Path:
    return data_root.projects_dir() / slug / "style.md"


def load_project_style(slug: str | None) -> str:
    """项目风格契约 ← projects/<slug>/style.md（A1，2026-08-10）。

    全文返回（含 frontmatter status 字段，skill 需要据此判断 draft/approved）。
    不存在 / 无归属 → ""。
    """
    if not slug:
        return ""
    path = _project_style_path(slug)
    if not path.exists():
        return ""
    text = _read_text(path)
    n = len(text)
    if n > WORLDVIEW_SOFT_LIMIT_CHARS:
        print(
            f"[context_loader] WARN style.md {n} chars exceeds soft limit "
            f"{WORLDVIEW_SOFT_LIMIT_CHARS} — prompt 会变胖，考虑收敛契约",
            file=sys.stderr,
        )
    return text
