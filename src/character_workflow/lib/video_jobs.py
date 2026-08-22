"""项目视频企划与镜头 IO —— projects/<slug>/videos/<production>/shots/<shot>/。"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.jobs import job_lock, list_jobs
from character_workflow.lib.schemas import (
    AssetSlot,
    ProjectVideoBrief,
    ProjectVideoJobRecord,
    ProjectVideoProduction,
    ProjectVideoReferenceCandidate,
    ProjectVideoShot,
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


def shot_output_dir(
    project_id: str | None,
    production_id: str | None,
    shot_id: str | None,
) -> Path:
    if not project_id or not production_id or not shot_id:
        raise ValueError("video job requires project_id, production_id and shot_id")
    validate_id(shot_id, "shot_id")
    return production_dir(project_id, production_id) / "shots" / shot_id


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
    atomic_write_text(
        root / "shot-map.md",
        "\n".join([
            "---",
            f"production: {production_id}",
            "status: draft",
            f"updated: {now}",
            "---",
            "",
            "# 镜头表",
            "",
            "| shot-id | 用途 | 时长 | 状态 |",
            "|---|---|---:|---|",
            "",
        ]),
    )
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


def _read_reference_file(root: Path) -> dict[str, list[str]]:
    path = _references_path(root)
    if not path.is_file():
        return {}
    return VideoReferencesFile.model_validate_json(
        path.read_text(encoding="utf-8")
    ).shots


def read_shot_references(project_id: str, production_id: str, shot_id: str) -> list[str]:
    root = production_dir(project_id, production_id)
    require_shot(root, production_id, shot_id)
    return _read_reference_file(root).get(shot_id, [])


def _existing_relative_path(path: str) -> Path | None:
    root = data_root.resolve_data_root().resolve()
    candidate = (root / path).resolve()
    if candidate.is_file() and root in candidate.parents:
        return candidate
    return None


def is_project_reference_path(project_id: str, path: str) -> bool:
    """Return whether a persisted relative reference belongs to this project.

    Historical versions do not need to remain canonical, but they must remain inside an
    assigned character asset tree or this project's UI screen tree.
    """
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


def require_shot(root: Path, production_id: str, shot_id: str) -> None:
    if not (root / "brief.md").is_file():
        raise FileNotFoundError(f"video production not found: {production_id}")
    validate_id(shot_id, "shot_id")
    planned_ids = {row["shot-id"] for row in _shot_map(root / "shot-map.md")}
    if shot_id not in planned_ids and not (root / "shots" / shot_id).is_dir():
        raise FileNotFoundError(f"video shot not found: {shot_id}")


def list_reference_candidates(project_id: str) -> list[ProjectVideoReferenceCandidate]:
    from character_workflow.lib.canonical import read_canonical
    from character_workflow.lib.character_derivatives import (
        character_display_name,
        read_character_derivative,
    )
    from character_workflow.lib.stale import (
        character_canonical_status,
        screen_canonical_status,
    )
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
                stale=bool(
                    stale_entry and (stale_entry.spec_stale or stale_entry.style_stale)
                ),
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


def set_shot_references(
    project_id: str,
    production_id: str,
    shot_id: str,
    paths: list[str],
) -> list[str]:
    root = production_dir(project_id, production_id)
    require_shot(root, production_id, shot_id)
    with job_lock(f"video-references-{project_id}-{production_id}"):
        shots = _read_reference_file(root)
        allowed = {item.path for item in list_reference_candidates(project_id)}
        allowed.update(
            path
            for path in shots.get(shot_id, [])
            if is_project_reference_path(project_id, path)
            and _existing_relative_path(path) is not None
        )
        invalid = next((path for path in paths if path not in allowed), None)
        if invalid is not None:
            raise ValueError(f"video reference must be a project canonical: {invalid}")
        if paths:
            shots[shot_id] = list(paths)
        else:
            shots.pop(shot_id, None)
        atomic_write_text(
            _references_path(root),
            json.dumps({"shots": shots}, ensure_ascii=False, indent=2),
        )
    return list(paths)


def read_selected(root: Path) -> dict[str, str]:
    path = _selected_path(root)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    shots = data.get("shots") if isinstance(data, dict) else None
    return {str(k): str(v) for k, v in shots.items()} if isinstance(shots, dict) else {}


def set_selected(project_id: str, production_id: str, shot_id: str, path: str | None) -> dict[str, str]:
    root = production_dir(project_id, production_id)
    if not (root / "brief.md").is_file():
        raise FileNotFoundError(f"video production not found: {production_id}")
    validate_id(shot_id, "shot_id")
    with job_lock(f"video-selected-{project_id}-{production_id}"):
        selected = read_selected(root)
        if path is None:
            selected.pop(shot_id, None)
        else:
            data_root_path = data_root.resolve_data_root().resolve()
            candidate = Path(path)
            absolute = (candidate if candidate.is_absolute() else data_root_path / candidate).resolve()
            expected = shot_output_dir(project_id, production_id, shot_id).resolve()
            if not absolute.is_file():
                raise FileNotFoundError(f"video target not found: {absolute}")
            if absolute.parent != expected:
                raise ValueError(f"video target must live in {expected}, got {absolute}")
            if absolute.suffix.lower() != ".mp4":
                raise ValueError("selected video version must be an .mp4 file")
            selected[shot_id] = absolute.relative_to(data_root_path).as_posix()
        atomic_write_text(
            _selected_path(root),
            json.dumps({"shots": selected}, ensure_ascii=False, indent=2),
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


def _shot_job_history(jobs, project_id: str, production_id: str):
    history = {}
    for job in jobs:
        if (
            job.namespace == "video"
            and job.project_id == project_id
            and job.production_id == production_id
            and job.shot_id
        ):
            history.setdefault(job.shot_id, []).append(job)
    return history


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


def _shot_map(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return []
    header_index = next(
        (index for index, line in enumerate(lines) if "shot-id" in line.lower()),
        None,
    )
    if header_index is None:
        return []
    headers = [cell.strip() for cell in lines[header_index].strip().strip("|").split("|")]
    rows: list[dict[str, str]] = []
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != len(headers):
            continue
        item = dict(zip(headers, cells, strict=True))
        shot_id = item.get("shot-id", "")
        if shot_id and not shot_id.startswith("<"):
            rows.append(item)
    return rows


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
        selected = read_selected(directory)
        job_history = _shot_job_history(jobs, project.id, directory.name)
        exports_dir = directory / "exports"
        exports = sorted(
            (
                path
                for path in exports_dir.iterdir()
                if path.is_file() and path.suffix.lower() == ".mp4"
            ) if exports_dir.is_dir() else (),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        generated: dict[str, list[str]] = {}
        shots_dir = directory / "shots"
        if shots_dir.is_dir():
            for shot_dir in sorted(p for p in shots_dir.iterdir() if p.is_dir()):
                versions = sorted(
                    (p for p in shot_dir.iterdir() if p.is_file() and p.suffix.lower() == ".mp4"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                generated[shot_dir.name] = [
                    path.relative_to(data_root.resolve_data_root()).as_posix()
                    for path in versions
                ]
        shots: list[ProjectVideoShot] = []
        planned_ids: set[str] = set()
        for row in _shot_map(directory / "shot-map.md"):
            shot_id = row["shot-id"]
            planned_ids.add(shot_id)
            shots.append(ProjectVideoShot(
                shot_id=shot_id,
                purpose=row.get("用途", ""),
                duration=row.get("时长", ""),
                status=row.get("状态", "planned"),
                versions=generated.get(shot_id, []),
                selected=selected.get(shot_id),
                planned_reference_images=read_shot_references(
                    project.id, directory.name, shot_id
                ),
                history=[_job_record(job) for job in job_history.get(shot_id, [])],
            ))
        for shot_id, versions in generated.items():
            if shot_id not in planned_ids:
                shots.append(ProjectVideoShot(
                    shot_id=shot_id,
                    status="generated",
                    versions=versions,
                    selected=selected.get(shot_id),
                    planned_reference_images=read_shot_references(
                        project.id, directory.name, shot_id
                    ),
                    history=[_job_record(job) for job in job_history.get(shot_id, [])],
                ))
        productions.append(ProjectVideoProduction(
            production_id=directory.name,
            title=_frontmatter_value(directory / "brief.md", "title", directory.name),
            type=_frontmatter_value(directory / "brief.md", "type", "custom"),
            status=_frontmatter_value(directory / "brief.md", "status", "draft"),
            brief=_brief(directory / "brief.md"),
            shots=shots,
            exports=[
                path.relative_to(data_root.resolve_data_root()).as_posix()
                for path in exports
            ],
        ))
    return productions
