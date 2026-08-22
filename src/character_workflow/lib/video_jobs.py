"""项目视频企划 IO —— 一次 job 产出 projects/<slug>/videos/<production>/versions/ 下的一支整片。"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.asset_versions import first_image_version
from character_workflow.lib.jobs import job_lock, list_jobs
from character_workflow.lib.schemas import (
    AssetSlot,
    ProjectVideoBrief,
    ProjectVideoJobRecord,
    ProjectVideoProduction,
    ProjectVideoReferenceCandidate,
    VideoReferencesFile,
)
from character_workflow.lib.projects import read_projects, resolve_project


VIDEO_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PRODUCTION_TYPES = {"promo", "character", "gameplay", "cutscene", "social", "custom"}


def validate_id(value: str, label: str) -> str:
    if not VIDEO_ID_RE.match(value or ""):
        raise ValueError(f"invalid {label}: {value!r}（只允许小写字母/数字/连字符）")
    return value


def production_dir(project_id: str, production_id: str) -> Path:
    project = resolve_project(project_id)
    validate_id(production_id, "production_id")
    return data_root.projects_dir() / project.slug / "videos" / production_id


def production_output_dir(project_id: str | None, production_id: str | None) -> Path:
    if not project_id or not production_id:
        raise ValueError("video job requires project_id and production_id")
    return production_dir(project_id, production_id) / "versions"


def require_production(root: Path, production_id: str) -> None:
    if not (root / "brief.md").is_file() or not (root / "prompt.md").is_file():
        raise FileNotFoundError(f"video production not found: {production_id}")


def create_production(
    project_ref: str,
    production_id: str,
    title: str,
    production_type: str = "custom",
) -> Path:
    project = resolve_project(project_ref)
    validate_id(production_id, "production_id")
    production_type = production_type.strip() or "custom"
    if production_type not in PRODUCTION_TYPES:
        raise ValueError(f"invalid production type: {production_type!r}")
    title = title.strip()
    if not title:
        raise ValueError("video production title cannot be empty")
    root = production_dir(project.id, production_id)
    if root.exists():
        raise ValueError(f"video production already exists: {production_id}")
    root.mkdir(parents=True)
    now = datetime.now(timezone.utc).date().isoformat()
    atomic_write_text(
        root / "brief.md",
        "\n".join([
            "---",
            f"id: {production_id}",
            f"title: {json.dumps(title, ensure_ascii=False)}",
            f"type: {production_type}",
            "status: draft",
            f"created: {now}",
            "---",
            "",
            "## 目标",
            "",
            title,
            "",
            "## 平台",
            "",
            "## 画幅",
            "",
            "## 目标时长",
            "",
            "## 声音策略",
            "",
        ]),
    )
    atomic_write_text(root / "prompt.md", "")
    return root


def _frontmatter_value(path: Path, key: str, fallback: str = "") -> str:
    if not path.is_file():
        return fallback
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return fallback
    match = re.search(rf"^{re.escape(key)}:\s*(.+?)\s*$", text, re.MULTILINE)
    if not match:
        return fallback
    value = match.group(1).strip()
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return value
    return decoded if isinstance(decoded, str) else value


def _selected_path(root: Path) -> Path:
    return root / "selected.json"


def _references_path(root: Path) -> Path:
    return root / "references.json"


def read_references(project_id: str, production_id: str) -> list[str]:
    root = production_dir(project_id, production_id)
    require_production(root, production_id)
    path = _references_path(root)
    if not path.is_file():
        return []
    return VideoReferencesFile.model_validate_json(path.read_text(encoding="utf-8")).paths


def _existing_relative_path(path: str) -> Path | None:
    root = data_root.resolve_data_root().resolve()
    candidate = (root / path).resolve()
    if candidate.is_file() and root in candidate.parents:
        return candidate
    return None


def is_project_reference_path(project_id: str, path: str) -> bool:
    """项目视频只接受同项目角色资产或 UI 页面资产。"""
    relative = Path(path)
    if relative.is_absolute() or relative.as_posix() != path or ".." in relative.parts:
        return False
    project = resolve_project(project_id)
    parts = relative.parts
    if relative.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        return False
    if len(parts) >= 4 and parts[0] == "characters":
        return (
            parts[2] in {slot.value for slot in AssetSlot}
            and read_projects().assignments.get(parts[1]) == project.id
        )
    return (
        len(parts) >= 6
        and parts[0] == "projects"
        and parts[1] == project.slug
        and parts[2] == "ui"
        and parts[4] == "screens"
    )


def list_reference_candidates(project_id: str) -> list[ProjectVideoReferenceCandidate]:
    from character_workflow.lib.canonical import read_canonical
    from character_workflow.lib.character_derivatives import (
        character_display_name,
        read_character_derivative,
    )
    from character_workflow.lib.stale import character_canonical_status, screen_canonical_status
    from character_workflow.lib.ui_schemes import read_schemes

    project = resolve_project(project_id)
    assignments = read_projects().assignments
    candidates: list[ProjectVideoReferenceCandidate] = []
    slot_labels = {
        AssetSlot.PORTRAIT: "立绘",
        AssetSlot.PROMO: "美宣",
        AssetSlot.TURNAROUND: "三视图",
    }
    character_ids = sorted(
        character_id for character_id, owner_id in assignments.items() if owner_id == project.id
    )
    for character_id in character_ids:
        derivative = read_character_derivative(character_id)
        status = character_canonical_status(character_id)
        canonical = read_canonical(character_id)
        has_portrait = False
        for slot in AssetSlot:
            entry = getattr(canonical, slot.value)
            if (
                entry is None
                or not is_project_reference_path(project.id, entry.path)
                or _existing_relative_path(entry.path) is None
            ):
                continue
            stale_entry = getattr(status, slot.value)
            candidates.append(ProjectVideoReferenceCandidate(
                kind="character",
                asset_id=character_id,
                label=f"{character_display_name(character_id)} · {slot_labels[slot]}",
                detail="角色衍生定稿" if derivative else "角色定稿",
                path=entry.path,
                stale=bool(stale_entry and (stale_entry.spec_stale or stale_entry.style_stale)),
            ))
            has_portrait = has_portrait or slot is AssetSlot.PORTRAIT
        if not has_portrait:
            initial = _initial_portrait_path(character_id)
            if initial is not None:
                candidates.append(ProjectVideoReferenceCandidate(
                    kind="character",
                    asset_id=character_id,
                    label=f"{character_display_name(character_id)} · 立绘",
                    detail="角色初始图（尚未定稿）",
                    path=initial,
                    stale=False,
                ))

    for scheme in read_schemes(project.id).schemes:
        status = screen_canonical_status(project.id, scheme.id)
        for screen_id, entry in sorted(status.screens.items()):
            if (
                not is_project_reference_path(project.id, entry.path)
                or _existing_relative_path(entry.path) is None
            ):
                continue
            candidates.append(ProjectVideoReferenceCandidate(
                kind="ui_screen",
                asset_id=screen_id,
                scheme_id=scheme.id,
                label=f"{scheme.name} · {screen_id}",
                detail="UI 页面定稿",
                path=entry.path,
                stale=entry.style_stale,
            ))
    return candidates


def _initial_portrait_path(character_id: str) -> str | None:
    root = data_root.resolve_data_root().resolve()
    directory = data_root.characters_dir() / character_id / AssetSlot.PORTRAIT.value
    return first_image_version(directory, root)


def set_references(project_id: str, production_id: str, paths: list[str]) -> list[str]:
    root = production_dir(project_id, production_id)
    require_production(root, production_id)
    with job_lock(f"video-references-{project_id}-{production_id}"):
        current = read_references(project_id, production_id)
        allowed = {item.path for item in list_reference_candidates(project_id)}
        allowed.update(
            path for path in current
            if is_project_reference_path(project_id, path)
            and _existing_relative_path(path) is not None
        )
        invalid = next((path for path in paths if path not in allowed), None)
        if invalid is not None:
            raise ValueError(f"video reference must be a project asset candidate: {invalid}")
        atomic_write_text(
            _references_path(root),
            VideoReferencesFile(paths=list(paths)).model_dump_json(indent=2),
        )
    return list(paths)


def read_selected(root: Path) -> str | None:
    path = _selected_path(root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = data.get("path") if isinstance(data, dict) else None
    if not isinstance(value, str) or not value:
        return None
    data_root_path = data_root.resolve_data_root().resolve()
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    absolute = (data_root_path / relative).resolve()
    if (
        not absolute.is_file()
        or absolute.parent != (root / "versions").resolve()
        or absolute.suffix.lower() != ".mp4"
    ):
        return None
    return absolute.relative_to(data_root_path).as_posix()


def set_selected(project_id: str, production_id: str, path: str | None) -> str | None:
    root = production_dir(project_id, production_id)
    require_production(root, production_id)
    with job_lock(f"video-selected-{project_id}-{production_id}"):
        selected: str | None = None
        if path is not None:
            data_root_path = data_root.resolve_data_root().resolve()
            candidate = Path(path)
            absolute = (candidate if candidate.is_absolute() else data_root_path / candidate).resolve()
            expected = production_output_dir(project_id, production_id).resolve()
            if not absolute.is_file():
                raise FileNotFoundError(f"video target not found: {absolute}")
            if absolute.parent != expected:
                raise ValueError(f"video target must live in {expected}, got {absolute}")
            if absolute.suffix.lower() != ".mp4":
                raise ValueError("selected video version must be an .mp4 file")
            selected = absolute.relative_to(data_root_path).as_posix()
        atomic_write_text(
            _selected_path(root),
            json.dumps({"path": selected}, ensure_ascii=False, indent=2),
        )
    return selected


def _section_value(text: str, headings: tuple[str, ...]) -> str:
    joined = "|".join(re.escape(heading) for heading in headings)
    match = re.search(
        rf"^##\s+(?:{joined})\s*$([\s\S]*?)(?=^##\s+|\Z)",
        text,
        re.MULTILINE | re.IGNORECASE,
    )
    if not match:
        return ""
    return next((line.strip() for line in match.group(1).splitlines() if line.strip()), "")


def _brief(path: Path) -> ProjectVideoBrief:
    if not path.is_file():
        return ProjectVideoBrief()
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return ProjectVideoBrief()
    return ProjectVideoBrief(
        goal=_section_value(text, ("目标", "Goal")),
        platform=_section_value(text, ("平台", "Platform")),
        ratio=_section_value(text, ("画幅", "比例", "Ratio")),
        duration=_section_value(text, ("目标时长", "时长", "Duration")),
        sound=_section_value(text, ("声音策略", "声音", "Sound")),
    )


def _job_record(job) -> ProjectVideoJobRecord:
    return ProjectVideoJobRecord(
        job_id=job.job_id,
        submitted_at=job.submitted_at,
        completed_at=job.completed_at,
        status=job.status,
        prompt=job.prompt,
        model=job.model,
        params=job.params,
    )


def list_productions(project_id: str) -> list[ProjectVideoProduction]:
    project = resolve_project(project_id)
    root = data_root.projects_dir() / project.slug / "videos"
    if not root.is_dir():
        return []
    jobs = sorted(list_jobs(), key=lambda item: item.submitted_at, reverse=True)
    productions: list[ProjectVideoProduction] = []
    for directory in sorted(
        (p for p in root.iterdir() if p.is_dir() and (p / "brief.md").is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ):
        if not (directory / "prompt.md").is_file():
            continue
        versions_dir = directory / "versions"
        versions = sorted(
            (
                path for path in versions_dir.iterdir()
                if path.is_file() and path.suffix.lower() == ".mp4"
            ) if versions_dir.is_dir() else (),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        history = [
            _job_record(job) for job in jobs
            if job.namespace == "video"
            and job.project_id == project.id
            and job.production_id == directory.name
        ]
        productions.append(ProjectVideoProduction(
            production_id=directory.name,
            title=_frontmatter_value(directory / "brief.md", "title", directory.name),
            type=_frontmatter_value(directory / "brief.md", "type", "custom"),
            status=_frontmatter_value(directory / "brief.md", "status", "draft"),
            brief=_brief(directory / "brief.md"),
            prompt=(directory / "prompt.md").read_text(encoding="utf-8-sig").strip(),
            versions=[
                path.relative_to(data_root.resolve_data_root()).as_posix()
                for path in versions
            ],
            selected=read_selected(directory),
            planned_reference_images=read_references(project.id, directory.name),
            history=history,
        ))
    return productions


def get_production(project_id: str, production_id: str) -> ProjectVideoProduction:
    validate_id(production_id, "production_id")
    production = next(
        (item for item in list_productions(project_id) if item.production_id == production_id),
        None,
    )
    if production is None:
        raise FileNotFoundError(f"video production not found: {production_id}")
    return production
