"""UI 页面 job helpers —— namespace='ui'，资产归项目：projects/<slug>/screens/<screen-id>/。"""
from __future__ import annotations

import re
from pathlib import Path

from character_workflow.lib import data_root, projects
from character_workflow.lib.schemas import Project

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
