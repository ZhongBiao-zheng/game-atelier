"""采用：把团队资产拷进个人创作资产库。永远是拷贝，本机对象不依赖库内路径。"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib.creation_assets import (
    create_adopted_asset,
    find_adopted_asset,
    find_media_asset_by_sha256,
    new_creation_asset_id,
    store_media_blob,
)
from character_workflow.lib.schemas import (
    AdoptionOrigin,
    CreationAsset,
    TeamAssetFile,
    TeamLibraryIndexEntry,
    TeamLibraryMount,
)


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


def adopt_team_asset(
    *,
    mount: TeamLibraryMount,
    entry: TeamLibraryIndexEntry,
    project_id: str | None,
) -> tuple[CreationAsset, bool]:
    if entry.status != "ready":
        raise TeamAssetAdoptError("这条资产还没同步完整")
    if entry.kind == "generation":
        raise TeamAssetAdoptError("生成资产的采用尚未开放")
    existing = find_adopted_asset(mount.library_id, entry.id)
    if existing is not None:
        return existing, False
    timestamp = _now()
    project_ids = [project_id] if project_id else []

    if entry.kind == "raw":
        body = _library_file(mount, entry.relative_path).read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        duplicate = find_media_asset_by_sha256(digest)
        if duplicate is not None:
            return duplicate, False
        content = store_media_blob(body, Path(entry.relative_path).name, entry.mime_type)
        asset = CreationAsset(
            asset_id=new_creation_asset_id(),
            kind="media",
            title=entry.title,
            tags=[],
            created_at=timestamp,
            updated_at=timestamp,
            content=content,
            project_ids=project_ids,
            adopted_from=AdoptionOrigin(
                library_id=mount.library_id,
                asset_id=entry.id,
                source_updated_at=entry.updated_at,
                raw_path=entry.relative_path,
            ),
        )
        return create_adopted_asset(asset), True

    asset_json = _library_file(mount, f"{entry.relative_path}/asset.json")
    team_asset = TeamAssetFile.model_validate_json(asset_json.read_text(encoding="utf-8"))
    origin = AdoptionOrigin(
        library_id=mount.library_id,
        asset_id=team_asset.asset_id,
        source_updated_at=team_asset.updated_at,
    )
    if team_asset.kind == "prompt":
        assert team_asset.prompt is not None
        content = team_asset.prompt
    else:
        assert team_asset.media is not None
        body = _library_file(mount, f"{entry.relative_path}/{team_asset.media.filename}").read_bytes()
        if hashlib.sha256(body).hexdigest() != team_asset.media.sha256:
            raise TeamAssetAdoptError("文件内容与 asset.json 记录不一致，可能还没同步完")
        content = store_media_blob(body, team_asset.media.filename, team_asset.media.mime_type)
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
