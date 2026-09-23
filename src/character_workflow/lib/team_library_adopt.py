"""采用：把团队资产拷进个人创作资产库。永远是拷贝，本机对象不依赖库内路径。"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from character_workflow.lib import team_library_index as idx
from character_workflow.lib.creation_assets import (
    create_adopted_asset,
    create_generation_asset,
    find_adopted_asset,
    find_media_asset_by_sha256,
    mark_creation_asset_used,
    new_creation_asset_id,
    store_media_blob,
)
from character_workflow.lib.schemas import (
    AdoptionOrigin,
    CreationAsset,
    CreationMediaAssetContent,
    GenerationRecipe,
    TeamAssetFile,
    TeamAssetMedia,
    TeamGenerationSnapshot,
    TeamLibraryIndexEntry,
    TeamLibraryMount,
)
from character_workflow.lib.team_library import get_mount, library_reachable

Staleness = Literal["fresh", "stale", "withdrawn", "unknown"]


class TeamAssetAdoptError(ValueError):
    """这条团队资产现在不能采用。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _library_file(mount: TeamLibraryMount, relative: str) -> Path:
    root = Path(mount.mount_path).resolve()
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    return target


def _asset_dir(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> Path:
    root = Path(mount.mount_path).resolve()
    asset_dir = (root / entry.relative_path).resolve()
    if root not in asset_dir.parents or not asset_dir.is_dir():
        raise TeamAssetAdoptError("库里找不到这条资产，可能还没同步完")
    return asset_dir


def _asset_file_bytes(asset_dir: Path, relative: str, sha256: str) -> bytes:
    """读资产目录内的文件并校验内容。schema 正则挡不住 symlink，必须 resolve 后再判归属。"""
    target = idx.asset_dir_file(asset_dir, relative)
    if target is None:
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    body = target.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha256:
        raise TeamAssetAdoptError("文件内容与 asset.json 记录不一致，可能还没同步完")
    return body


def _join_project(asset: CreationAsset, project_id: str | None) -> CreationAsset:
    if project_id and project_id not in asset.project_ids:
        return mark_creation_asset_used(asset.asset_id, project_id)
    return asset


def _adopt_raw(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, project_id: str | None
) -> tuple[CreationAsset, bool]:
    # 原始文件的 id 只由路径得来，内容会被 SVN update 换掉：只按内容去重，不按来源 id。
    body = _library_file(mount, entry.relative_path).read_bytes()
    digest = hashlib.sha256(body).hexdigest()
    duplicate = find_media_asset_by_sha256(digest)
    if duplicate is not None:
        return _join_project(duplicate, project_id), False
    content = store_media_blob(body, Path(entry.relative_path).name, entry.mime_type)
    timestamp = _now()
    asset = CreationAsset(
        asset_id=new_creation_asset_id(),
        kind="media",
        title=entry.title,
        tags=[],
        created_at=timestamp,
        updated_at=timestamp,
        content=content,
        project_ids=[project_id] if project_id else [],
        adopted_from=AdoptionOrigin(
            library_id=mount.library_id,
            asset_id=entry.id,
            source_updated_at=entry.updated_at,
            raw_path=entry.relative_path,
        ),
    )
    return create_adopted_asset(asset), True


def _store_media(asset_dir: Path, media: TeamAssetMedia) -> CreationMediaAssetContent:
    body = _asset_file_bytes(asset_dir, media.filename, media.sha256)
    return store_media_blob(body, media.filename, media.mime_type)


def _store_snapshot(asset_dir: Path, snapshot: TeamGenerationSnapshot) -> GenerationRecipe:
    """每份参考拷进 blobs；blob 按探测出的 mime 存，与快照声明不一致会让复刻取不到文件。"""
    for row in snapshot.inputs:
        body = _asset_file_bytes(asset_dir, row.path, row.sha256)
        stored = store_media_blob(body, Path(row.path).name, row.mime_type)
        if stored.mime_type != row.mime_type:
            raise TeamAssetAdoptError("参考文件类型与 asset.json 记录不一致")
    return GenerationRecipe.model_validate(
        snapshot.model_dump(exclude={"inputs": {"__all__": {"path"}}})
    )


def _adopt_shared(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, project_id: str | None
) -> tuple[CreationAsset, bool]:
    existing = find_adopted_asset(mount.library_id, entry.id)
    if existing is not None:
        return _join_project(existing, project_id), False
    asset_dir = _asset_dir(mount, entry)
    manifest = idx.asset_dir_file(asset_dir, "asset.json")
    if manifest is None:
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    team_asset = TeamAssetFile.model_validate_json(manifest.read_text(encoding="utf-8"))
    if team_asset.kind != entry.kind or team_asset.asset_id != entry.id:
        raise TeamAssetAdoptError("索引与库内记录不一致，请重新扫描")
    origin = AdoptionOrigin(
        library_id=mount.library_id,
        asset_id=team_asset.asset_id,
        source_updated_at=team_asset.updated_at,
    )
    project_ids = [project_id] if project_id else []
    if team_asset.kind == "generation":
        assert team_asset.media is not None and team_asset.snapshot is not None
        media = _store_media(asset_dir, team_asset.media)
        snapshot = _store_snapshot(asset_dir, team_asset.snapshot)
        created = create_generation_asset(
            title=team_asset.title,
            tags=team_asset.tags,
            media=media,
            snapshot=snapshot,
            project_id=project_id,
            adopted_from=origin,
        )
        return created, True
    if team_asset.kind == "prompt":
        assert team_asset.prompt is not None
        content = team_asset.prompt
    else:
        assert team_asset.media is not None
        content = _store_media(asset_dir, team_asset.media)
    timestamp = _now()
    asset = CreationAsset(
        asset_id=new_creation_asset_id(),
        kind=team_asset.kind,
        title=team_asset.title,
        tags=team_asset.tags,
        created_at=timestamp,
        updated_at=timestamp,
        content=content,
        project_ids=project_ids,
        adopted_from=origin,
    )
    return create_adopted_asset(asset), True


def adopt_team_asset(
    *,
    mount: TeamLibraryMount,
    entry: TeamLibraryIndexEntry,
    project_id: str | None,
) -> tuple[CreationAsset, bool]:
    if entry.status != "ready":
        raise TeamAssetAdoptError("这条资产还没同步完整")
    if entry.kind == "raw":
        return _adopt_raw(mount, entry, project_id)
    return _adopt_shared(mount, entry, project_id)


def _instant(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def adoption_staleness(asset: CreationAsset) -> Staleness:
    """采用副本相对来源的状态。库没挂、不可达、没扫过 → unknown（不提示）。"""
    origin = asset.adopted_from
    if origin is None:
        return "unknown"
    try:
        mount = get_mount(origin.library_id)
    except KeyError:
        return "unknown"
    if not library_reachable(mount):
        return "unknown"
    index = idx.read_index(origin.library_id)
    if index is None:
        return "unknown"
    # 原始文件的条目 id 由路径派生：按 raw_path 重新算，不依赖采用时记下的 id 拼法。
    entry_id = idx.raw_entry_id(origin.raw_path) if origin.raw_path else origin.asset_id
    try:
        entry = idx.get_entry(index, entry_id)
    except KeyError:
        return "withdrawn"
    current, adopted = _instant(entry.updated_at), _instant(origin.source_updated_at)
    if current is None or adopted is None:
        return "unknown"
    return "stale" if current > adopted else "fresh"
