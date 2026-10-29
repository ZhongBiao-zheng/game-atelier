"""团队规范：团队库目录里的 specs/（ADR-0031）。

与项目规范同构：team.md 是整体规范，index.json 把类别名映射到类别规范文件。目录随团队的同步工具
在成员之间同步；本机只读写文件，不设作者限制，并发修改交给同步工具。冲突时以项目规范为准。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text
from character_workflow.lib import canvas_specs
from character_workflow.lib.canvas_specs import spec_filename, validate_text
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import TeamLibraryMount
from character_workflow.lib.team_library import reachable_mounts
from character_workflow.lib.team_library_index import cache_dir

SPECS_DIR = "specs"
TEAM_FILE = "team.md"
INDEX_FILE = "index.json"
_FILENAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.md$")


def _spec_path(mount: TeamLibraryMount, name: str) -> Path:
    root = Path(mount.mount_path).resolve()
    folder = root / SPECS_DIR
    path = folder / name
    # specs/ 或文件是 symlink 就可能写到库外：一律拒绝，不跟随。
    if folder.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError("团队规范路径不可用")
    return path


def _read_text(mount: TeamLibraryMount, name: str) -> str:
    path = _spec_path(mount, name)
    if not path.is_file():
        return ""
    return validate_text(path.read_text(encoding="utf-8"))


def _category_files(mount: TeamLibraryMount) -> dict[str, str]:
    """index.json 读不出来或某条不合规时跳过：别的工具写坏一条，不该让整个团队的规范都读不到。"""
    try:
        raw = json.loads(_spec_path(mount, INDEX_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    categories = raw.get("categories") if isinstance(raw, dict) else None
    if not isinstance(categories, dict):
        return {}
    mapping: dict[str, str] = {}
    for name, filename in categories.items():
        name = name.strip() if isinstance(name, str) else ""
        if (0 < len(name) <= 24 and isinstance(filename, str) and _FILENAME.fullmatch(filename)
                and filename != TEAM_FILE and filename not in mapping.values()):
            mapping[name] = filename
    return mapping


def read_team_specs(mount: TeamLibraryMount) -> dict:
    return {"team": _read_text(mount, TEAM_FILE), "categories": {
        name: _read_text(mount, filename) for name, filename in _category_files(mount).items()
    }}


def write_team_spec(mount: TeamLibraryMount, text: str, category: str | None = None) -> None:
    validate_text(text)
    if category is not None:
        category = category.strip()
        if not 0 < len(category) <= 24:
            raise ValueError("类别名需为 1–24 个字符")
    # 锁放本机缓存目录，不放进团队目录：锁文件会被同步工具带到别人机器上。
    with file_lock(cache_dir(mount.library_id) / "specs.lock"):
        mapping = _category_files(mount)
        filename = TEAM_FILE
        if category is not None:
            if category not in mapping:
                mapping = {**mapping, category: spec_filename(
                    category, {"team", *(name[:-3] for name in mapping.values())})}
                atomic_write_json(_spec_path(mount, INDEX_FILE), {"categories": mapping})
            filename = mapping[category]
        atomic_write_text(_spec_path(mount, filename), text)


# ── 给画布 Agent：项目规范在前，团队规范在后，冲突以项目为准 ─────────────────────────

PRIORITY_NOTE = "团队规范是团队通用的底线；与项目规范冲突时以项目规范为准。"
_TEAM_LIMIT = 4000


def _team_texts(project_id: str, pick) -> list[tuple[str, str]]:
    """(库名, 文本)。某个库的规范读不出来就跳过，不让一个坏库挡住 Agent。"""
    rows = []
    for mount in reachable_mounts(project_id):
        try:
            text = pick(read_team_specs(mount))
        except (OSError, ValueError):
            continue
        if text:
            rows.append((mount.name, text))
    return rows


def _clip(text: str, limit: int) -> str:
    return text[:limit] + (f"\n（规范超过 {limit} 字，已截断）" if len(text) > limit else "")


def agent_instructions(project_id: str) -> str:
    """系统提示词里的整体规范：项目规范 + 本画布挂载各库的团队整体规范。"""
    text = canvas_specs.instructions(project_id)
    teams = _team_texts(project_id, lambda specs: specs["team"])
    if not teams:
        return text
    sections = "".join(f"\n\n## 团队规范（{name}）\n{_clip(body, _TEAM_LIMIT)}" for name, body in teams)
    return text + sections + "\n\n" + PRIORITY_NOTE


def agent_category_spec(project_id: str, category: str) -> str:
    """read_spec 工具：项目类别规范 + 各团队库同名类别规范。"""
    project = canvas_specs.read_spec(project_id, category)
    teams = _team_texts(project_id, lambda specs: specs["categories"].get(category, ""))
    if not teams:
        return project
    parts = [f"## 项目规范\n{project}"] if project else []
    parts += [f"## 团队规范（{name}）\n{body}" for name, body in teams]
    return "\n\n".join([*parts, PRIORITY_NOTE])
