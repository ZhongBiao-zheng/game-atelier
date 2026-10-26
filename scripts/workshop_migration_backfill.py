#!/usr/bin/env python3
"""工坊迁移补迁：迁移脚本跳过的角色按 projects.json assignments 追加到已迁移画布。

由 scripts/migrate_workshop_oneclick.py 复制进旧版代码（92f1bd98）的工作树里运行，依赖那一版的模块。
规则与迁移脚本一致：每个角色一个分组，含档案 spec.md 与各槽位 vN 图片；canonical.json 定稿图登记为
「角色」类别。追加在画布现有内容下方。--dry-run 不写盘。重复运行按节点 ID 跳过已有内容。
没有分配记录、或分配到的项目没有迁移画布的角色不迁，列在报告的 unplaced 里。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from character_workflow.lib.atomic_io import atomic_write_json  # noqa: E402
from character_workflow.lib.canvas_agent_layout import _locked_size  # noqa: E402
from character_workflow.lib.canvas_library import _content_node  # noqa: E402
from character_workflow.lib.canvas_projects import (  # noqa: E402
    _display_image_dimensions, _now, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.canvas_specs import validate_text  # noqa: E402
from character_workflow.lib.creation_assets import create_media_asset_from_path  # noqa: E402
from character_workflow.lib.file_lock import file_lock  # noqa: E402
from character_workflow.lib.schemas import (  # noqa: E402
    CanvasDocument, CanvasGroupNode, CanvasGroupNodeData, CanvasGroupSize, CanvasPoint,
    CanvasProject, CanvasSize, CanvasTextNode, CanvasTextNodeData, CanvasTextVersion,
    CanvasUserEditOrigin,
)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VERSION = re.compile(r"^v(\d+)\.[^.]+$")
SLOTS = [("portrait", "立绘"), ("promo", "美宣"), ("turnaround", "三视图")]


def identity(prefix: str, value: str) -> str:
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:20]


def inside(root: Path, path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"来源路径越界：{path}")
    return resolved


def heading(text: str, fallback: str) -> str:
    match = re.match(r"^---\s*\n(.*?)\n---(?:\n|$)", text, re.DOTALL)
    meta = yaml.safe_load(match[1]) if match else {}
    name = meta.get("name") if isinstance(meta, dict) else None
    if isinstance(name, str) and name.strip():
        return name.strip()[:120]
    found = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    return (found[1].strip() if found else fallback)[:120]


def item(root: Path, path: Path, title: str, category: str | None) -> dict:
    path = inside(root, path)
    body = path.read_bytes()
    if path.suffix.lower() == ".md":
        text = validate_text(body.decode("utf-8-sig"))
        return {"path": path, "relative": path.relative_to(root).as_posix(), "title": title[:120],
                "kind": "text", "digest": hashlib.sha256(text.encode()).hexdigest(),
                "width": 320.0, "height": 240.0, "category": None, "text": text}
    dims = _display_image_dimensions(body)
    width, height = _locked_size(None, *dims) if dims else (320, 180)
    return {"path": path, "relative": path.relative_to(root).as_posix(), "title": title[:120],
            "kind": "image", "digest": hashlib.sha256(body).hexdigest(),
            "width": float(width), "height": float(height), "category": category}


def plan(root: Path, characters: list[str]) -> tuple[list[dict], list[dict]]:
    catalog = json.loads((root / ".runtime/projects.json").read_text(encoding="utf-8"))
    projects = {p["id"]: p for p in catalog["projects"]}
    canvases = {}
    for path in (root / "canvases").glob("*/project.json"):
        project = CanvasProject.model_validate_json(path.read_text())
        if project.migrated_from_workshop:
            canvases[project.migrated_from_workshop] = project
    groups, unplaced = [], []
    for character in characters:
        directory = inside(root, root / "characters" / character)
        owner = projects.get(catalog.get("assignments", {}).get(character))
        canvas = canvases.get(owner["slug"]) if owner else None
        if canvas is None:
            unplaced.append({"character": character,
                             "reason": "没有分配记录" if owner is None else f"{owner['name']} 没有迁移画布"})
            continue
        spec = directory / "spec.md"
        text = spec.read_text(encoding="utf-8-sig") if spec.is_file() else ""
        title = heading(text, character)
        canonical_file = directory / "canonical.json"
        canonical = json.loads(canonical_file.read_text()) if canonical_file.is_file() else {}
        items = [item(root, spec, f"{title} · 档案", None)] if spec.is_file() else []
        for slot, label in SLOTS:
            selected = (canonical.get(slot) or {}).get("path")
            selected_path = inside(root, root / selected) if selected else None
            files = sorted((p for p in (directory / slot).glob("v*.*")
                            if p.is_file() and VERSION.fullmatch(p.name) and p.suffix.lower() in IMAGE_EXTS),
                           key=lambda p: int(VERSION.fullmatch(p.name)[1]))
            if selected_path and selected_path not in [p.resolve() for p in files]:
                raise ValueError(f"定稿文件缺失：{character}/{slot}")
            for path in files:
                items.append(item(root, path, f"{title} · {label} {path.stem}",
                                  "角色" if path.resolve() == selected_path else None))
        taken = {x["path"] for x in items}
        not_migrated = sorted(p.relative_to(directory).as_posix() for p in directory.rglob("*")
                              if p.is_file() and not p.name.startswith(".") and p.resolve() not in taken)
        groups.append({"character": character, "title": title, "project": owner["name"],
                       "slug": owner["slug"], "canvas_project_id": canvas.project_id, "items": items,
                       "not_migrated": not_migrated})
    return groups, unplaced


def summary(group: dict, status: str) -> dict:
    items = group["items"]
    return {"character": group["character"], "title": group["title"], "project": group["project"],
            "canvas_project_id": group["canvas_project_id"], "status": status,
            "nodes": len(items) + 1, "texts": sum(x["kind"] == "text" for x in items),
            "media": sum(x["kind"] == "image" for x in items),
            "finalized": sum(x["category"] is not None for x in items),
            "media_files": [x["relative"] for x in items if x["kind"] == "image"],
            "not_migrated": group["not_migrated"]}


def content_bottom(document: CanvasDocument) -> float:
    return max((n.position.y + n.size.height for n in document.nodes), default=-160.0)


def append_group(root: Path, group: dict) -> str:
    project_id = group["canvas_project_id"]
    group_id = identity("migration-group-", f"character:{group['character']}")
    document = read_canvas_document(project_id)
    if any(n.id == group_id for n in document.nodes):
        return "already_migrated"
    # 起点写日志：中断后重跑沿用同一位置，已写入的节点按 ID 跳过。
    journal = root / ".runtime/workshop-migrations" / f"backfill-{group['character']}.json"
    if journal.is_file():
        y = json.loads(journal.read_text())["y"]
    else:
        y = content_bottom(document) + 160
        atomic_write_json(journal, {"project_id": project_id, "y": y})
    items = group["items"]
    positions = []
    for offset in range(0, len(items), 4):
        row_y = y + 48 + sum(max(x["height"] for x in items[s:s + 4]) + 48 for s in range(0, offset, 4))
        left = 40.0
        for source in items[offset:offset + 4]:
            positions.append(CanvasPoint(x=left, y=row_y))
            left += source["width"] + 48
    members = []
    for source, position in zip(items, positions, strict=True):
        node_id = identity("migration-", source["relative"])
        members.append(node_id)
        existing = next((n for n in document.nodes if n.id == node_id), None)
        if existing:
            version = document.content_versions.get(getattr(existing.data, "current_version_id", None))
            if version is None or version.sha256 != source["digest"]:
                raise ValueError(f"部分补迁内容已被修改：{source['relative']}")
        elif source["kind"] == "text":
            version = CanvasTextVersion(version_id=identity("migration-text-", source["relative"]),
                created_at=_now(), sha256=source["digest"], origin=CanvasUserEditOrigin(kind="user_edit"),
                kind="text", text=source["text"])
            node = CanvasTextNode(id=node_id, title=source["title"], type="text", position=position,
                size=CanvasSize(width=source["width"], height=source["height"]),
                data=CanvasTextNodeData(current_version_id=version.version_id))
            changed = CanvasDocument.model_validate(document.model_dump() | {
                "nodes": [*document.nodes, node],
                "content_versions": {**document.content_versions, version.version_id: version}})
            document = save_canvas_document(project_id, changed, document.revision)
        else:
            def node_factory(version, source=source, position=position, node_id=node_id):
                node = _content_node(version.version_id, source["title"], position, "image")
                return node.model_copy(update={"id": node_id,
                    "size": CanvasSize(width=source["width"], height=source["height"])})
            path = source["path"]
            _version, document, _filename = save_canvas_upload(project_id, path.name, path.suffix.lower(),
                path.read_bytes(), "image", document.revision, node_factory=node_factory)
        if source["category"]:
            create_media_asset_from_path(title=source["title"], source_path=source["relative"], tags=[],
                project_id=project_id, allow_existing=True, category=source["category"])
    bottom = max(p.y + x["height"] for p, x in zip(positions, items, strict=True))
    right = max(p.x + x["width"] for p, x in zip(positions, items, strict=True))
    node = CanvasGroupNode(id=group_id, title=group["title"], type="group", position=CanvasPoint(x=0, y=y),
        size=CanvasGroupSize(width=right + 40, height=bottom - y + 40),
        data=CanvasGroupNodeData(member_node_ids=members))
    changed = CanvasDocument.model_validate(document.model_dump() | {"nodes": [*document.nodes, node]})
    save_canvas_document(project_id, changed, document.revision)
    return "migrated"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--character", action="append", default=[], help="迁移脚本跳过的角色 id，可重复")
    args = parser.parse_args()
    root = args.data_root.expanduser().resolve(strict=True)
    os.environ["GAME_ATELIER_DATA_ROOT"] = str(root)
    groups, unplaced = plan(root, args.character)
    report = {"data_root": str(root), "dry_run": args.dry_run, "characters": [], "unplaced": unplaced}
    if args.dry_run:
        for group in groups:
            document = read_canvas_document(group["canvas_project_id"])
            group_id = identity("migration-group-", f"character:{group['character']}")
            status = "already_migrated" if any(n.id == group_id for n in document.nodes) else "planned"
            report["characters"].append(summary(group, status))
    else:
        with file_lock(root / ".runtime/locks/workshop-migration.lock"):
            for group in groups:
                report["characters"].append(summary(group, append_group(root, group)))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"补迁停止：{error}", file=sys.stderr)
        raise SystemExit(1) from error
