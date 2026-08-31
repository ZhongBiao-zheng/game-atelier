"""项目分组 IO —— .runtime/projects.json 唯一存储。

数据形态：
{
  "projects": [{"id": "p-...", "name": "魔幻", "created_at": "..."}],
  "assignments": {"shadow": "p-..."}
}

assignments 里没有的角色不进入工坊项目导航；项目内创建角色时必须同步写入归属。
项目删除时连带清理 assignments 里指向它的条目。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from character_workflow.lib import data_root
from character_workflow.lib import slug as slug_util
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import Project, ProjectsFile


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _projects_root() -> Path:
    return data_root.projects_dir()


def _path() -> Path:
    return _runtime_dir() / "projects.json"


def read_projects() -> ProjectsFile:
    p = _path()
    if not p.exists():
        return ProjectsFile()
    return ProjectsFile.model_validate(json.loads(p.read_text(encoding="utf-8")))


def resolve_project(ref: str) -> Project:
    """Resolve a project by its stored id or user-facing slug."""
    for project in read_projects().projects:
        if project.id == ref or project.slug == ref:
            return project
    raise KeyError(f"project not found: {ref!r}")


def _write(file: ProjectsFile) -> ProjectsFile:
    p = _path()
    atomic_write_text(p, file.model_dump_json(indent=2))
    return file


_MEMORY_SKELETON = """# {name} MEMORY (项目级)

## game-atelier

### Portrait

### Promo

### Turnaround
"""

_WORLDVIEW_SKELETON = """# {name} · WORLDVIEW

> 本项目世界观。Skill turn-start 自动加载到出图上下文。

## 项目定位

## 视觉调性

## 用语风格

## 待补 / 未决项
"""


def create_project(name: str, slug: str | None = None) -> Project:
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        existing_slugs = {p.slug for p in f.projects}

        if slug is None:
            candidate = slug_util.generate(name)
            final_slug = slug_util.dedupe(candidate, existing_slugs)
        else:
            if slug in existing_slugs:
                raise ValueError(f"slug already exists: {slug!r}")
            final_slug = slug

        project = Project(
            id=f"p-{uuid4().hex[:10]}",
            slug=final_slug,
            name=name.strip(),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        f.projects.insert(0, project)
        _write(f)

        project_dir = _projects_root() / final_slug
        project_dir.mkdir(parents=True, exist_ok=True)
        memory_path = project_dir / "MEMORY.md"
        worldview_path = project_dir / "worldview.md"
        if not memory_path.exists():
            memory_path.write_text(
                _MEMORY_SKELETON.format(name=name.strip()), encoding="utf-8"
            )
        if not worldview_path.exists():
            worldview_path.write_text(
                _WORLDVIEW_SKELETON.format(name=name.strip()), encoding="utf-8"
            )

        from character_workflow.lib.ui_schemes import initialize_project
        initialize_project(project)

    return project


def rename_project(project_id: str, name: str) -> Project:
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        for p in f.projects:
            if p.id == project_id:
                p.name = name.strip()
                _write(f)
                touch_project(p.id)
                return p
        raise KeyError(project_id)


def delete_project(project_id: str) -> None:
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        f.projects = [p for p in f.projects if p.id != project_id]
        f.assignments = {c: pid for c, pid in f.assignments.items() if pid != project_id}
        _write(f)


def reorder_projects(ordered_ids: list[str]) -> ProjectsFile:
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        id_to_project = {p.id: p for p in f.projects}
        reordered = [id_to_project[pid] for pid in ordered_ids if pid in id_to_project]
        extras = [p for p in f.projects if p.id not in set(ordered_ids)]
        f.projects = reordered + extras
        _write(f)
        return f


def assign_characters(character_ids: list[str], project_id: str | None) -> ProjectsFile:
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        previous_project_ids = {
            owner_id
            for character_id in character_ids
            if (owner_id := f.assignments.get(character_id)) is not None
        }
        if project_id is None:
            for character_id in character_ids:
                f.assignments.pop(character_id, None)
        else:
            if not any(p.id == project_id for p in f.projects):
                raise KeyError(project_id)
            for character_id in character_ids:
                f.assignments[character_id] = project_id
        _write(f)
        for affected_project_id in previous_project_ids | ({project_id} if project_id else set()):
            touch_project(affected_project_id)
        return f


def assign_character(character_id: str, project_id: str | None) -> ProjectsFile:
    return assign_characters([character_id], project_id)


def rename_character_assignment(old_id: str, new_id: str) -> None:
    """Keep identity renames inside the same projects.json transaction boundary."""
    with file_lock(_path().with_suffix(".lock")):
        f = read_projects()
        if old_id in f.assignments:
            f.assignments[new_id] = f.assignments.pop(old_id)
            _write(f)


def touch_project(project_id: str) -> None:
    """Mark metadata-only changes without introducing a second activity ledger."""
    project = resolve_project(project_id)
    project_dir = _projects_root() / project.slug
    project_dir.mkdir(parents=True, exist_ok=True)
    os.utime(project_dir, None)
