"""Flat character derivatives with frozen source-image provenance."""
from __future__ import annotations

import logging
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_text
from character_workflow.lib.projects import assign_character, read_projects
from character_workflow.lib.schemas import CharacterDerivative


logger = logging.getLogger(__name__)

_ASSET_DIRS = ("portrait", "promo", "turnaround", "source")
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


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


def read_character_derivative(character_id: str) -> CharacterDerivative | None:
    path = data_root.characters_dir() / character_id / "derivative.json"
    if not path.is_file():
        return None
    return CharacterDerivative.model_validate_json(path.read_text(encoding="utf-8"))


def _copy_sources(root: Path, sources: list[Path]) -> list[str]:
    data_root_path = data_root.resolve_data_root().resolve()
    copied: list[str] = []
    for index, source in enumerate(sources, start=1):
        suffix = source.suffix.lower()
        if suffix not in _IMAGE_EXTENSIONS:
            raise ValueError(f"衍生来源只接受图片：{source.name}")
        target = root / "source" / f"source-{index}{suffix}"
        atomic_write_bytes(target, source.read_bytes())
        copied.append(target.resolve().relative_to(data_root_path).as_posix())
    return copied


def create_character_derivative(
    source_character_id: str,
    name: str,
    source_paths: list[Path],
) -> tuple[str, CharacterDerivative]:
    source_dir = data_root.characters_dir() / source_character_id
    if not (source_dir / "spec.md").is_file():
        raise FileNotFoundError(source_character_id)

    project_id = read_projects().assignments.get(source_character_id)
    if project_id is None:
        raise ValueError("来源角色必须先归属项目，才能创建衍生")

    derivative_id = new_temporary_character_id()
    spec = (
        f"# {name.strip()}\n\n"
        "（角色衍生 — 来源素材已冻结到 source/；请在终端 "
        "/game-atelier:character 对话补全独立档案）\n"
    )
    root = initialize_character_directory(derivative_id, spec)
    try:
        copied_paths = _copy_sources(root, source_paths)
        derivative = CharacterDerivative(
            source_character_id=source_character_id,
            source_character_name=character_display_name(source_character_id),
            source_paths=copied_paths,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        atomic_write_text(root / "derivative.json", derivative.model_dump_json(indent=2))
        assign_character(derivative_id, project_id)
    except Exception:
        try:
            assign_character(derivative_id, None)
        except Exception:
            logger.warning("回滚角色衍生项目归属失败: %s", derivative_id, exc_info=True)
        shutil.rmtree(root, ignore_errors=True)
        raise
    return derivative_id, derivative


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
