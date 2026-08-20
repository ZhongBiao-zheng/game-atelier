"""Character variants are independent assets linked to one parent character."""
from __future__ import annotations

import re
import shutil
import time
import logging
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.projects import assign_character, assign_characters, read_projects
from character_workflow.lib.schemas import CharacterVariant, ProjectsFile


logger = logging.getLogger(__name__)


_ASSET_DIRS = ("portrait", "promo", "turnaround", "source")
_IDENTITY_SECTION_NAMES = {
    "角色定位",
    "已确定要点",
    "identity",
    "visual_dna",
    "anchors",
}


def new_temporary_character_id() -> str:
    return f"char-{time.time_ns()}"


def initialize_character_directory(character_id: str, spec: str) -> Path:
    root = data_root.characters_dir() / character_id
    root.mkdir(parents=True, exist_ok=False)
    try:
        for directory in _ASSET_DIRS:
            (root / directory).mkdir()
        atomic_write_text(root / "spec.md", spec)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return root


def read_character_variant(character_id: str) -> CharacterVariant | None:
    path = data_root.characters_dir() / character_id / "variant.json"
    if not path.is_file():
        return None
    return CharacterVariant.model_validate_json(path.read_text(encoding="utf-8"))


def child_variant_ids(parent_character_id: str) -> list[str]:
    characters = data_root.characters_dir()
    if not characters.is_dir():
        return []
    children: list[str] = []
    for character_dir in characters.iterdir():
        if not character_dir.is_dir():
            continue
        variant = read_character_variant(character_dir.name)
        if variant and variant.parent_character_id == parent_character_id:
            children.append(character_dir.name)
    return sorted(children)


def replace_parent_reference(old_id: str, new_id: str) -> None:
    for child_id in child_variant_ids(old_id):
        path = data_root.characters_dir() / child_id / "variant.json"
        variant = read_character_variant(child_id)
        if variant is None:
            continue
        variant.parent_character_id = new_id
        atomic_write_text(path, variant.model_dump_json(indent=2))


def assign_character_family(
    character_id: str,
    project_id: str | None,
) -> ProjectsFile:
    projects = read_projects()
    if project_id is not None and not any(
        project.id == project_id for project in projects.projects
    ):
        raise KeyError(project_id)
    current_project_id = projects.assignments.get(character_id)
    variant = read_character_variant(character_id)
    if variant is not None:
        if project_id == current_project_id:
            return projects
        raise ValueError("角色皮肤不能单独更换项目，请移动它的母角色")

    family_ids = [character_id, *child_variant_ids(character_id)]
    if all(projects.assignments.get(member_id) == project_id for member_id in family_ids):
        return projects
    from character_workflow.lib.project_folders import remove_character_references

    for member_id in family_ids:
        remove_character_references(member_id)
    return assign_characters(family_ids, project_id)


def create_character_variant(
    parent_character_id: str,
    name: str,
    difference: str,
) -> tuple[str, CharacterVariant]:
    parent_dir = data_root.characters_dir() / parent_character_id
    if not (parent_dir / "spec.md").is_file():
        raise FileNotFoundError(parent_character_id)
    if read_character_variant(parent_character_id) is not None:
        raise ValueError("皮肤不能继续作为母角色创建下一层皮肤")

    projects = read_projects()
    project_id = projects.assignments.get(parent_character_id)
    if project_id is None:
        raise ValueError("母角色必须先归属项目")

    variant_id = new_temporary_character_id()
    spec = (
        f"# {name.strip()}\n\n"
        "## 皮肤差异\n"
        f"{difference.strip()}\n\n"
        "（尚无档案 — 请在终端 /game-atelier:character 对话补全）\n"
    )
    root = initialize_character_directory(variant_id, spec)
    variant = CharacterVariant(
        parent_character_id=parent_character_id,
        difference=difference,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    try:
        atomic_write_text(root / "variant.json", variant.model_dump_json(indent=2))
        assign_character(variant_id, project_id)
    except Exception:
        try:
            assign_character(variant_id, None)
        except Exception:
            logger.warning("回滚皮肤项目归属失败: %s", variant_id, exc_info=True)
        shutil.rmtree(root, ignore_errors=True)
        raise
    return variant_id, variant


def character_display_name(character_id: str) -> str:
    spec = data_root.characters_dir() / character_id / "spec.md"
    if not spec.is_file():
        return character_id
    try:
        text = spec.read_text(encoding="utf-8")
    except OSError:
        return character_id
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            match = re.search(r"^name:\s*(.+?)\s*$", text[3:end], re.MULTILINE)
            if match:
                return match.group(1)
    for line in text.splitlines()[:20]:
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1)
    return character_id


def parent_identity_anchor(parent_character_id: str) -> str:
    spec_path = data_root.characters_dir() / parent_character_id / "spec.md"
    if not spec_path.is_file():
        return ""
    text = spec_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    sections: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^##\s+(.+?)\s*$", lines[index])
        if not match or match.group(1) not in _IDENTITY_SECTION_NAMES:
            index += 1
            continue
        chunk = [lines[index]]
        index += 1
        while index < len(lines) and not re.match(r"^#{1,2}\s+", lines[index]):
            chunk.append(lines[index])
            index += 1
        sections.append("\n".join(chunk).strip())
    return "\n\n".join(sections) if sections else text.strip()
