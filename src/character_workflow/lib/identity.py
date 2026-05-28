"""Character identity normalization for Web-created temporary ids."""
from __future__ import annotations

import json
import re
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib import slug as slug_util
from character_workflow.lib.active_character import read_active
from character_workflow.lib.projects import read_projects
from character_workflow.lib.schemas import PendingCharacterIdentity


_AUTO_ID_RE = re.compile(r"^char-\d+$")
_ASSET_DIRS = ("source", "portrait", "promo", "turnaround")
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def _characters_dir() -> Path:
    return data_root.characters_dir()


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _read_title(spec_path: Path) -> str:
    try:
        for line in spec_path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^#\s+(.+?)\s*$", line.strip())
            if match:
                return match.group(1).strip()
    except OSError:
        return ""
    return ""


def _spec_status(spec: str | None) -> str:
    if spec is None:
        return "missing"
    stripped = spec.strip()
    if not stripped:
        return "placeholder"
    placeholder_markers = (
        "尚无档案",
        "请在终端 /character-workflow 对话补全",
    )
    if any(marker in stripped for marker in placeholder_markers):
        return "placeholder"
    meaningful_lines = [
        line.strip()
        for line in stripped.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    return "ready" if meaningful_lines else "placeholder"


def _asset_counts(char_dir: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name in _ASSET_DIRS:
        folder = char_dir / name
        if not folder.exists():
            counts[name] = 0
            continue
        counts[name] = sum(
            1
            for path in folder.iterdir()
            if path.is_file() and path.suffix.lower() in _IMAGE_EXTS
        )
    return counts


def _job_count(character_id: str) -> int:
    jobs_dir = _runtime_dir() / "jobs"
    if not jobs_dir.exists():
        return 0
    count = 0
    for path in jobs_dir.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("character_id") == character_id:
            count += 1
    return count


def list_pending_identity_normalizations() -> list[PendingCharacterIdentity]:
    chars = _characters_dir()
    if not chars.exists():
        return []

    projects = read_projects()
    project_names = {project.id: project.name for project in projects.projects}
    active = read_active()
    existing_ids = {path.name for path in chars.iterdir() if path.is_dir()}
    pending: list[PendingCharacterIdentity] = []

    for char_dir in sorted(chars.iterdir()):
        if not char_dir.is_dir() or not _AUTO_ID_RE.match(char_dir.name):
            continue
        spec_path = char_dir / "spec.md"
        if not spec_path.exists():
            continue
        try:
            spec = spec_path.read_text(encoding="utf-8")
        except OSError:
            spec = None
        display_name = _read_title(spec_path)
        if not display_name:
            continue

        recommended_id = slug_util.dedupe(
            slug_util.generate(display_name),
            existing_ids - {char_dir.name},
        )
        counts = _asset_counts(char_dir)
        project_id = projects.assignments.get(char_dir.name)
        pending.append(
            PendingCharacterIdentity(
                old_id=char_dir.name,
                display_name=display_name,
                recommended_id=recommended_id,
                spec_status=_spec_status(spec),
                project_id=project_id,
                project_name=project_names.get(project_id) if project_id else None,
                asset_counts=counts,
                job_count=_job_count(char_dir.name),
                has_assets=any(counts.values()),
                is_active=active.active_id == char_dir.name,
            )
        )
    return pending


def _replace_path_id(value: str, old_id: str, new_id: str) -> str:
    return (
        value.replace(f"/characters/{old_id}/", f"/characters/{new_id}/")
        .replace(f"characters/{old_id}/", f"characters/{new_id}/")
        .replace(f"\\characters\\{old_id}\\", f"\\characters\\{new_id}\\")
    )


def _rewrite_job_file(path: Path, old_id: str, new_id: str) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return

    changed = False
    if data.get("character_id") == old_id and data.get("namespace", "character") == "character":
        data["character_id"] = new_id
        changed = True
    if isinstance(data.get("output_paths"), list):
        new_paths = [
            _replace_path_id(item, old_id, new_id) if isinstance(item, str) else item
            for item in data["output_paths"]
        ]
        if new_paths != data["output_paths"]:
            data["output_paths"] = new_paths
            changed = True
    if isinstance(data.get("source_image"), str):
        new_source = _replace_path_id(data["source_image"], old_id, new_id)
        if new_source != data["source_image"]:
            data["source_image"] = new_source
            changed = True

    params = data.get("params")
    if isinstance(params, dict):
        for key in ("reference_images", "lovart_attachments"):
            if isinstance(params.get(key), list):
                new_items = [
                    _replace_path_id(item, old_id, new_id)
                    if isinstance(item, str)
                    else item
                    for item in params[key]
                ]
                if new_items != params[key]:
                    params[key] = new_items
                    changed = True

    if changed:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)


def rename_character_id(old_id: str, new_id: str) -> dict[str, object]:
    if not old_id or not new_id:
        raise ValueError("old_id and new_id are required")
    if any(separator in old_id or separator in new_id for separator in ("/", "\\")):
        raise ValueError("character ids must not contain path separators")

    chars = _characters_dir()
    old_dir = chars / old_id
    new_dir = chars / new_id
    if not old_dir.is_dir():
        raise FileNotFoundError(old_id)
    if new_dir.exists():
        raise FileExistsError(new_id)

    old_dir.rename(new_dir)

    active_path = _runtime_dir() / "active-character.json"
    if active_path.exists():
        try:
            active_data = json.loads(active_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            active_data = None
        if isinstance(active_data, dict) and active_data.get("active_id") == old_id:
            active_data["active_id"] = new_id
            tmp = active_path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(active_data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(active_path)

    projects_path = _runtime_dir() / "projects.json"
    if projects_path.exists():
        try:
            projects_data = json.loads(projects_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            projects_data = None
        if isinstance(projects_data, dict) and isinstance(
            projects_data.get("assignments"), dict
        ):
            assignments = projects_data["assignments"]
            if old_id in assignments:
                assignments[new_id] = assignments.pop(old_id)
                tmp = projects_path.with_suffix(".json.tmp")
                tmp.write_text(
                    json.dumps(projects_data, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                tmp.replace(projects_path)

    jobs_dir = _runtime_dir() / "jobs"
    if jobs_dir.exists():
        for job_path in jobs_dir.glob("*.json"):
            _rewrite_job_file(job_path, old_id, new_id)

    return {"old_id": old_id, "new_id": new_id, "ok": True}
