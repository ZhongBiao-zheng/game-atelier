"""UI 页面 job helpers —— namespace='ui'，资产归项目：projects/<slug>/screens/<screen-id>/。

B3 起同时承载 screen 级定稿（projects/<slug>/screens/canonical.json）：风格候选选定后
指向那一张，后续延展页与 style.md 回写都以它为准。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root, projects
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.schemas import (
    Project,
    ScreenCanonicalEntry,
    ScreenCanonicalFile,
)

# screen_id 会成为路径组件：只放行小写字母/数字/连字符，防路径穿越与跨平台非法文件名。
SCREEN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def validate_screen_id(screen_id: str) -> str:
    if not SCREEN_ID_RE.match(screen_id or ""):
        raise ValueError(f"invalid screen_id: {screen_id!r}（只允许小写字母/数字/连字符）")
    return screen_id


def resolve_project(ref: str) -> Project:
    """按 id 或 slug 找项目 —— CLI 面向画师用 slug，job JSON 存 id。"""
    f = projects.read_projects()
    for p in f.projects:
        if p.id == ref or p.slug == ref:
            return p
    raise KeyError(f"project not found: {ref!r}")


def project_slug(project_id: str) -> str:
    f = projects.read_projects()
    for p in f.projects:
        if p.id == project_id:
            return p.slug
    raise KeyError(f"project not found: {project_id!r}")


def screens_dir(slug: str) -> Path:
    return data_root.projects_dir() / slug / "screens"


def screen_output_dir(project_id: str | None, screen_id: str | None) -> Path:
    if not project_id or not screen_id:
        raise ValueError("ui job requires project_id and screen_id")
    validate_screen_id(screen_id)
    return screens_dir(project_slug(project_id)) / screen_id


# ---------- screen 定稿（B3） ----------

def _canonical_path(slug: str) -> Path:
    return screens_dir(slug) / "canonical.json"


def read_screen_canonical(project_id: str) -> ScreenCanonicalFile:
    p = _canonical_path(project_slug(project_id))
    if not p.exists():
        return ScreenCanonicalFile()
    try:
        return ScreenCanonicalFile.model_validate(json.loads(p.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError):
        # 损坏的定稿文件不该拖垮项目页 —— 当作未定稿，重新设定即自愈（同角色 canonical）。
        return ScreenCanonicalFile()


def _write_screen_canonical(project_id: str, file: ScreenCanonicalFile) -> ScreenCanonicalFile:
    atomic_write_text(_canonical_path(project_slug(project_id)), file.model_dump_json(indent=2))
    return file


def _normalize_screen_path(project_id: str, screen_id: str, path: str) -> str:
    """绝对 / data-root 相对路径都接受；校验存在且在该 screen 自己的目录下，返回相对路径。"""
    root = data_root.resolve_data_root().resolve()
    p = Path(path)
    abs_p = (p if p.is_absolute() else root / p).resolve()
    target_dir = screen_output_dir(project_id, screen_id).resolve()
    if not abs_p.is_file():
        raise FileNotFoundError(f"screen canonical target not found: {abs_p}")
    if abs_p.parent != target_dir:
        raise ValueError(f"screen canonical target must live in {target_dir}, got {abs_p}")
    return abs_p.relative_to(root).as_posix()


def variant_of_path(rel_or_abs_path: str) -> str:
    """从产出这张图的 job 反查风格标签 —— 定稿时不必让画师重复输入已经在案的值。"""
    from character_workflow.lib.jobs import list_jobs

    root = data_root.resolve_data_root().resolve()
    p = Path(rel_or_abs_path)
    target = (p if p.is_absolute() else root / p).resolve()
    for job in list_jobs():
        for raw in job.output_paths:
            candidate = Path(raw)
            absolute = candidate if candidate.is_absolute() else root / candidate
            if absolute.resolve() == target:
                return job.params.style_variant or ""
    return ""


def set_screen_canonical(
    project_id: str, screen_id: str, path: str, style_variant: str | None = None,
) -> ScreenCanonicalFile:
    rel = _normalize_screen_path(project_id, screen_id, path)
    entry = ScreenCanonicalEntry(
        path=rel,
        set_at=datetime.now(timezone.utc).isoformat(),
        # 省略时从 job 反查，画师不用重复报已经记在 job 里的风格标签。
        style_variant=style_variant if style_variant is not None else variant_of_path(rel),
    )
    file = read_screen_canonical(project_id)
    file.screens[screen_id] = entry
    return _write_screen_canonical(project_id, file)


def clear_screen_canonical(project_id: str, screen_id: str) -> ScreenCanonicalFile:
    file = read_screen_canonical(project_id)
    file.screens.pop(screen_id, None)
    return _write_screen_canonical(project_id, file)
