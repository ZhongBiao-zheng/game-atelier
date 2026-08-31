"""UI scheme storage and the one-time move from the legacy unschemed layout."""
from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.jobs import job_lock
from character_workflow.lib.projects import resolve_project
from character_workflow.lib.schemas import Project, UiScheme, UiSchemeCreate, UiSchemesFile


SCHEME_ID_RE = re.compile(r"^v[1-9][0-9]*$")
UI_SECTION_RE = re.compile(
    r"^##[ \t]+ui(?:\.[^\n]*)?[ \t]*\n.*?(?=^##[ \t]+|\Z)",
    re.MULTILINE | re.DOTALL,
)
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n.*?\n---[ \t]*(?:\n|\Z)", re.DOTALL)
EMPTY_SCHEME_BODY = "## ui\n- baseline: 继承项目视觉基线"
UI_MEDIA_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def ui_root(project: Project) -> Path:
    return data_root.projects_dir() / project.slug / "ui"


def schemes_path(project: Project) -> Path:
    return ui_root(project) / "schemes.json"


def scheme_dir(project: Project, scheme_id: str) -> Path:
    validate_scheme_id(scheme_id)
    return ui_root(project) / scheme_id


def scheme_style_path(project: Project, scheme_id: str) -> Path:
    return scheme_dir(project, scheme_id) / "style.md"


def scheme_screens_dir(project: Project, scheme_id: str) -> Path:
    return scheme_dir(project, scheme_id) / "screens"


def validate_scheme_id(scheme_id: str) -> str:
    if not SCHEME_ID_RE.fullmatch(scheme_id or ""):
        raise ValueError(f"invalid ui scheme id: {scheme_id!r}")
    return scheme_id


def initialize_project(project: Project) -> UiSchemesFile:
    """Create V1 for a new project without consulting the legacy layout."""
    with job_lock(f"ui-schemes-{project.id}"):
        if schemes_path(project).is_file():
            return _read(project)
        target = scheme_dir(project, "v1")
        (target / "screens").mkdir(parents=True, exist_ok=True)
        file = UiSchemesFile(
            default_scheme_id="v1",
            schemes=[UiScheme(id="v1", name="V1", created_at=_now())],
        )
        return _write(project, file)


def migrate_legacy_project(project_ref: str) -> UiSchemesFile:
    """Explicitly upgrade one pre-scheme project into the V1-only layout."""
    project = resolve_project(project_ref)
    with job_lock(f"ui-schemes-{project.id}"):
        if schemes_path(project).is_file():
            return _read(project)

        project_root = data_root.projects_dir() / project.slug
        target = scheme_dir(project, "v1")
        target.mkdir(parents=True, exist_ok=True)
        from character_workflow.lib.stale import (
            style_fingerprint_for_files,
            style_fingerprint_for_slug,
        )

        legacy_style_fingerprint = style_fingerprint_for_slug(project.slug)
        legacy_screens = project_root / "screens"
        target_screens = target / "screens"
        if legacy_screens.exists() and not target_screens.exists():
            os.replace(legacy_screens, target_screens)
        else:
            target_screens.mkdir(parents=True, exist_ok=True)

        _migrate_legacy_style(project_root, target)

        migrated_style_fingerprint = style_fingerprint_for_files(
            project_root / "style.md",
            target / "style.md",
        )
        _rewrite_moved_canonical(
            target_screens,
            project.slug,
            legacy_style_fingerprint,
            migrated_style_fingerprint,
        )
        _rewrite_ui_jobs(project)

        file = UiSchemesFile(
            default_scheme_id="v1",
            schemes=[UiScheme(id="v1", name="V1", created_at=_now())],
        )
        return _write(project, file)


def migrate_legacy_projects() -> list[str]:
    """Upgrade every existing project that predates ``ui/schemes.json``."""
    from character_workflow.lib.projects import read_projects

    migrated: list[str] = []
    for project in read_projects().projects:
        if schemes_path(project).is_file():
            continue
        migrate_legacy_project(project.id)
        migrated.append(project.id)
    return migrated


def read_schemes(project_ref: str) -> UiSchemesFile:
    """Read the current contract without mutating or accepting the legacy layout."""
    return _read(resolve_project(project_ref))


def read_visible_schemes(project_ref: str) -> UiSchemesFile:
    """Return only schemes that contain authored UI material."""
    project = resolve_project(project_ref)
    file = _read(project)
    return file.model_copy(update={
        "schemes": [scheme for scheme in file.schemes if _scheme_has_content(project, scheme.id)],
    })


def read_existing_schemes(project_ref: str) -> UiSchemesFile | None:
    """Pure probe used by diagnostics that must never upgrade user data."""
    project = resolve_project(project_ref)
    return _read(project) if schemes_path(project).is_file() else None


def resolve_scheme(project_ref: str, scheme_id: str | None = None) -> tuple[Project, UiScheme]:
    project = resolve_project(project_ref)
    file = _read(project)
    target_id = scheme_id or file.default_scheme_id
    validate_scheme_id(target_id)
    scheme = next((item for item in file.schemes if item.id == target_id), None)
    if scheme is None:
        raise KeyError(f"ui scheme not found: {target_id!r}")
    return project, scheme


def create_scheme(project_ref: str, payload: UiSchemeCreate, *,
                  creation_request_id: str | None = None) -> UiSchemesFile:
    project = resolve_project(project_ref)
    with job_lock(f"ui-schemes-{project.id}"):
        file = _read(project)
        if creation_request_id and any(
            item.creation_request_id == creation_request_id for item in file.schemes
        ):
            return file
        next_number = max(int(item.id[1:]) for item in file.schemes) + 1
        target_id = f"v{next_number}"
        target = scheme_dir(project, target_id)
        target_screens = target / "screens"
        target_screens.mkdir(parents=True, exist_ok=False)
        try:
            if payload.source_scheme_id:
                source = _scheme_from_file(file, payload.source_scheme_id)
                source_root = scheme_dir(project, source.id)
                if payload.copy_style and (source_root / "style.md").is_file():
                    shutil.copy2(source_root / "style.md", target / "style.md")
                if payload.copy_screen_map and (source_root / "screens" / "screen-map.md").is_file():
                    shutil.copy2(
                        source_root / "screens" / "screen-map.md",
                        target_screens / "screen-map.md",
                    )
                for screen_id in payload.screen_ids:
                    from character_workflow.lib.ui_jobs import validate_screen_id

                    validate_screen_id(screen_id)
                    source_screen = source_root / "screens" / screen_id
                    source_brief = source_root / "screens" / f"{screen_id}.md"
                    if not source_screen.is_dir() and not source_brief.is_file():
                        raise ValueError(f"source screen not found: {screen_id}")
                    if source_screen.is_dir():
                        shutil.copytree(source_screen, target_screens / screen_id)
                    if source_brief.is_file():
                        shutil.copy2(source_brief, target_screens / source_brief.name)
            file.schemes.append(UiScheme(id=target_id, name=payload.name, created_at=_now(),
                                        creation_request_id=creation_request_id))
            return _write(project, file)
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise


def set_default(project_ref: str, scheme_id: str) -> UiSchemesFile:
    project = resolve_project(project_ref)
    with job_lock(f"ui-schemes-{project.id}"):
        file = _read(project)
        _scheme_from_file(file, scheme_id)
        file.default_scheme_id = scheme_id
        return _write(project, file)


def _read(project: Project) -> UiSchemesFile:
    return UiSchemesFile.model_validate_json(schemes_path(project).read_text(encoding="utf-8"))


def _write(project: Project, file: UiSchemesFile) -> UiSchemesFile:
    atomic_write_text(schemes_path(project), file.model_dump_json(indent=2))
    return file


def _scheme_from_file(file: UiSchemesFile, scheme_id: str) -> UiScheme:
    validate_scheme_id(scheme_id)
    scheme = next((item for item in file.schemes if item.id == scheme_id), None)
    if scheme is None:
        raise KeyError(f"ui scheme not found: {scheme_id!r}")
    return scheme


def _scheme_has_content(project: Project, scheme_id: str) -> bool:
    root = scheme_dir(project, scheme_id)
    screens = root / "screens"
    if screens.is_dir():
        for path in screens.rglob("*"):
            if not path.is_file() or path.stat().st_size == 0:
                continue
            if path.suffix.lower() in UI_MEDIA_EXTENSIONS:
                return True
            if path.suffix.lower() == ".md" and path.read_text(encoding="utf-8-sig").strip():
                return True
    style = root / "style.md"
    if not style.is_file():
        return False
    text = style.read_text(encoding="utf-8-sig")
    body = FRONTMATTER_RE.sub("", text).strip()
    return bool(body) and _normalize_markdown(body) != _normalize_markdown(EMPTY_SCHEME_BODY)


def _normalize_markdown(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def _rewrite_moved_canonical(
    screens: Path,
    slug: str,
    legacy_style_fingerprint: str,
    migrated_style_fingerprint: str,
) -> None:
    path = screens / "canonical.json"
    if not path.is_file():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    for entry in data.get("screens", {}).values():
        if isinstance(entry, dict) and isinstance(entry.get("path"), str):
            entry["path"] = _move_path(entry["path"], slug)
            if (
                legacy_style_fingerprint
                and entry.get("style_fingerprint") == legacy_style_fingerprint
            ):
                entry["style_fingerprint"] = migrated_style_fingerprint
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def _migrate_legacy_style(project_root: Path, target: Path) -> None:
    project_style = project_root / "style.md"
    target_style = target / "style.md"
    if not project_style.is_file() or target_style.exists():
        return
    text = project_style.read_text(encoding="utf-8-sig")
    sections = [match.group(0).strip() for match in UI_SECTION_RE.finditer(text)]
    frontmatter = FRONTMATTER_RE.match(text)
    scheme_parts = [frontmatter.group(0).strip()] if frontmatter else []
    scheme_parts.extend(sections or [EMPTY_SCHEME_BODY])
    atomic_write_text(target_style, "\n\n".join(scheme_parts).rstrip() + "\n")

    if sections:
        baseline = UI_SECTION_RE.sub("", text)
        baseline = re.sub(r"\n{3,}", "\n\n", baseline).rstrip() + "\n"
        atomic_write_text(project_style, baseline)


def _rewrite_ui_jobs(project: Project) -> None:
    from character_workflow.lib.jobs import migrate_ui_job_to_scheme

    jobs_dir = data_root.runtime_dir() / "jobs"
    if not jobs_dir.is_dir():
        return
    for path in jobs_dir.glob("*.json"):
        try:
            migrate_ui_job_to_scheme(
                path.stem,
                project.id,
                "v1",
                f"projects/{project.slug}/screens/",
                f"projects/{project.slug}/ui/v1/screens/",
            )
        except (OSError, json.JSONDecodeError, ValueError):
            continue


def _move_path(raw: str, slug: str) -> str:
    marker = f"projects/{slug}/screens/"
    return raw.replace(marker, f"projects/{slug}/ui/v1/screens/")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
