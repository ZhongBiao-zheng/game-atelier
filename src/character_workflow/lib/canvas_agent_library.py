"""Project and team reference lookup and atomic asset-to-canvas change sets."""
from __future__ import annotations

import base64
import hashlib
import io
import secrets
from datetime import datetime, timezone

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from character_workflow.lib.canvas_agent_schema import AddMediaNodeChange, CanvasPointInput
from character_workflow.lib.canvas_projects import (
    _display_image_dimensions, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked,
    canvas_project_dir, canvas_project_lock_path,
)
from character_workflow.lib.creation_assets import (
    _mark_used_if_present, asset_media_content, creation_asset_media_path, get_creation_asset,
    list_creation_assets, video_dimensions_from_bytes,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES, CanvasCreationAssetSnapshotOrigin, CanvasDocument, CanvasMediaVersion,
)
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.team_library import reachable_mounts
from character_workflow.lib.team_library_adopt import TeamAssetAdoptError, adopt_team_asset
from character_workflow.lib.team_library_index import (
    get_entry, parse_instant, query_index, read_index, thumbnail_bytes,
)

ASSET_IMAGE_PREFIX = "asset:"
# 团队资产引用 = team:<library_id>/<entry_id>；放上画布时先采用成本机创作资产。
TEAM_ASSET_PREFIX = "team:"
_EARLIEST = datetime.min.replace(tzinfo=timezone.utc)


def project_image(project_id: str, asset_id: str):
    asset = get_creation_asset(asset_id)
    media = asset_media_content(asset)
    if project_id not in asset.project_ids or not asset.category or not media or not media.mime_type.startswith("image/"):
        raise ValueError("参考图不属于本项目参考库")
    return asset, media


def preview(project_id: str, asset_id: str) -> tuple[str, int, int]:
    _asset, media = project_image(project_id, asset_id)
    path = creation_asset_media_path(asset_id)
    if path.stat().st_size > 25 * 1024 * 1024:
        raise ValueError("图片超过安全预览大小")
    with Image.open(path) as opened:
        if opened.width * opened.height > 40_000_000:
            raise ValueError("图片超过安全预览像素限制")
        rendered = ImageOps.exif_transpose(opened).convert("RGB")
        width, height = rendered.size
        rendered.thumbnail((512, 512))
        buffer = io.BytesIO()
        rendered.save(buffer, format="JPEG", quality=75)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(), width, height


def search_library(project_id: str, category: str | None, limit: int) -> dict:
    rows = []
    for asset in list_creation_assets(project_id=project_id, has_category=True).assets:
        media = asset_media_content(asset)
        if not media or not media.mime_type.startswith("image/") or (category and asset.category != category):
            continue
        try:
            _url, width, height = preview(project_id, asset.asset_id)
        except (OSError, ValueError):
            width = height = None
        rows.append({"asset_id": asset.asset_id, "title": asset.title, "category": asset.category,
                     "width": width, "height": height})
        if len(rows) >= limit:
            break
    return {"assets": rows, "attach_images": [ASSET_IMAGE_PREFIX + row["asset_id"] for row in rows]}


def team_entry(project_id: str, ref: str):
    library_id, _, entry_id = ref.removeprefix(TEAM_ASSET_PREFIX).partition("/")
    mount = next((m for m in reachable_mounts(project_id) if m.library_id == library_id), None)
    if mount is None:
        raise ValueError("团队资产不在本画布挂载的团队库里")
    index = read_index(library_id)
    if index is None:
        raise ValueError("团队库索引尚未建立，请先重新扫描")
    try:
        return mount, get_entry(index, entry_id)
    except KeyError:
        raise ValueError("团队库里找不到这条资产") from None


def team_preview(project_id: str, ref: str) -> str:
    mount, entry = team_entry(project_id, ref)
    data = thumbnail_bytes(mount, entry, 512)
    if data is None:
        raise ValueError("团队资产没有可用缩略图")
    try:
        with Image.open(io.BytesIO(data)) as opened:
            rendered = opened.convert("RGB")
    except (OSError, UnidentifiedImageError) as error:
        raise ValueError("团队资产缩略图不可读") from error
    buffer = io.BytesIO()
    rendered.save(buffer, format="JPEG", quality=75)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def _matches_category(entry, category: str) -> bool:
    # 原始文件和旧分享没有类别：退回按标题、标签和所在目录名匹配（团队常按类别分文件夹）。
    if entry.category is not None:
        return entry.category == category
    return (category in entry.title or category in entry.relative_path
            or any(category in tag for tag in entry.tags))


def search_team(project_id: str, query: str | None, category: str | None, limit: int) -> dict:
    found = []
    for mount in reachable_mounts(project_id):
        index = read_index(mount.library_id)
        if index is None:
            continue
        for entry in query_index(index, q=query, limit=500).entries:
            if entry.status != "ready" or not (entry.mime_type or "").startswith("image/"):
                continue
            if category and not _matches_category(entry, category):
                continue
            found.append((mount, entry))
    found.sort(key=lambda row: parse_instant(row[1].updated_at) or _EARLIEST, reverse=True)
    rows = [{"asset_id": f"{TEAM_ASSET_PREFIX}{mount.library_id}/{entry.id}", "title": entry.title,
             "category": entry.category, "tags": entry.tags, "author": entry.author, "library": mount.name}
            for mount, entry in found[:limit]]
    return {"assets": rows, "attach_images": [row["asset_id"] for row in rows]}


def _adopt_team_refs(payload):
    """把 add_asset_node 里的团队资产引用换成采用后的创作资产 id；采用可重复调用，已采用过就复用。"""
    adopted: dict[str, str] = {}
    for change in payload.changes:
        ref = getattr(change, "asset_id", "") if change.op == "add_asset_node" else ""
        if not ref.startswith(TEAM_ASSET_PREFIX) or ref in adopted:
            continue
        mount, entry = team_entry(payload.project_id, ref)
        try:
            asset, _created = adopt_team_asset(mount=mount, entry=entry, project_id=payload.project_id)
        except FileNotFoundError:
            raise ValueError("团队资产的文件还没同步到本机") from None
        except (TeamAssetAdoptError, ValidationError) as error:
            raise ValueError(f"团队资产现在不能采用：{error}") from error
        adopted[ref] = asset.asset_id
    if not adopted:
        return payload, adopted
    changes = [change.model_copy(update={"asset_id": adopted[change.asset_id]})
               if change.op == "add_asset_node" and change.asset_id in adopted else change
               for change in payload.changes]
    return payload.model_copy(update={"changes": changes}), adopted


def existing_asset_node(document: CanvasDocument, asset_id: str):
    for node in document.nodes:
        version = document.content_versions.get(getattr(node.data, "current_version_id", None))
        if version and getattr(version.origin, "asset_id", None) == asset_id:
            return node
    return None


def apply_asset_changes(payload) -> dict:
    from character_workflow.lib.canvas_agent_tools import _apply, _now
    from character_workflow.lib.canvas_reproduce import _commit

    project_id = payload.project_id
    payload, team_assets = _adopt_team_refs(payload)
    prepared_assets = {}
    for change in payload.changes:
        if change.op != "add_asset_node" or change.asset_id in prepared_assets:
            continue
        try:
            asset = get_creation_asset(change.asset_id)
        except KeyError:
            raise ValueError("参考资产不存在") from None
        media = asset_media_content(asset)
        # 采用来的团队资产没有类别也能放：它来自本画布挂载的库，本身就是参考。
        if project_id not in asset.project_ids or media is None or (not asset.category and asset.adopted_from is None):
            raise ValueError("只能添加本项目参考库或本画布团队库的媒体资产")
        try:
            body = creation_asset_media_path(asset.asset_id).read_bytes()
        except OSError as error:
            raise ValueError("参考资产媒体不可读") from error
        if hashlib.sha256(body).hexdigest() != media.sha256:
            raise ValueError("资产内容摘要不一致")
        prepared_assets[asset.asset_id] = (asset, media, body)
    used: set[str] = set()
    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        document = _read_canvas_document_unlocked(project_id)
        if document.revision != payload.expected_revision:
            raise CanvasToolError("DOCUMENT_CONFLICT", "画布已变化，请重新读取后再改")
        timestamp = _now()
        versions = dict(document.content_versions)
        writes = []
        changes = []
        aliases: dict[str, str] = {}
        asset_nodes: dict[str, str] = {}
        requested: set[str] = set()
        node_ids = {node.id for node in document.nodes}
        added_versions = []
        for change in payload.changes:
            if change.op != "add_asset_node":
                updates = {key: aliases[value] for key, value in change.model_dump().items()
                           if key in {"node_id", "source_node_id", "target_node_id"} and value in aliases}
                changes.append(change.model_copy(update=updates))
                continue
            if change.node_id in requested:
                raise ValueError("同一批资产节点 ID 不能重复")
            requested.add(change.node_id)
            asset, media, body = prepared_assets[change.asset_id]
            existing = existing_asset_node(document, asset.asset_id)
            existing_id = asset_nodes.get(asset.asset_id) or (existing.id if existing else None)
            if change.node_id in node_ids and change.node_id != existing_id:
                raise ValueError("节点 ID 已存在")
            used.add(asset.asset_id)
            if existing_id:
                aliases[change.node_id] = existing_id
                asset_nodes[asset.asset_id] = existing_id
                continue
            kind = media.mime_type.split("/", 1)[0]
            width = height = None
            if kind == "image":
                width, height = _display_image_dimensions(body)
            elif kind == "video":
                dims = video_dimensions_from_bytes(body)
                if dims:
                    width, height = dims
            version_id = f"version-{secrets.token_hex(12)}"
            relative = f"uploads/creation-asset-{secrets.token_hex(12)}{MEDIA_SUFFIXES[media.mime_type]}"
            version = CanvasMediaVersion(
                version_id=version_id, created_at=timestamp, sha256=media.sha256,
                origin=CanvasCreationAssetSnapshotOrigin(kind="creation_asset_snapshot", title=asset.title,
                                                         asset_id=asset.asset_id),
                kind=kind, path=relative, mime_type=media.mime_type, bytes=len(body), width=width, height=height,
            )
            versions[version_id] = version
            added_versions.append(version_id)
            writes.append((canvas_project_dir(project_id) / relative, body))
            changes.append(AddMediaNodeChange(op="add_media_node", version_id=version_id,
                                              node_id=change.node_id, title=asset.title,
                                              position=CanvasPointInput(**change.position.model_dump())))
            node_ids.add(change.node_id)
            asset_nodes[asset.asset_id] = change.node_id
        prepared = document.model_copy(update={"content_versions": versions})
        updated, created = _apply(prepared, changes, timestamp)
        updated = CanvasDocument.model_validate(updated.model_dump(mode="json") | {
            "revision": document.revision + 1, "updated_at": timestamp,
        })
        _commit(project_id, updated, writes, timestamp)
    for asset_id in used:
        _mark_used_if_present(asset_id, project_id)
    return {"project_id": project_id, "revision": updated.revision, **created,
            "version_ids": [*added_versions, *created["version_ids"]],
            "asset_nodes": asset_nodes, "node_aliases": aliases, "team_assets": team_assets}
