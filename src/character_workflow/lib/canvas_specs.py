"""Project Markdown specifications and reviewed agent lessons."""
from __future__ import annotations

import re

from character_workflow.lib import slug
from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text
from character_workflow.lib.canvas_projects import (
    canvas_project_dir, canvas_project_lock_path, read_canvas_project,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import CanvasProject

MAX_TEXT = 40_000
SPEC_FILENAME = r"[a-z0-9]+(?:-[a-z0-9]+)*\.md"


def validate_text(text: str) -> str:
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise ValueError("规范文件不能超过 40000 字符")
    return text


def spec_filename(category: str, used: set[str]) -> str:
    """类别名 → 规范文件名：中文类别转拼音 slug，避开 Windows 保留名与已用名。项目规范与团队规范共用。"""
    try:
        candidate = slug.generate(category)
    except ValueError:
        candidate = "category"
    if candidate in {"con", "prn", "aux", "nul", *{f"com{i}" for i in range(10)}, *{f"lpt{i}" for i in range(10)}}:
        candidate = f"category-{candidate}"
    return slug.dedupe(candidate, used) + ".md"


def _read(project_id: str, relative: str) -> str:
    root = canvas_project_dir(project_id)
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("规范路径不可用")
    return validate_text(path.read_text(encoding="utf-8")) if path.exists() else ""


def read_specs(project_id: str) -> dict:
    with file_lock(canvas_project_lock_path(project_id)):
        project = read_canvas_project(project_id)
        names = dict.fromkeys([*project.categories, *project.category_spec_files])
        return {"project": _read(project_id, "specs/project.md"), "categories": {
            name: _read(project_id, f"specs/{project.category_spec_files[name]}")
            if name in project.category_spec_files else "" for name in names
        }}


def read_spec(project_id: str, category: str) -> str:
    return read_specs(project_id)["categories"].get(category, "")


def write_spec(project_id: str, text: str, category: str | None = None) -> None:
    validate_text(text)
    with file_lock(canvas_project_lock_path(project_id)):
        project = read_canvas_project(project_id)
        filename = "project.md"
        mapping = dict(project.category_spec_files)
        if category is not None:
            if category not in project.categories and category not in mapping:
                raise ValueError("类别不存在")
            if category not in mapping:
                mapping[category] = spec_filename(category, {"project", *(name[:-3] for name in mapping.values())})
            filename = mapping[category]
        _read(project_id, f"specs/{filename}")  # Reject escaping symlinks before writing.
        root = canvas_project_dir(project_id)
        atomic_write_text(root / "specs" / filename, text)
        if mapping != project.category_spec_files:
            updated = CanvasProject.model_validate(project.model_dump() | {"category_spec_files": mapping})
            atomic_write_json(root / "project.json", updated.model_dump(mode="json"))


def parse_lessons(text: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {"pending": [], "adopted": []}
    section = None
    for line in text.splitlines():
        if line == "## 待审":
            section = "pending"
        elif line == "## 已采纳":
            section = "adopted"
        elif line.strip() and section:
            result[section].append(line.removeprefix("- ").strip())
    return result


def _lessons(project_id: str) -> dict[str, list[str]]:
    return parse_lessons(_read(project_id, "agent/lessons.md"))


def read_lessons(project_id: str) -> dict[str, list[str]]:
    with file_lock(canvas_project_lock_path(project_id)):
        read_canvas_project(project_id)
        return _lessons(project_id)


def _lesson_text(lessons: dict[str, list[str]]) -> str:
    text = "\n\n".join(heading + "\n" + "\n".join(f"- {x}" for x in lessons[key])
                        for heading, key in [("## 待审", "pending"), ("## 已采纳", "adopted")]) + "\n"
    return validate_text(text)


def _save_lessons(project_id: str, lessons: dict[str, list[str]]) -> None:
    atomic_write_text(canvas_project_dir(project_id) / "agent/lessons.md", _lesson_text(lessons))


def validate_lesson(text: str) -> str:
    if not isinstance(text, str) or not text.strip() or len(text) > 300:
        raise ValueError("经验必须为 1–300 字")
    return re.sub(r"\s+", " ", text).strip()


def append_lesson(project_id: str, text: str) -> dict:
    text = validate_lesson(text)
    with file_lock(canvas_project_lock_path(project_id)):
        read_canvas_project(project_id)
        lessons = _lessons(project_id)
        lessons["pending"].append(text)
        _save_lessons(project_id, lessons)
        return lessons


def review_lesson(project_id: str, index: int, adopt: bool) -> dict:
    with file_lock(canvas_project_lock_path(project_id)):
        read_canvas_project(project_id)
        lessons = _lessons(project_id)
        if index < 0 or index >= len(lessons["pending"]):
            raise ValueError("待审经验不存在，请刷新")
        text = lessons["pending"].pop(index)
        if adopt:
            spec = _read(project_id, "specs/project.md")
            # Insert directly below the heading even when other sections follow it.
            heading = "## 项目经验"
            addition = f"\n- {text}\n"
            if heading in spec.splitlines():
                spec = spec.replace(heading, heading + addition, 1)
            else:
                spec = spec.rstrip() + f"\n\n{heading}\n" + addition
            validate_text(spec)
            lessons["adopted"].append(text)
            _lesson_text(lessons)
            # Validate both documents before either write; repeated adoption cannot duplicate a line.
            if f"- {text}" not in _read(project_id, "specs/project.md").splitlines():
                atomic_write_text(canvas_project_dir(project_id) / "specs/project.md", spec)
        _save_lessons(project_id, lessons)
        return lessons


def instructions(project_id: str) -> str:
    text = read_specs(project_id)["project"]
    if not text:
        return ""
    return "\n\n## 项目规范\n" + text[:8000] + ("\n（规范超过 8000 字，已截断）" if len(text) > 8000 else "")
