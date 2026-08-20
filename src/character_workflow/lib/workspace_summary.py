"""项目工作区只读摘要：从文件事实推导，不保存第二份进度。"""
from __future__ import annotations

import re
from pathlib import Path

from character_workflow.lib import data_root, stale
from character_workflow.lib.projects import read_projects
from character_workflow.lib.schemas import (
    ArtWorkspaceSummary,
    ProjectWorkspaceSummary,
    UiScreenSummary,
    UiWorkspaceSummary,
    VideoWorkspaceSummary,
)
from character_workflow.lib.video_jobs import list_productions


UI_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def document_status(path: Path) -> str:
    """文档存在但未声明 status 时按 draft，不把“存在”脑补成“批准”。"""
    if not path.is_file():
        return "missing"
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return "missing"
    match = re.search(r"^status:\s*([a-z_-]+)\s*$", text, re.MULTILINE | re.IGNORECASE)
    return match.group(1).lower() if match else "draft"


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_screen_map(path: Path) -> list[UiScreenSummary]:
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return []

    lines = text.splitlines()
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if "screen-id" in line.lower() and "优先级" in line and "状态" in line
        ),
        None,
    )
    if header_index is None:
        return []
    headers = _table_cells(lines[header_index])
    rows: list[UiScreenSummary] = []
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = _table_cells(line)
        if len(cells) != len(headers):
            continue
        item = dict(zip(headers, cells, strict=True))
        screen_id = item.get("screen-id", "")
        if not screen_id or screen_id.startswith("<"):
            continue
        contract = re.search(
            rf"^##\s+screen\.{re.escape(screen_id)}\s*$([\s\S]*?)(?=^##\s+|\Z)",
            text,
            re.MULTILINE,
        )
        purpose_match = (
            re.search(r"^-\s*purpose:\s*(.+?)\s*$", contract.group(1), re.MULTILINE)
            if contract
            else None
        )
        brief_path = path.parent / f"{screen_id}.md"
        brief_summary = ""
        if brief_path.is_file():
            try:
                brief_text = brief_path.read_text(encoding="utf-8-sig")
            except OSError:
                brief_text = ""
            target_match = re.search(
                r"^-\s*页面目标:\s*(.+?)\s*$",
                brief_text,
                re.MULTILINE,
            )
            brief_summary = target_match.group(1).strip() if target_match else ""
        rows.append(UiScreenSummary(
            screen_id=screen_id,
            name=item.get("名称", screen_id),
            category=item.get("分类", ""),
            priority=item.get("优先级", ""),
            status=item.get("状态", "planned"),
            dependency=item.get("依赖", ""),
            purpose=purpose_match.group(1).strip() if purpose_match else "",
            brief_summary=brief_summary,
        ))
    return rows


def project_workspace_summary(project_id: str) -> ProjectWorkspaceSummary:
    projects_file = read_projects()
    project = next((item for item in projects_file.projects if item.id == project_id), None)
    if project is None:
        raise KeyError(f"project not found: {project_id!r}")

    project_dir = data_root.projects_dir() / project.slug
    design_dir = project_dir / "design"
    screens_dir = project_dir / "screens"
    anchors = {
        name: document_status(design_dir / f"{name}.md")
        for name in ("gdd", "prd", "interaction")
    }
    style_path = project_dir / "style.md"
    style_status = document_status(style_path)
    try:
        style_text = style_path.read_text(encoding="utf-8-sig") if style_path.is_file() else ""
    except OSError:
        style_text = ""
    has_ui_style = bool(re.search(r"^##\s+ui(?:\.|\b)", style_text, re.MULTILINE | re.IGNORECASE))

    screen_dirs = sorted(path for path in screens_dir.iterdir() if path.is_dir()) if screens_dir.is_dir() else []
    versions = sum(
        1
        for directory in screen_dirs
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in UI_IMAGE_EXTENSIONS
    )
    screen_canonical = stale.screen_canonical_status(project_id)
    canonical_count = len(screen_canonical.screens)
    stale_count = sum(1 for entry in screen_canonical.screens.values() if entry.style_stale)
    anchors_approved = sum(1 for status in anchors.values() if status == "approved")
    screen_map_path = screens_dir / "screen-map.md"
    screen_map_status = document_status(screen_map_path)
    screen_items = parse_screen_map(screen_map_path)
    screen_count = len({path.name for path in screen_dirs} | {item.screen_id for item in screen_items})

    if anchors_approved < 3:
        next_action, next_command = "建立并批准 UI 策划锚", "/game-atelier:ui-anchor"
    elif style_status == "missing" or not has_ui_style:
        next_action, next_command = "建立 UI 视觉规范", "/game-atelier:ui"
    elif not screen_dirs:
        next_action, next_command = "生成第一张基准页", "/game-atelier:ui-page"
    elif style_status != "approved" or canonical_count == 0:
        next_action, next_command = "完成风格定稿", "/game-atelier:ui-page"
    elif stale_count > 0:
        next_action, next_command = "重新定稿过时页面", "/game-atelier:ui-page"
    elif screen_map_status != "approved":
        next_action, next_command = "批准页面地图", "/game-atelier:ui-screens"
    elif screen_items and canonical_count >= screen_count:
        next_action, next_command = "复核 UI 页面交付", "/game-atelier:ui"
    else:
        next_action, next_command = "继续逐页生成", "/game-atelier:ui-page"

    member_ids = [
        character_id
        for character_id, owner_id in projects_file.assignments.items()
        if owner_id == project_id
    ]
    art_canonical = 0
    art_stale = 0
    for character_id in member_ids:
        status = stale.character_canonical_status(character_id)
        for slot in ("portrait", "promo", "turnaround"):
            entry = getattr(status, slot)
            if entry is None:
                continue
            art_canonical += 1
            if entry.spec_stale or entry.style_stale:
                art_stale += 1

    productions = list_productions(project_id)
    video_shots = sum(len(item.shots) for item in productions)
    selected_shots = sum(1 for item in productions for shot in item.shots if shot.selected)
    exports = sum(len(item.exports) for item in productions)

    return ProjectWorkspaceSummary(
        project_id=project_id,
        art=ArtWorkspaceSummary(
            characters=len(member_ids),
            canonical=art_canonical,
            stale=art_stale,
        ),
        ui=UiWorkspaceSummary(
            anchors=anchors,
            anchors_approved=anchors_approved,
            style_status=style_status,
            has_ui_style=has_ui_style,
            screen_map_status=screen_map_status,
            screens=screen_count,
            versions=versions,
            canonical=canonical_count,
            stale=stale_count,
            screen_items=screen_items,
            next_action=next_action,
            next_command=next_command,
        ),
        video=VideoWorkspaceSummary(
            productions=len(productions),
            shots=video_shots,
            selected_shots=selected_shots,
            exports=exports,
            next_action="建立第一个视频企划" if not productions else "继续视频企划",
        ),
    )
