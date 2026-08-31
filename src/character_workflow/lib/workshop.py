"""Project-scoped Workshop operations shared by the Web and MCP transports."""
from __future__ import annotations

import hashlib
import base64
import io
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import Any, Callable

from character_workflow.lib import data_root, projects, ui_jobs, ui_schemes, video_jobs
from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.schemas import UiSchemeCreate
from character_workflow.lib.workshop_schema import (
    AcknowledgeFeedbackInput, CharacterTarget, CreateTargetInput, ListMediaInput,
    ListProjectsInput, ListTargetsInput, ReadDocumentInput, ReadMediaInput, TargetInput, UiTarget,
    VideoTarget, UiSchemeTarget, WorkshopTarget, WriteDocumentInput,
)


class WorkshopError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def root() -> Path:
    return safe_path(data_root.runtime_dir() / "workshop")


def actor_id(principal: Any) -> str:
    if principal is None or principal.kind not in {"local", "agent"}:
        raise WorkshopError("SESSION_REQUIRED", "请先连接本机工作区", 401)
    return "local" if principal.kind == "local" else principal.grant_id


def authorize(principal: Any, project_id: str, capability: str) -> Any:
    actor_id(principal)
    if principal.kind != "local" and (
        project_id not in principal.project_ids or capability not in principal.capabilities
    ):
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "当前授权不允许操作这个项目", 403)
    project = next((p for p in projects.read_projects().projects if p.id == project_id), None)
    if project is None:
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "目标不存在或不在当前授权中", 404)
    return project


def safe_path(path: Path) -> Path:
    base = data_root.resolve_data_root().resolve()
    if not path.is_absolute():
        path = base / path
    try:
        relative = path.relative_to(base)
    except ValueError:
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "文件不属于当前工作区", 403) from None
    cursor = base
    for part in relative.parts:
        if part in {"..", "."}:
            raise WorkshopError("REFERENCE_NOT_ALLOWED", "文件路径无效", 403)
        cursor = cursor / part
        if cursor.is_symlink():
            raise WorkshopError("REFERENCE_NOT_ALLOWED", "工坊不读取符号链接", 403)
    if not path.resolve().is_relative_to(base):
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "文件不属于当前工作区", 403)
    return path


def read_stable(path: Path, max_bytes: int) -> bytes:
    path = safe_path(path)
    before = path.stat()
    if before.st_size > max_bytes:
        raise WorkshopError("CONTENT_TOO_LARGE", "内容超过本次操作的大小限制", 413)
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise WorkshopError("DOCUMENT_CONFLICT", "内容已变化，请重新读取")
        value = handle.read(max_bytes + 1)
        after = os.fstat(handle.fileno())
    safe_path(path)
    current = path.stat()
    def signature(stat):
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns
    if signature(before) != signature(after) or signature(after) != signature(current):
        raise WorkshopError("DOCUMENT_CONFLICT", "内容已变化，请重新读取")
    if len(value) > max_bytes:
        raise WorkshopError("CONTENT_TOO_LARGE", "内容超过本次操作的大小限制", 413)
    return value


def resolve_target(principal: Any, target: WorkshopTarget, capability: str = "read") -> Path:
    project = authorize(principal, target.project_id, capability)
    if target.type == "character":
        if projects.read_projects().assignments.get(target.character_id) != project.id:
            raise WorkshopError("TARGET_NOT_AUTHORIZED", "角色不属于当前项目", 403)
        directory = safe_path(data_root.characters_dir() / target.character_id)
        exists = (directory / "spec.md").is_file()
    elif target.type in {"ui", "ui_scheme"}:
        try:
            project, scheme = ui_schemes.resolve_scheme(project.id, target.ui_scheme_id)
            if target.type == "ui":
                ui_jobs.validate_screen_id(target.screen_id)
        except (ValueError, KeyError, FileNotFoundError):
            raise WorkshopError("TARGET_NOT_AUTHORIZED", "UI 目标不存在", 404) from None
        screens = safe_path(ui_schemes.scheme_screens_dir(project, scheme.id))
        if target.type == "ui_scheme":
            return safe_path(screens.parent)
        directory = safe_path(screens / target.screen_id)
        exists = directory.is_dir() or (screens / f"{target.screen_id}.md").is_file()
    elif target.type == "project":
        return safe_path(data_root.projects_dir() / project.slug)
    else:
        directory = safe_path(video_jobs.production_dir(project.id, target.production_id))
        exists = (directory / "brief.md").is_file() and (directory / "prompt.md").is_file()
    if not exists:
        raise WorkshopError("TARGET_NOT_AUTHORIZED", "目标不存在或不在当前授权中", 404)
    return directory


def idempotent(principal: Any, operation: str, scope: Any, key: str,
               payload: Any, perform: Callable[[], dict],
               recover: Callable[[], dict | None] | None = None) -> dict:
    ledger_id = digest([actor_id(principal), operation, scope, key])
    path = root() / "operations" / f"{ledger_id}.json"
    fingerprint = digest(payload)
    with file_lock(path.with_suffix(".lock")):
        if path.is_file():
            record = json.loads(read_stable(path, 2 * 1024 * 1024))
            if record["fingerprint"] != fingerprint:
                raise WorkshopError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同内容")
            if "result" in record:
                return record["result"]
            if recover is not None:
                result = recover()
                if result is not None:
                    atomic_write_json(path, {"fingerprint": fingerprint, "result": result})
                    return result
        else:
            atomic_write_json(path, {"fingerprint": fingerprint})
        result = perform()
        atomic_write_json(path, {"fingerprint": fingerprint, "result": result})
        return result


def list_projects(principal: Any, payload: ListProjectsInput) -> dict:
    actor_id(principal)
    if principal.kind != "local" and "read" not in principal.capabilities:
        raise WorkshopError("CAPABILITY_DENIED", "当前授权没有读取能力", 403)
    values = [{"project_id": p.id, "name": p.name} for p in projects.read_projects().projects
              if principal.kind == "local" or p.id in principal.project_ids]
    return paginate(values, payload.page, payload.page_size, "projects")


def paginate(values: list, page: int, page_size: int, key: str) -> dict:
    return {key: values[(page - 1) * page_size:page * page_size], "page": page,
            "page_size": page_size, "total": len(values)}


def document_display_name(path: Path, fallback: str) -> str:
    """Read the existing name/title frontmatter or H1 convention, never an unbounded document."""
    try:
        text = read_stable(path, 800000).decode("utf-8-sig")
    except (OSError, UnicodeError, WorkshopError):
        return fallback
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for key in ("name", "title"):
                match = re.search(rf"^{key}:[ \t]*(.+?)[ \t]*$", text[3:end], re.MULTILINE)
                if match:
                    value = match.group(1).strip()
                    try:
                        decoded = json.loads(value)
                        if isinstance(decoded, str):
                            value = decoded
                    except json.JSONDecodeError:
                        if value.startswith("'") and value.endswith("'"):
                            value = value[1:-1].replace("''", "'")
                    value = " ".join(value.split())[:120]
                    if value:
                        return value
    for line in text.splitlines()[:20]:
        match = re.match(r"^#[ \t]+(.+?)[ \t]*$", line)
        if match:
            return match.group(1)[:120]
    return fallback


def target_display_name(target: WorkshopTarget, directory: Path) -> str:
    """Display metadata only: callers have already resolved and authorized the stable target."""
    if target.type == "character":
        return document_display_name(directory / "spec.md", target.character_id)
    if target.type == "ui":
        return document_display_name(directory.parent / f"{target.screen_id}.md", target.screen_id)
    if target.type == "video":
        return document_display_name(directory / "brief.md", target.production_id)
    return getattr(target, "ui_scheme_id", target.project_id)


def list_targets(principal: Any, payload: ListTargetsInput) -> dict:
    project = authorize(principal, payload.project_id, "read")
    result = []
    if payload.type in {None, "character"}:
        for character_id, owner in projects.read_projects().assignments.items():
            if owner != project.id:
                continue
            target = CharacterTarget(type="character", project_id=project.id,
                                     character_id=character_id, asset_slot="portrait")
            try:
                directory = resolve_target(principal, target)
            except (OSError, WorkshopError):
                continue
            result.append({"target": target.model_dump(), "name": target_display_name(target, directory)})
    if payload.type in {None, "ui"}:
        for scheme in ui_schemes.read_schemes(project.id).schemes:
            result.append({"target": UiSchemeTarget(type="ui_scheme", project_id=project.id,
                           ui_scheme_id=scheme.id).model_dump(), "name": scheme.name})
            screens = safe_path(ui_schemes.scheme_screens_dir(project, scheme.id))
            candidates = {p.name if p.is_dir() else p.stem for p in screens.iterdir()
                          if p.is_dir() or (p.suffix == ".md" and p.name != "screen-map.md")}
            for screen_id in sorted(candidates):
                try:
                    ui_jobs.validate_screen_id(screen_id)
                except ValueError:
                    continue
                target = UiTarget(type="ui", project_id=project.id,
                                  ui_scheme_id=scheme.id, screen_id=screen_id)
                name = target_display_name(target, screens / screen_id)
                result.append({"target": target.model_dump(), "name": f"{scheme.name} · {name}"})
    if payload.type in {None, "video"}:
        videos = safe_path(data_root.projects_dir() / project.slug / "videos")
        for directory in sorted(videos.iterdir() if videos.exists() else []):
            safe_path(directory)
            if not directory.is_dir() or not all(
                (directory / name).is_file() for name in ("brief.md", "prompt.md")
            ):
                continue
            try:
                video_jobs.validate_id(directory.name, "production_id")
            except ValueError:
                continue
            target = VideoTarget(type="video", project_id=project.id, production_id=directory.name)
            result.append({"target": target.model_dump(), "name": target_display_name(target, directory)})
    return paginate(result, payload.page, payload.page_size, "targets")


def document_paths(principal: Any, target: WorkshopTarget,
                   capability: str = "read") -> dict[str, Path]:
    directory = resolve_target(principal, target, capability)
    project = projects.resolve_project(target.project_id)
    project_root = safe_path(data_root.projects_dir() / project.slug)
    result = {"project_style": project_root / "style.md", "worldview": project_root / "worldview.md"}
    result.update({kind: project_root / "design" / f"{kind}.md"
                   for kind in ("gdd", "prd", "interaction")})
    if target.type == "character":
        result["character_spec"] = directory / "spec.md"
    elif target.type == "ui":
        result.update({"ui_style": directory.parent.parent / "style.md",
                       "screen_map": directory.parent / "screen-map.md",
                       "screen_brief": directory.parent / f"{target.screen_id}.md"})
    elif target.type == "ui_scheme":
        result.update({"ui_style": directory / "style.md",
                       "screen_map": directory / "screens" / "screen-map.md"})
    elif target.type == "video":
        result.update({"video_brief": directory / "brief.md", "video_prompt": directory / "prompt.md"})
    return result


def document_view(path: Path, kind: str, limit: int = 200000) -> dict:
    safe_path(path)
    body = read_stable(path, 800000) if path.is_file() else b""
    text = body.decode("utf-8-sig")
    return {"kind": kind, "content": text[:limit], "revision": hashlib.sha256(body).hexdigest(),
            "truncated": len(text) > limit, "exists": path.is_file()}


def read_document(principal: Any, payload: ReadDocumentInput) -> dict:
    path = document_paths(principal, payload.target).get(payload.kind)
    if path is None:
        raise WorkshopError("DOCUMENT_NOT_ALLOWED", "目标不支持这个文档类型", 422)
    return document_view(path, payload.kind)


def write_document(principal: Any, payload: WriteDocumentInput) -> dict:
    path = document_paths(principal, payload.target, "edit_documents").get(payload.kind)
    if path is None:
        raise WorkshopError("DOCUMENT_NOT_ALLOWED", "目标不支持这个文档类型", 422)
    def perform():
        return write_document_content(path, payload.kind, payload.expected_revision, payload.content)
    def recover():
        current = document_view(path, payload.kind)
        if not current["truncated"] and current["content"] == payload.content:
            return current
        return None
    return idempotent(principal, "write-document", payload.target.model_dump(),
                      payload.idempotency_key, payload.model_dump(), perform, recover)


def document_lock(path: Path):
    return file_lock(root() / "documents" / f"{digest(str(safe_path(path)))}.lock")


def write_document_content(path: Path, kind: str, expected_revision: str, content: str) -> dict:
    with document_lock(path):
        current = document_view(path, kind)
        if current["revision"] != expected_revision:
            raise WorkshopError("DOCUMENT_CONFLICT", "文档已修改，请读取最新版本再保存")
        if current["truncated"]:
            raise WorkshopError("CONTENT_TOO_LARGE", "文档超过编辑大小限制，请在本地文件中编辑", 413)
        atomic_write_text(safe_path(path), content)
        return document_view(path, kind)


def create_target(principal: Any, payload: CreateTargetInput) -> dict:
    project = authorize(principal, payload.project_id, "create_targets")
    if not payload.name.strip():
        raise WorkshopError("INVALID_TARGET", "名称不能为空", 422)
    if (payload.type == "ui_screen") != (payload.ui_scheme_id is not None):
        raise WorkshopError("INVALID_TARGET", "只有 UI 页面需要明确所属方案", 422)
    def perform():
        stable_id = "w-" + digest([actor_id(principal), payload.model_dump()])[:20]
        if payload.type == "character":
            from character_workflow.lib.character_derivatives import initialize_character_directory
            directory = safe_path(data_root.characters_dir() / stable_id)
            if not directory.exists():
                initialize_character_directory(stable_id, f"# {payload.name.strip()}\n")
            projects.assign_character(stable_id, project.id)
            target = CharacterTarget(type="character", project_id=project.id,
                                     character_id=stable_id, asset_slot="portrait")
        elif payload.type == "video":
            directory = safe_path(video_jobs.production_dir(project.id, stable_id))
            if not directory.exists():
                video_jobs.create_production(project.id, stable_id, payload.name)
            target = VideoTarget(type="video", project_id=project.id, production_id=stable_id)
        elif payload.type == "ui_screen":
            p, scheme = ui_schemes.resolve_scheme(project.id, payload.ui_scheme_id)
            screens = safe_path(ui_schemes.scheme_screens_dir(p, scheme.id))
            (screens / stable_id).mkdir(exist_ok=True)
            brief = safe_path(screens / f"{stable_id}.md")
            if not brief.exists():
                atomic_write_text(brief, f"# {payload.name.strip()}\n")
            target = UiTarget(type="ui", project_id=project.id,
                              ui_scheme_id=scheme.id, screen_id=stable_id)
        else:
            schemes = ui_schemes.create_scheme(project.id, UiSchemeCreate(name=payload.name),
                                               creation_request_id=stable_id)
            scheme = next(item for item in schemes.schemes if item.creation_request_id == stable_id)
            target = UiSchemeTarget(type="ui_scheme", project_id=project.id, ui_scheme_id=scheme.id)
        return {"target": target.model_dump(), "name": payload.name}
    return idempotent(principal, "create-target", project.id, payload.idempotency_key,
                      payload.model_dump(), perform)


def _feedback(target: WorkshopTarget) -> list[tuple[str, Path, str]]:
    if target.type != "character":
        return []
    result = []
    for path in sorted((data_root.runtime_dir() / "draft").glob("*.md")):
        content = read_stable(path, 200000).decode("utf-8-sig")
        if content.splitlines()[:1] == [f"<!-- character: {target.character_id} -->"]:
            result.append(("f-" + digest([path.name, content])[:32], path, content))
    return result


def acknowledge_feedback(principal: Any, payload: AcknowledgeFeedbackInput) -> dict:
    resolve_target(principal, payload.target, "edit_documents")
    def perform():
        with file_lock(root() / "feedback.lock"):
            available = {item[0]: item[1] for item in _feedback(payload.target)}
            processed = {}
            for feedback_id in payload.feedback_ids:
                path = safe_path(data_root.runtime_dir() / "draft-processed" / f"{feedback_id}.md")
                if path.is_file() and payload.target.type == "character":
                    content = read_stable(path, 200000).decode("utf-8-sig")
                    if content.splitlines()[:1] == [f"<!-- character: {payload.target.character_id} -->"]:
                        processed[feedback_id] = path
            if any(value not in available and value not in processed for value in payload.feedback_ids):
                raise WorkshopError("TARGET_NOT_AUTHORIZED", "反馈已变化或不属于当前目标", 403)
            for feedback_id in payload.feedback_ids:
                if feedback_id in processed:
                    continue
                destination = safe_path(data_root.runtime_dir() / "draft-processed" /
                                        f"{feedback_id}.md")
                destination.parent.mkdir(exist_ok=True)
                available[feedback_id].rename(destination)
            return {"acknowledged_ids": payload.feedback_ids}
    return idempotent(principal, "acknowledge-feedback", payload.target.model_dump(),
                      payload.idempotency_key, payload.model_dump(), perform)


def media_entries(principal: Any, target: WorkshopTarget) -> list[tuple[dict, Path]]:
    directory = resolve_target(principal, target)
    if target.type in {"project", "ui_scheme"}:
        return []
    paths: set[Path] = set()
    ui_canonical: dict[Path, dict] = {}
    for job in list_jobs():
        matches = (
            target.type == "character" and job.namespace == "character"
            and job.character_id == target.character_id
        ) or (
            target.type == "ui" and job.namespace == "ui" and job.project_id == target.project_id
            and job.ui_scheme_id == target.ui_scheme_id and job.screen_id == target.screen_id
        ) or (
            target.type == "video" and job.namespace == "video" and job.project_id == target.project_id
            and job.production_id == target.production_id
        )
        if matches:
            paths.update(Path(raw) for raw in job.output_paths)
    if target.type == "character":
        from character_workflow.lib.canonical import read_canonical
        safe_path(directory / "canonical.json")
        for entry in read_canonical(target.character_id).model_dump().values():
            if isinstance(entry, dict) and entry.get("path"):
                paths.add(Path(entry["path"]))
        # Source uploads are already scoped by the explicit character directory.
        paths.update((directory / "source").glob("*"))
    elif target.type == "ui":
        from character_workflow.lib.stale import screen_canonical_status
        project = projects.resolve_project(target.project_id)
        safe_path(directory.parent / "canonical.json")
        safe_path(data_root.projects_dir() / project.slug / "style.md")
        safe_path(directory.parent.parent / "style.md")
        for screen_id, entry in screen_canonical_status(
            target.project_id, target.ui_scheme_id
        ).screens.items():
            try:
                ui_jobs.validate_screen_id(screen_id)
            except ValueError:
                continue
            path = safe_path(Path(entry.path))
            source_directory = safe_path(ui_jobs.screen_output_dir(
                target.project_id, target.ui_scheme_id, screen_id))
            mime = mimetypes.guess_type(path.name)[0] or ""
            # Only the selected image from the same scheme, not another page's history.
            if path.parent != source_directory or not mime.startswith("image/"):
                continue
            paths.add(path)
            ui_canonical[path] = {"source_screen_id": screen_id, "is_canonical": True,
                                  "style_stale": entry.style_stale}
    elif target.type == "video":
        safe_path(directory / "references.json")
        paths.update(Path(raw) for raw in video_jobs.read_references(
            target.project_id, target.production_id))
    result = []
    seen: set[Path] = set()
    base = data_root.resolve_data_root().resolve()
    for candidate in sorted(paths):
        path = safe_path(candidate)
        if not path.is_file() or path in seen:
            continue
        if not path.is_relative_to(directory) and path not in ui_canonical:
            relative = path.relative_to(base).as_posix()
            if target.type != "video" or not video_jobs.is_project_reference_path(
                target.project_id, relative
            ):
                continue
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        kind = mime.split("/")[0]
        if kind not in {"image", "video", "audio"}:
            continue
        seen.add(path)
        result.append(({"media_id": media_id_for_path(target, path), "kind": kind, "title": path.name,
                        "mime_type": mime, "size_bytes": path.stat().st_size,
                        **ui_canonical.get(path, {})}, path))
    return result


def media_id_for_path(target: WorkshopTarget, path: Path) -> str:
    relative = safe_path(path).relative_to(data_root.resolve_data_root().resolve()).as_posix()
    return "m-" + digest([target.model_dump(), relative])[:40]


def list_media(principal: Any, payload: ListMediaInput) -> dict:
    return paginate([entry for entry, _ in media_entries(principal, payload.target)],
                    payload.page, payload.page_size, "media")


def resolve_media(principal: Any, payload: ReadMediaInput) -> tuple[dict, Path]:
    entry = next((item for item in media_entries(principal, payload.target)
                  if item[0]["media_id"] == payload.media_id), None)
    if entry is None:
        raise WorkshopError("REFERENCE_NOT_ALLOWED", "素材不存在或不属于当前目标", 403)
    return entry


def read_media(principal: Any, payload: ReadMediaInput) -> dict:
    entry, path = resolve_media(principal, payload)
    result = {**entry, "target": payload.target.model_dump()}
    if entry["kind"] == "image":
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(read_stable(path, 25 * 1024 * 1024))) as opened:
            if opened.width * opened.height > 40_000_000:
                raise WorkshopError("CONTENT_TOO_LARGE", "图片超过安全预览像素限制", 413)
            result["width"], result["height"] = opened.size
            preview = ImageOps.exif_transpose(opened).convert("RGB")
            preview.thumbnail((1024, 1024))
            buffer = io.BytesIO()
            preview.save(buffer, format="JPEG", quality=75)
            result["preview"] = {"mime_type": "image/jpeg",
                                 "data_base64": base64.b64encode(buffer.getvalue()).decode()}
    return result


def get_context(principal: Any, payload: TargetInput) -> dict:
    paths = document_paths(principal, payload.target)
    feedback = [{"feedback_id": fid, "content": content[:8000],
                 "truncated": len(content) > 8000} for fid, _, content in _feedback(payload.target)]
    entries = media_entries(principal, payload.target)
    media_by_path = {str(path): entry["media_id"] for entry, path in entries}
    target = payload.target
    project_dir = safe_path(data_root.projects_dir() / projects.resolve_project(target.project_id).slug)
    canonical = {}
    derivative_sources = []
    project_lessons = ""
    if target.type == "character":
        from character_workflow.lib.stale import character_canonical_status
        from character_workflow.lib.character_derivatives import read_character_derivative
        from character_workflow.lib.context_loader import _extract_kind_section
        directory = resolve_target(principal, target)
        safe_path(directory / "canonical.json")
        safe_path(directory / "derivative.json")
        for path in paths.values():
            safe_path(path)
        for slot, entry in character_canonical_status(target.character_id).model_dump().items():
            if entry:
                media_id = media_by_path.get(str(safe_path(Path(entry["path"]))))
                if media_id:
                    canonical[slot] = {"media_id": media_id, "spec_stale": entry["spec_stale"],
                                       "style_stale": entry["style_stale"]}
        derivative = read_character_derivative(target.character_id)
        if derivative:
            derivative_sources = [media_by_path[str(safe_path(Path(path)))]
                                  for path in derivative.source_paths
                                  if str(safe_path(Path(path))) in media_by_path]
        memory = safe_path(project_dir / "MEMORY.md")
        if memory.is_file():
            project_lessons = _extract_kind_section(read_stable(memory, 800000).decode("utf-8-sig"),
                                                    target.asset_slot, depth=3)
    elif target.type == "ui":
        from character_workflow.lib.stale import screen_canonical_status
        safe_path(resolve_target(principal, target).parent / "canonical.json")
        entry = screen_canonical_status(target.project_id, target.ui_scheme_id).screens.get(target.screen_id)
        if entry:
            media_id = media_by_path.get(str(safe_path(Path(entry.path))))
            if media_id:
                canonical["screen"] = {"media_id": media_id, "style_stale": entry.style_stale}
    elif target.type == "video":
        directory = resolve_target(principal, target)
        safe_path(directory / "selected.json")
        selected = video_jobs.read_selected(directory)
        if selected and str(safe_path(Path(selected))) in media_by_path:
            canonical["video"] = {"media_id": media_by_path[str(safe_path(Path(selected)))]}
    return {"target": payload.target.model_dump(),
            "project_name": projects.resolve_project(payload.target.project_id).name,
            "documents": [document_view(path, kind, 8000) for kind, path in paths.items()],
            "feedback": feedback[:100], "feedback_truncated": len(feedback) > 100,
            "media": [entry for entry, _ in entries][:100], "canonical": canonical,
            "derivative_source_media_ids": derivative_sources,
            "project_lessons": project_lessons[:8000], "project_lessons_truncated": len(project_lessons) > 8000,
            "design_waiver": document_view(project_dir / "design" / "waiver.md", "design_waiver", 8000)}
