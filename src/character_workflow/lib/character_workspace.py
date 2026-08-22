"""Character index, workspace aggregates, and manual cross-asset associations."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root, stale
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.asset_versions import first_image_version
from character_workflow.lib.character_derivatives import (
    character_display_name,
    read_character_derivative,
)
from character_workflow.lib.jobs import job_lock, list_jobs
from character_workflow.lib.project_gallery import project_gallery_items
from character_workflow.lib.projects import read_projects, resolve_project
from character_workflow.lib.schemas import (
    AssetSlot,
    CharacterAssociationItem,
    CharacterAssociationPatch,
    CharacterAssociationsFile,
    CharacterAssociationTarget,
    CharacterAssociationUiTarget,
    CharacterAssociationVideoTarget,
    CharacterAssetGroup,
    CharacterEntry,
    CharacterIndexItem,
    CharacterIndexResponse,
    CharacterRelatedObject,
    CharacterWorkspaceResponse,
    GalleryMedia,
)
from character_workflow.lib.ui_schemes import read_schemes, resolve_scheme
from character_workflow.lib.video_jobs import list_productions
from character_workflow.lib.workspace_summary import project_workspace_summary


_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def _association_path(project_id: str) -> Path:
    project = resolve_project(project_id)
    return data_root.projects_dir() / project.slug / "character-associations.json"


def read_associations(project_id: str) -> CharacterAssociationsFile:
    path = _association_path(project_id)
    if not path.is_file():
        return CharacterAssociationsFile()
    return CharacterAssociationsFile.model_validate_json(path.read_text(encoding="utf-8"))


def set_manual_association(
    project_id: str,
    patch: CharacterAssociationPatch,
) -> CharacterAssociationsFile:
    project = resolve_project(project_id)
    _validate_character_owner(project.id, patch.character_id)
    _validate_target(project.id, patch.target)
    key = _association_key(patch.character_id, patch.target)
    with job_lock(f"character-associations-{project.id}"):
        file = read_associations(project.id)
        items = [
            item for item in file.items
            if _association_key(item.character_id, item.target) != key
        ]
        if patch.associated:
            items.append(CharacterAssociationItem(
                character_id=patch.character_id,
                target=patch.target,
            ))
        updated = CharacterAssociationsFile(items=items)
        atomic_write_text(_association_path(project.id), updated.model_dump_json(indent=2))
        return updated


def character_index(project_id: str) -> CharacterIndexResponse:
    project = resolve_project(project_id)
    assignments = read_projects().assignments

    items: list[CharacterIndexItem] = []
    for character_id, owner_id in assignments.items():
        if owner_id != project.id:
            continue
        entry = _character_entry(character_id)
        activity = _character_activity(character_id, project.created_at)
        items.append(CharacterIndexItem(
            character=entry,
            cover_path=_character_cover_path(character_id),
            activity_at=datetime.fromtimestamp(activity, timezone.utc).isoformat(),
        ))
    items.sort(key=lambda item: item.activity_at, reverse=True)
    return CharacterIndexResponse(items=items)


def _character_cover_path(character_id: str) -> str | None:
    root = data_root.resolve_data_root().resolve()
    portrait = data_root.characters_dir() / character_id / AssetSlot.PORTRAIT.value
    canonical = stale.character_canonical_status(character_id).portrait
    if canonical:
        canonical_path = Path(canonical.path)
        absolute = canonical_path if canonical_path.is_absolute() else root / canonical_path
        if absolute.is_file() and absolute.suffix.lower() in _IMAGE_EXTENSIONS:
            try:
                return absolute.resolve().relative_to(root).as_posix()
            except ValueError:
                pass
    return first_image_version(portrait, root)


def character_workspace(project_id: str, character_id: str) -> CharacterWorkspaceResponse:
    project = resolve_project(project_id)
    _validate_character_owner(project.id, character_id)
    project_media = project_gallery_items(project.id)
    own_media = [
        item for item in project_media
        if item.target.kind == "art" and item.target.character_id == character_id
    ]
    canonical = stale.character_canonical_status(character_id)
    assets: list[CharacterAssetGroup] = []
    for slot in AssetSlot:
        slot_media = [
            item for item in own_media
            if item.target.kind == "art" and item.target.asset_slot == slot
        ]
        canonical_entry = getattr(canonical, slot.value)
        assets.append(CharacterAssetGroup(
            slot=slot,
            count=len(slot_media),
            canonical=canonical_entry,
            media=_compact_media(
                slot_media,
                canonical_entry.path if canonical_entry else None,
            ),
        ))

    automatic = _automatic_targets(project.id, character_id)
    manual = {
        _target_key(item.target): item.target
        for item in read_associations(project.id).items
        if item.character_id == character_id
    }
    related = _related_objects(
        project.id,
        project_media,
        automatic,
        manual,
    )
    recent = _featured_media(assets, related)
    return CharacterWorkspaceResponse(
        character=_character_entry(character_id),
        assets=assets,
        related=related,
        recent_media=recent,
    )


def _character_entry(character_id: str) -> CharacterEntry:
    root = data_root.resolve_data_root()
    character_dir = data_root.characters_dir() / character_id
    portrait = character_dir / AssetSlot.PORTRAIT.value
    thumbnail = None
    if portrait.is_dir():
        images = sorted(
            (path for path in portrait.iterdir() if path.suffix.lower() in _IMAGE_EXTENSIONS),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if images:
            thumbnail = images[0].relative_to(root).as_posix()
    return CharacterEntry(
        id=character_id,
        name=character_display_name(character_id),
        status="idle",
        latest_job_id=None,
        thumbnail=thumbnail,
        derivative=read_character_derivative(character_id),
    )


def _character_activity(character_id: str, created_at: str) -> float:
    try:
        fallback = datetime.fromisoformat(created_at).timestamp()
    except ValueError:
        fallback = 0.0
    root = data_root.characters_dir() / character_id
    latest = fallback
    if not root.is_dir():
        return latest
    for path in root.rglob("*"):
        try:
            latest = max(latest, path.stat().st_mtime)
        except OSError:
            continue
    return latest


def _validate_character_owner(project_id: str, character_id: str) -> None:
    assignments = read_projects().assignments
    spec = data_root.characters_dir() / character_id / "spec.md"
    if not spec.is_file():
        raise KeyError(f"character not found: {character_id}")
    if assignments.get(character_id) != project_id:
        raise ValueError("character and target must belong to the same project")


def _validate_target(project_id: str, target: CharacterAssociationTarget) -> None:
    if isinstance(target, CharacterAssociationUiTarget):
        resolve_scheme(project_id, target.scheme_id)
        summary = project_workspace_summary(project_id, target.scheme_id)
        if target.screen_id not in {item.screen_id for item in summary.ui.screen_items}:
            screen_dir = (
                data_root.projects_dir()
                / resolve_project(project_id).slug
                / "ui"
                / target.scheme_id
                / "screens"
                / target.screen_id
            )
            if not screen_dir.is_dir():
                raise KeyError(f"ui screen not found: {target.screen_id}")
        return
    if target.production_id not in {
        production.production_id for production in list_productions(project_id)
    }:
        raise KeyError(f"video production not found: {target.production_id}")


def _association_key(character_id: str, target: CharacterAssociationTarget) -> tuple[str, str]:
    return character_id, _target_key(target)


def _target_key(target: CharacterAssociationTarget) -> str:
    if isinstance(target, CharacterAssociationUiTarget):
        return f"ui:{target.scheme_id}:{target.screen_id}"
    return f"video:{target.production_id}"


def _automatic_targets(
    project_id: str,
    character_id: str,
) -> dict[str, CharacterAssociationTarget]:
    result: dict[str, CharacterAssociationTarget] = {}
    for job in list_jobs():
        if job.project_id != project_id or not _job_references_character(job, character_id):
            continue
        if job.namespace == "ui" and job.ui_scheme_id and job.screen_id:
            target = CharacterAssociationUiTarget(
                scheme_id=job.ui_scheme_id,
                screen_id=job.screen_id,
            )
            result[_target_key(target)] = target
        if job.namespace == "video" and job.production_id:
            target = CharacterAssociationVideoTarget(production_id=job.production_id)
            result[_target_key(target)] = target
    for production in list_productions(project_id):
        if _paths_reference_character(production.planned_reference_images, character_id):
            target = CharacterAssociationVideoTarget(production_id=production.production_id)
            result[_target_key(target)] = target
    return result


def _job_references_character(job, character_id: str) -> bool:
    paths: list[str] = []
    for field in ("reference_images", "mj_sref", "mj_cref", "mj_oref"):
        values = getattr(job.params, field, None)
        if values:
            paths.extend(values)
    if job.source_image:
        paths.append(job.source_image)
    return _paths_reference_character(paths, character_id)


def _paths_reference_character(paths: list[str], character_id: str) -> bool:
    root = data_root.resolve_data_root().resolve()
    for raw in paths:
        if raw.startswith(("http://", "https://", "data:")):
            continue
        path = Path(raw)
        absolute = (path if path.is_absolute() else root / path).resolve()
        try:
            relative = absolute.relative_to(root)
        except ValueError:
            continue
        if len(relative.parts) >= 2 and relative.parts[:2] == ("characters", character_id):
            return True
    return False


def _related_objects(
    project_id: str,
    media: list[GalleryMedia],
    automatic: dict[str, CharacterAssociationTarget],
    manual: dict[str, CharacterAssociationTarget],
) -> list[CharacterRelatedObject]:
    productions = {
        production.production_id: production
        for production in list_productions(project_id)
    }
    screen_names: dict[tuple[str, str], str] = {}
    for scheme in read_schemes(project_id).schemes:
        summary = project_workspace_summary(project_id, scheme.id)
        screen_names.update({
            (scheme.id, item.screen_id): item.name or item.screen_id
            for item in summary.ui.screen_items
        })
    keys = list(dict.fromkeys([*automatic, *manual]))
    related: list[CharacterRelatedObject] = []
    for key in keys:
        target = automatic.get(key) or manual[key]
        source = "both" if key in automatic and key in manual else (
            "auto" if key in automatic else "manual"
        )
        object_media = [item for item in media if _media_matches_target(item, target)]
        if isinstance(target, CharacterAssociationUiTarget):
            canonical = stale.screen_canonical_status(
                project_id, target.scheme_id
            ).screens.get(target.screen_id)
            title = screen_names.get((target.scheme_id, target.screen_id), target.screen_id)
            detail = f"{target.scheme_id.upper()} · UI 页面"
            featured = canonical.path if canonical else (
                object_media[0].path if object_media else None
            )
        else:
            production = productions.get(target.production_id)
            title = production.title if production else target.production_id
            detail = "视频企划"
            featured = _video_featured_path(production, object_media)
        related.append(CharacterRelatedObject(
            target=target,
            title=title,
            detail=detail,
            source=source,
            featured_path=featured,
            count=len(object_media),
            media=_compact_media(object_media, featured),
        ))
    return related


def _media_matches_target(item: GalleryMedia, target: CharacterAssociationTarget) -> bool:
    if isinstance(target, CharacterAssociationUiTarget):
        return (
            item.target.kind == "ui"
            and item.target.scheme_id == target.scheme_id
            and item.target.screen_id == target.screen_id
        )
    return (
        item.target.kind == "video"
        and item.target.production_id == target.production_id
    )


def _video_featured_path(production, media: list[GalleryMedia]) -> str | None:
    if production:
        candidates = [production.selected] if production.selected else []
        candidate_set = set(candidates)
        newest = next((item.path for item in media if item.path in candidate_set), None)
        if newest:
            return newest
        if candidates:
            return candidates[0]
    return media[0].path if media else None


def _compact_media(media: list[GalleryMedia], featured_path: str | None) -> list[GalleryMedia]:
    result: list[GalleryMedia] = []
    if media:
        result.append(media[0])
    featured = next((item for item in media if item.path == featured_path), None)
    if featured and (not result or result[0].path != featured.path):
        result.append(featured)
    return result


def _featured_media(
    assets: list[CharacterAssetGroup],
    related: list[CharacterRelatedObject],
) -> list[GalleryMedia]:
    result: list[GalleryMedia] = []
    seen: set[str] = set()

    def add(item: GalleryMedia | None) -> None:
        if item is None or item.path in seen:
            return
        seen.add(item.path)
        result.append(item)

    for asset in assets:
        canonical_path = asset.canonical.path if asset.canonical else None
        add(next((item for item in asset.media if item.path == canonical_path), None))
        add(asset.media[0] if asset.media else None)
    for item in related:
        add(next((media for media in item.media if media.path == item.featured_path), None))
        add(item.media[0] if item.media else None)
    return result[:12]
