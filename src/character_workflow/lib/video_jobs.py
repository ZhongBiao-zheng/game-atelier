"""项目视频企划与镜头 IO —— projects/<slug>/videos/<production>/shots/<shot>/。"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.jobs import job_lock, list_jobs
from character_workflow.lib.schemas import ProjectVideoBrief, ProjectVideoProduction, ProjectVideoShot
from character_workflow.lib.ui_jobs import resolve_project


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


def _latest_shot_jobs(jobs, project_id: str, production_id: str):
    latest = {}
    for job in jobs:
        if (
            job.namespace == "video"
            and job.project_id == project_id
            and job.production_id == production_id
            and job.shot_id
        ):
            latest.setdefault(job.shot_id, job)
    return latest


def _shot_metadata(job) -> dict:
    if job is None:
        return {}
    return {
        "prompt": job.prompt,
        "model": job.model,
        "reference_images": job.params.reference_images or [],
        "reference_videos": job.params.reference_videos or [],
        "reference_audios": job.params.reference_audios or [],
    }


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
        latest_jobs = _latest_shot_jobs(jobs, project.id, directory.name)
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
                **_shot_metadata(latest_jobs.get(shot_id)),
            ))
        for shot_id, versions in generated.items():
            if shot_id not in planned_ids:
                shots.append(ProjectVideoShot(
                    shot_id=shot_id,
                    status="generated",
                    versions=versions,
                    selected=selected.get(shot_id),
                    **_shot_metadata(latest_jobs.get(shot_id)),
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
