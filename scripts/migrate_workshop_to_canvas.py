#!/usr/bin/env python3
"""Copy workshop projects into Canvas. --dry-run never writes to the data root."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text  # noqa: E402
from character_workflow.lib.canvas_agent_layout import _locked_size  # noqa: E402
from character_workflow.lib.canvas_library import _content_node  # noqa: E402
from character_workflow.lib.canvas_projects import (  # noqa: E402
    _display_image_dimensions, _now, canvas_project_dir, canvas_project_lock_path,
    create_canvas_project, read_canvas_document, read_canvas_project,
    save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.canvas_specs import validate_text, write_spec  # noqa: E402
from character_workflow.lib.canonical import read_canonical  # noqa: E402
from character_workflow.lib.creation_assets import create_media_asset_from_path  # noqa: E402
from character_workflow.lib.file_lock import file_lock  # noqa: E402
from character_workflow.lib.media_probe import mp4_track_dimensions  # noqa: E402
from character_workflow.lib.projects import read_projects  # noqa: E402
from character_workflow.lib.schemas import (  # noqa: E402
    CanvasDocument, CanvasGroupNode, CanvasGroupNodeData, CanvasGroupSize, CanvasPoint,
    CanvasProject, CanvasSize, CanvasTextNode, CanvasTextNodeData, CanvasTextVersion,
    CanvasUserEditOrigin,
)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".webm"}
VERSION = re.compile(r"^v(\d+)\.[^.]+$")


def identity(prefix: str, value: str) -> str:
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:20]


def inside(root: Path, path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"来源路径越界：{path}")
    return resolved


def read_text(root: Path, path: Path) -> str:
    return validate_text(inside(root, path).read_text(encoding="utf-8-sig"))


def version_files(directory: Path, suffixes: set[str]) -> list[Path]:
    return sorted((p for p in directory.glob("v*.*") if p.is_file()
                   and VERSION.fullmatch(p.name) and p.suffix.lower() in suffixes),
                  key=lambda p: (int(VERSION.fullmatch(p.name)[1]), p.suffix))


def frontmatter(text: str) -> dict:
    match = re.match(r"^---\s*\n(.*?)\n---(?:\n|$)", text, re.DOTALL)
    if not match:
        return {}
    value = yaml.safe_load(match[1])
    if not isinstance(value, dict):
        raise ValueError("档案 frontmatter 必须是键值表")
    return value


def heading(text: str, fallback: str) -> str:
    meta = frontmatter(text)
    name = meta.get("name") or meta.get("title")
    if isinstance(name, str) and name.strip():
        return name.strip()[:120]
    match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    return (match[1].strip() if match else fallback)[:120]


@dataclass
class Item:
    path: Path
    relative: str
    title: str
    kind: str
    digest: str
    width: float
    height: float
    category: str | None = None


@dataclass
class Group:
    key: str
    title: str
    items: list[Item] = field(default_factory=list)


@dataclass
class Plan:
    slug: str
    name: str
    spec: str
    lessons: str
    groups: list[Group] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def fingerprint(self) -> str:
        data = {"spec": self.spec, "lessons": self.lessons, "groups": [
            {"key": g.key, "title": g.title, "items": [
                [x.relative, x.digest, x.category] for x in g.items]} for g in self.groups]}
        return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

    def summary(self) -> dict:
        items = [x for g in self.groups for x in g.items]
        return {"slug": self.slug, "name": self.name, "source_fingerprint": self.fingerprint(), "nodes": len(items) + len(self.groups),
                "groups": len(self.groups), "media": sum(x.kind != "text" for x in items),
                "texts": sum(x.kind == "text" for x in items),
                "finalized": sum(x.category is not None for x in items), "warnings": self.warnings}


def item(root: Path, path: Path, title: str, category: str | None = None) -> Item:
    path = inside(root, path)
    body = path.read_bytes()
    if path.suffix.lower() == ".md":
        text = validate_text(body.decode("utf-8-sig"))
        kind, size = "text", (320, 240)
        digest = hashlib.sha256(text.encode()).hexdigest()
    else:
        kind = "image" if path.suffix.lower() in IMAGE_EXTS else "video"
        dims = _display_image_dimensions(body) if kind == "image" else mp4_track_dimensions(body)
        size = _locked_size(None, *dims) if dims else (320, 180)
        digest = hashlib.sha256(body).hexdigest()
    return Item(path, path.relative_to(root).as_posix(), title[:120], kind, digest, *size, category)


def plans(root: Path, requested: str | None) -> tuple[list[Plan], list[dict]]:
    catalog = read_projects()
    by_id = {p.id: p for p in catalog.projects}
    by_slug = {p.slug: p for p in catalog.projects}
    if requested and requested not in by_slug:
        raise ValueError(f"工坊项目不存在：{requested}")
    result = {}
    for project in catalog.projects:
        if requested and project.slug != requested:
            continue
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", project.slug):
            raise ValueError(f"项目 slug 不合法：{project.slug}")
        directory = inside(root, root / "projects" / project.slug)
        sections = []
        for label, path in [("世界观", directory / "worldview.md"), ("视觉方向", directory / "style.md"),
                            *[(name.upper(), directory / "design" / f"{name}.md")
                              for name in ("gdd", "prd", "interaction")],
                            *[(f"UI 方案 {p.parent.name}", p) for p in sorted(directory.glob("ui/*/style.md"))]]:
            if path.is_file():
                sections.append(f"## {label}\n\n{read_text(root, path)}")
        memory = directory / "MEMORY.md"
        lessons = "## 待审\n\n## 已采纳\n\n" + (read_text(root, memory) if memory.is_file() else "")
        result[project.id] = Plan(project.slug, project.name, validate_text("\n\n".join(sections)),
                                  validate_text(lessons))

    skipped = []
    for directory in sorted((root / "characters").glob("*")):
        if not directory.is_dir() or directory.name.startswith("."):
            continue
        spec = directory / "spec.md"
        text = read_text(root, spec) if spec.is_file() else ""
        ref = frontmatter(text).get("project")
        ref = ref.strip() if isinstance(ref, str) else None
        declared = by_id.get(ref) or by_slug.get(ref)
        assignment = catalog.assignments.get(directory.name)
        assigned = by_id.get(assignment)
        # The plan explicitly excludes missing/unknown spec ownership. Report discrepancies
        # instead of silently choosing between an old spec and the current assignments table.
        if declared is None or (assignment and (assigned is None or assigned.id != declared.id)):
            skipped.append({"character": directory.name, "assignment": assignment, "spec_project": ref,
                            "reason": "档案归属缺失或未登记" if declared is None else "分配表与档案归属不一致"})
            continue
        owner = assigned or declared
        if owner.id not in result:
            continue
        plan = result[owner.id]
        title = heading(text, directory.name)
        group = Group(f"character:{directory.name}", title)
        if spec.is_file():
            group.items.append(item(root, spec, f"{title} · 档案"))
        canonical = read_canonical(directory.name)
        for slot, label in [("portrait", "立绘"), ("promo", "美宣"), ("turnaround", "三视图")]:
            selected = getattr(canonical, slot)
            canonical_path = inside(root, root / selected.path) if selected else None
            files = version_files(directory / slot, IMAGE_EXTS)
            if canonical_path and canonical_path not in [p.resolve() for p in files]:
                raise ValueError(f"定稿文件缺失或非数字版本：{directory.name}/{slot}")
            for path in files:
                category = "角色" if path.resolve() == canonical_path else None
                group.items.append(item(root, path, f"{title} · {label} {path.stem}", category))
        if group.items:
            plan.groups.append(group)

    for plan in result.values():
        directory = root / "projects" / plan.slug
        for screens in sorted(directory.glob("ui/*/screens")):
            canonical_path = screens / "canonical.json"
            canonical = json.loads(read_text(root, canonical_path)).get("screens", {}) if canonical_path.is_file() else {}
            page_names = {p.name for p in screens.iterdir() if p.is_dir()}
            page_names |= {p.stem for p in screens.glob("*.md") if p.stem != "screen-map"}
            for page in sorted(page_names):
                page_dir = screens / page
                spec = screens / f"{page}.md"
                title = heading(read_text(root, spec), page) if spec.is_file() else page
                group = Group(f"ui:{screens.parent.name}:{page}", f"{screens.parent.name} · {title}"[:120])
                if spec.is_file():
                    group.items.append(item(root, spec, f"{title} · 页面规范"))
                entry = canonical.get(page)
                selected = inside(root, root / entry["path"]) if entry else None
                media = version_files(page_dir, IMAGE_EXTS)
                if selected and selected not in [p.resolve() for p in media]:
                    raise ValueError(f"UI 定稿文件缺失：{plan.slug}/{page}")
                for path in media:
                    group.items.append(item(root, path, f"{title} {path.stem}", "界面" if path.resolve() == selected else None))
                for path in version_files(page_dir, {".md"}):
                    group.items.append(item(root, path, f"{title} · {path.stem} 记录"))
                if group.items:
                    plan.groups.append(group)
        for production in sorted(directory.glob("videos/*")):
            if not production.is_dir():
                continue
            group = Group(f"video:{production.name}", production.name[:120])
            for name in ("brief.md", "prompt.md"):
                path = production / name
                if path.is_file():
                    group.items.append(item(root, path, f"{production.name} · {name}"))
            for path in version_files(production / "versions", VIDEO_EXTS | {".md"}):
                group.items.append(item(root, path, f"{production.name} · {path.name}"))
            if group.items:
                plan.groups.append(group)
    categories_by_digest = {}
    for plan in result.values():
        for group in plan.groups:
            for source in group.items:
                if source.category:
                    previous = categories_by_digest.setdefault(source.digest, source.category)
                    if previous != source.category:
                        raise ValueError(f"同一媒体被定稿为不同类别：{source.relative}")
    return list(result.values()), skipped


def migrated(root: Path) -> dict[str, str]:
    result = {}
    for path in (root / "canvases").glob("*/project.json"):
        project = CanvasProject.model_validate_json(path.read_text())
        if project.migrated_from_workshop:
            if project.migrated_from_workshop in result:
                raise ValueError(f"重复迁移来源：{project.migrated_from_workshop}")
            result[project.migrated_from_workshop] = project.project_id
    return result


def migrate(root: Path, plan: Plan) -> str:
    journal = root / ".runtime/workshop-migrations" / f"{plan.slug}.json"
    fingerprint = plan.fingerprint()
    if journal.is_file():
        pending = json.loads(journal.read_text())
        if pending["fingerprint"] != fingerprint:
            raise ValueError(f"{plan.slug} 未完成迁移的来源已变化，请检查原记录")
        project_id = pending["project_id"]
        read_canvas_project(project_id)
    else:
        project_id = create_canvas_project(plan.name).project_id
        atomic_write_json(journal, {"project_id": project_id, "fingerprint": fingerprint})
    document = read_canvas_document(project_id)
    y = 0.0
    for group in plan.groups:
        members = []
        positions = []
        for offset in range(0, len(group.items), 4):
            row = group.items[offset:offset + 4]
            row_y = y + 48 + sum(max(x.height for x in group.items[start:start + 4]) + 48
                                 for start in range(0, offset, 4))
            left = 40.0
            for source in row:
                positions.append(CanvasPoint(x=left, y=row_y))
                left += source.width + 48
        for source, position in zip(group.items, positions, strict=True):
            node_id = identity("migration-", source.relative)
            members.append(node_id)
            existing = next((n for n in document.nodes if n.id == node_id), None)
            if existing:
                version = document.content_versions.get(getattr(existing.data, "current_version_id", None))
                if version is None or version.sha256 != source.digest:
                    raise ValueError(f"部分迁移内容已被修改：{source.relative}")
            elif source.kind == "text":
                version = CanvasTextVersion(version_id=identity("migration-text-", source.relative),
                    created_at=_now(), sha256=source.digest, origin=CanvasUserEditOrigin(kind="user_edit"),
                    kind="text", text=read_text(root, source.path))
                node = CanvasTextNode(id=node_id, title=source.title, type="text", position=position,
                    size=CanvasSize(width=source.width, height=source.height),
                    data=CanvasTextNodeData(current_version_id=version.version_id))
                changed = CanvasDocument.model_validate(document.model_dump() | {
                    "nodes": [*document.nodes, node],
                    "content_versions": {**document.content_versions, version.version_id: version}})
                document = save_canvas_document(project_id, changed, document.revision)
            else:
                def node_factory(version, source=source, position=position, node_id=node_id):
                    node = _content_node(version.version_id, source.title, position, source.kind)
                    return node.model_copy(update={"id": node_id,
                        "size": CanvasSize(width=source.width, height=source.height)})
                _version, document, _filename = save_canvas_upload(project_id, source.path.name,
                    source.path.suffix.lower(), source.path.read_bytes(), source.kind,
                    document.revision, node_factory=node_factory)
            if source.category:
                create_media_asset_from_path(title=source.title, source_path=source.relative,
                    tags=[], project_id=project_id, allow_existing=True, category=source.category)
        group_id = identity("migration-group-", group.key)
        bottom = max((p.y + x.height for p, x in zip(positions, group.items, strict=True)), default=y + 100)
        right = max((p.x + x.width for p, x in zip(positions, group.items, strict=True)), default=400)
        if not any(n.id == group_id for n in document.nodes):
            node = CanvasGroupNode(id=group_id, title=group.title, type="group", position=CanvasPoint(x=0,y=y),
                size=CanvasGroupSize(width=right + 40, height=bottom - y + 40),
                data=CanvasGroupNodeData(member_node_ids=members))
            changed = CanvasDocument.model_validate(document.model_dump() | {"nodes": [*document.nodes, node]})
            document = save_canvas_document(project_id, changed, document.revision)
        y = bottom + 160
    write_spec(project_id, plan.spec)
    with file_lock(canvas_project_lock_path(project_id)):
        target = canvas_project_dir(project_id)
        atomic_write_text(target / "agent/lessons.md", plan.lessons)
        project = read_canvas_project(project_id)
        categories = list(project.categories)
        if any(group.key.startswith("ui:") for group in plan.groups) and "界面" not in categories:
            categories.append("界面")
        updated = CanvasProject.model_validate(project.model_dump() | {
            "categories": categories, "migrated_from_workshop": plan.slug, "updated_at": _now()})
        # Completion marker is the final write; interrupted runs resume via the journal.
        atomic_write_json(target / "project.json", updated.model_dump(mode="json"))
    return project_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--project", help="Only migrate this workshop slug")
    args = parser.parse_args()
    root = args.data_root.expanduser().resolve(strict=True)
    os.environ["GAME_ATELIER_DATA_ROOT"] = str(root)
    prepared, skipped = plans(root, args.project)
    completed = migrated(root)
    report = {"data_root": str(root), "dry_run": args.dry_run, "projects": [], "skipped_characters": skipped}
    if args.dry_run:
        for plan in prepared:
            report["projects"].append(plan.summary() | {"status": "already_migrated" if plan.slug in completed else "planned",
                "canvas_project_id": completed.get(plan.slug)})
    else:
        with file_lock(root / ".runtime/locks/workshop-migration.lock"):
            completed = migrated(root)
            for plan in prepared:
                project_id = completed.get(plan.slug)
                status = "already_migrated" if project_id else "migrated"
                project_id = project_id or migrate(root, plan)
                report["projects"].append(plan.summary() | {"status": status, "canvas_project_id": project_id})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"迁移停止：{error}", file=sys.stderr)
        raise SystemExit(1) from error
