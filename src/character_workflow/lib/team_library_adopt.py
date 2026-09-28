"""采用：把团队资产拷进个人创作资产库。永远是拷贝，本机对象不依赖库内路径。"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from character_workflow.lib import team_library_index as idx
from character_workflow.lib.creation_assets import (
    asset_media_content,
    create_adopted_asset,
    find_adopted_asset,
    find_media_asset_by_sha256,
    list_creation_assets,
    mark_creation_asset_used,
    get_creation_asset,
    new_creation_asset_id,
    replace_adopted_asset,
    sniff_media_mime,
    store_media_blob,
)
from character_workflow.lib.schemas import (
    AdoptionOrigin,
    CreationAsset,
    CreationGenerationAssetContent,
    CreationMediaAssetContent,
    CreationPromptAssetContent,
    MEDIA_SUFFIXES,
    GenerationRecipe,
    TeamAssetFile,
    TeamLibraryIndex,
    TeamLibraryIndexEntry,
    TeamLibraryMount,
)
from character_workflow.lib.team_library import get_mount, library_reachable

Staleness = Literal["fresh", "stale", "withdrawn", "unknown"]
_LocalContent = (
    CreationPromptAssetContent | CreationMediaAssetContent | CreationGenerationAssetContent
)


class TeamAssetAdoptError(ValueError):
    """这条团队资产现在不能采用。"""


# 重新采用的三种失败各自映射不同状态码（409 / 409 / 503）：刻意不继承 TeamAssetAdoptError
# 或 ValueError，免得被路由里既有的 422 分支先接住。
class TeamAssetNotAdopted(Exception):
    """这条本机资产不是从团队库采用的。"""


class TeamAssetWithdrawn(Exception):
    """来源条目已不在库里（撤回 / 改名 / 删除）。"""


class TeamLibraryUnreachable(Exception):
    """来源库没挂载、目录不可达或还没扫过索引。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _library_file(mount: TeamLibraryMount, relative: str) -> Path:
    root = Path(mount.mount_path).resolve()
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    return target


def _store(body: bytes, filename: str, mime_type: str | None) -> CreationMediaAssetContent:
    try:
        return store_media_blob(body, filename, mime_type)
    except ValueError as error:  # 类型不符 / 超上限：是这条团队资产不能采用，不是请求写错了
        raise TeamAssetAdoptError(str(error)) from error


def _verified_bytes(
    asset_dir: Path, relative: str, sha256: str, mime_type: str
) -> tuple[bytes, str]:
    """读资产目录内的文件并校验归属与内容，不落盘；返回 (字节, 按内容认定的 mime)。

    schema 正则挡不住 symlink。声明的类型与内容不符（别的工具 / 旧版本写的存量资产）
    不否决：sha256 已保证是分享者那份字节，按嗅探结果存，调用方据此改写快照。
    """
    target = idx.asset_dir_file(asset_dir, relative)
    if target is None:
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    body = target.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha256:
        raise TeamAssetAdoptError("文件内容与 asset.json 记录不一致，可能还没同步完")
    actual = sniff_media_mime(body, mime_type) or mime_type
    if actual not in MEDIA_SUFFIXES:
        raise TeamAssetAdoptError(f"不支持的媒体类型：{actual}")
    return body, actual


def _join_project(asset: CreationAsset, project_id: str | None) -> CreationAsset:
    if project_id and project_id not in asset.project_ids:
        return mark_creation_asset_used(asset.asset_id, project_id)
    return asset


def _commit(asset: CreationAsset) -> tuple[CreationAsset, bool]:
    # 目录持锁再按来源查一次：并发采用同一条时拿回的是别人刚建的那条。
    stored = create_adopted_asset(asset)
    return stored, stored.asset_id == asset.asset_id


def _new_adopted(
    *,
    kind: Literal["prompt", "media", "generation"],
    title: str,
    tags: list[str],
    content,
    project_id: str | None,
    origin: AdoptionOrigin,
) -> CreationAsset:
    timestamp = _now()
    return CreationAsset(
        asset_id=new_creation_asset_id(),
        kind=kind,
        title=title,
        tags=tags,
        created_at=timestamp,
        updated_at=timestamp,
        content=content,
        project_ids=[project_id] if project_id else [],
        adopted_from=origin,
    )


def _raw_origin(mount: TeamLibraryMount, entry: TeamLibraryIndexEntry) -> AdoptionOrigin:
    return AdoptionOrigin(
        library_id=mount.library_id,
        asset_id=entry.id,
        source_updated_at=entry.updated_at,
        raw_path=entry.relative_path,
    )


def _adopt_raw(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, project_id: str | None
) -> tuple[CreationAsset, bool]:
    # 原始文件的 id 只由路径得来，内容会被 SVN update 换掉：只按内容去重，不按来源 id。
    body = _library_file(mount, entry.relative_path).read_bytes()
    duplicate = find_media_asset_by_sha256(hashlib.sha256(body).hexdigest())
    if duplicate is not None:
        return _join_project(duplicate, project_id), False
    content = _store(body, Path(entry.relative_path).name, entry.mime_type)
    return _commit(_new_adopted(
        kind="media", title=entry.title, tags=[], content=content,
        project_id=project_id, origin=_raw_origin(mount, entry),
    ))


def _read_team_asset(asset_dir: Path, entry: TeamLibraryIndexEntry) -> TeamAssetFile:
    manifest = idx.asset_dir_file(asset_dir, "asset.json")
    if manifest is None:
        raise TeamAssetAdoptError("库里找不到这个文件，可能还没同步完")
    team_asset = TeamAssetFile.model_validate_json(manifest.read_text(encoding="utf-8"))
    if team_asset.kind != entry.kind or team_asset.asset_id != entry.id:
        raise TeamAssetAdoptError("索引与库内记录不一致，请重新扫描")
    return team_asset


def _generation_content(
    asset_dir: Path, team_asset: TeamAssetFile
) -> CreationGenerationAssetContent:
    """两遍：先把成片与全部参考校验完（不落盘），全过才逐个存 blob，失败不留半套。"""
    media, snapshot = team_asset.media, team_asset.snapshot
    assert media is not None and snapshot is not None
    output, output_mime = _verified_bytes(
        asset_dir, media.filename, media.sha256, media.mime_type
    )
    refs = [
        (row, *_verified_bytes(asset_dir, row.path, row.sha256, row.mime_type))
        for row in snapshot.inputs
    ]
    stored_media = _store(output, media.filename, output_mime)
    for row, body, mime in refs:
        _store(body, Path(row.path).name, mime)
    # 快照里的类型跟着实际存下的 blob 走，blob_path_for(sha, mime) 才找得到。
    inputs = [
        {
            **row.model_dump(exclude={"path"}),
            "mime_type": mime,
            "kind": mime.split("/", 1)[0],
        }
        for row, _body, mime in refs
    ]
    return CreationGenerationAssetContent(
        kind="generation",
        media=stored_media,
        snapshot=GenerationRecipe.model_validate(
            {**snapshot.model_dump(exclude={"inputs"}), "inputs": inputs}
        ),
    )


def _shared_copy(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry
) -> tuple[TeamAssetFile, _LocalContent, AdoptionOrigin]:
    """读库内分享资产、校验并把 blob 落进本机：返回 (团队资产, 本机内容, 来源记录)。"""
    try:
        asset_dir = idx.shared_asset_dir(mount, entry)
    except FileNotFoundError:
        raise TeamAssetAdoptError("库里找不到这条资产，可能还没同步完") from None
    team_asset = _read_team_asset(asset_dir, entry)
    if team_asset.kind == "generation":
        content = _generation_content(asset_dir, team_asset)
    elif team_asset.kind == "prompt":
        assert team_asset.prompt is not None
        content = team_asset.prompt
    else:
        media = team_asset.media
        assert media is not None
        body, mime = _verified_bytes(asset_dir, media.filename, media.sha256, media.mime_type)
        content = _store(body, media.filename, mime)
    origin = AdoptionOrigin(
        library_id=mount.library_id,
        asset_id=team_asset.asset_id,
        source_updated_at=team_asset.updated_at,
    )
    return team_asset, content, origin


def _adopt_shared(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, project_id: str | None
) -> tuple[CreationAsset, bool]:
    existing = find_adopted_asset(mount.library_id, entry.id)
    if existing is not None:
        return _join_project(existing, project_id), False
    team_asset, content, origin = _shared_copy(mount, entry)
    return _commit(_new_adopted(
        kind=team_asset.kind, title=team_asset.title, tags=team_asset.tags, content=content,
        project_id=project_id, origin=origin,
    ))


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


def _raw_content_unchanged(
    mount: TeamLibraryMount, entry: TeamLibraryIndexEntry, asset: CreationAsset
) -> bool | None:
    """mtime 变了不等于内容变了（SVN 检出会重写 mtime）：按内容再判一次。读不到 → None。"""
    media = asset_media_content(asset)
    if media is None:
        return None
    try:
        body = idx.entry_content_path(mount, entry).read_bytes()
    except OSError:
        return None
    return hashlib.sha256(body).hexdigest() == media.sha256


_Source = tuple[TeamLibraryMount, TeamLibraryIndex] | None


def _library_source(library_id: str) -> _Source:
    """来源库的 (挂载, 索引)；没挂载 / 不可达 / 没扫过 → None。"""
    try:
        mount = get_mount(library_id)
    except KeyError:
        return None
    if not library_reachable(mount):
        return None
    index = idx.read_index(library_id)
    if index is None:
        return None
    return mount, index


def _origin_entry_id(origin: AdoptionOrigin) -> str:
    # 原始文件的条目 id 由路径派生：按 raw_path 重新算，不依赖采用时记下的 id 拼法。
    return idx.raw_entry_id(origin.raw_path) if origin.raw_path else origin.asset_id


def _staleness(asset: CreationAsset, source: _Source) -> Staleness:
    origin = asset.adopted_from
    if origin is None or source is None:
        return "unknown"
    mount, index = source
    try:
        entry = idx.get_entry(index, _origin_entry_id(origin))
    except KeyError:
        return "withdrawn"
    if entry.status != "ready":
        return "unknown"
    current = idx.parse_instant(entry.updated_at)
    adopted = idx.parse_instant(origin.source_updated_at)
    if current is None or adopted is None:
        return "unknown"
    if current <= adopted:
        return "fresh"
    if origin.raw_path is None:
        return "stale"
    unchanged = _raw_content_unchanged(mount, entry, asset)
    if unchanged is None:
        return "unknown"
    return "fresh" if unchanged else "stale"


def adoption_staleness(asset: CreationAsset) -> Staleness:
    """采用副本相对来源的状态。库没挂、不可达、没扫过、条目同步中 → unknown（不提示）。"""
    origin = asset.adopted_from
    if origin is None:
        return "unknown"
    return _staleness(asset, _library_source(origin.library_id))


def adoption_staleness_batch(asset_ids: list[str]) -> dict[str, Staleness]:
    """资产面板一次查一批：每个来源库只读一次挂载与索引。不存在的 id 不出现在结果里。"""
    wanted = set(asset_ids)
    if not wanted:
        return {}
    assets = [row for row in list_creation_assets().assets if row.asset_id in wanted]
    sources: dict[str, _Source] = {}
    statuses: dict[str, Staleness] = {}
    for asset in assets:
        origin = asset.adopted_from
        if origin is not None and origin.library_id not in sources:
            sources[origin.library_id] = _library_source(origin.library_id)
        source = sources.get(origin.library_id) if origin is not None else None
        statuses[asset.asset_id] = _staleness(asset, source)
    return statuses


def readopt_team_asset(asset_id: str) -> CreationAsset:
    """重新采用：用来源的当前版本覆盖本机副本（保留本机 id / 创建时间 / 所属项目 / 最近使用）。

    本机资产不存在 → KeyError；不是采用来的 → TeamAssetNotAdopted；来源库没挂 / 不可达 / 没索引
    → TeamLibraryUnreachable；条目不在了 → TeamAssetWithdrawn；条目同步中或校验不过 → TeamAssetAdoptError。
    """
    asset = get_creation_asset(asset_id)
    origin = asset.adopted_from
    if origin is None:
        raise TeamAssetNotAdopted(asset_id)
    source = _library_source(origin.library_id)
    if source is None:
        raise TeamLibraryUnreachable(origin.library_id)
    mount, index = source
    try:
        entry = idx.get_entry(index, _origin_entry_id(origin))
    except KeyError:
        raise TeamAssetWithdrawn(origin.asset_id) from None
    if entry.status != "ready":
        raise TeamAssetAdoptError("这条资产还没同步完整")
    if entry.kind == "raw":
        body = _library_file(mount, entry.relative_path).read_bytes()
        content = _store(body, Path(entry.relative_path).name, entry.mime_type)
        title, tags, new_origin = entry.title, [], _raw_origin(mount, entry)
    else:
        team_asset, content, new_origin = _shared_copy(mount, entry)
        title, tags = team_asset.title, team_asset.tags
    return replace_adopted_asset(
        asset_id, title=title, tags=tags, content=content, adopted_from=new_origin,
    )
