"""团队库 API：挂载 / 索引 / 内容 / 缩略图 / 采用 / 显示名。

所有路径经本地会话 cookie（与 routes.py 同一 middleware）。路由一律写成同步 `def`：
本模块每个处理器都会读盘 / 抢挂载表文件锁，FastAPI 会把同步路由挪到线程池，
写成 `async def` 就等于把「等锁」搬进事件循环（见 tests/test_route_event_loop_offloading.py）。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib import team_library as tl
from character_workflow.lib import team_library_index as idx
from character_workflow.lib.schemas import (
    TeamAssetAdoptRequest,
    TeamAssetAdoptResponse,
    TeamLibraryAssetPage,
    TeamLibraryIndex,
    TeamLibraryMount,
    TeamLibraryMountRequest,
    TeamLibraryView,
    UserProfile,
)
from character_workflow.lib.team_library_adopt import TeamAssetAdoptError, adopt_team_asset

team_library_router = APIRouter(prefix="/api")

_UNREACHABLE = {"code": "library_unreachable", "message": "团队库目录不可达"}


def _mounts(project_id: str | None = None) -> list[TeamLibraryMount]:
    try:
        return tl.list_mounts(project_id)
    # 挂载表损坏是磁盘状态故障，不是这次请求的错：500 带上是哪个文件，让画师能去修。
    # OSError 一并兜住——读不动那个文件（权限 / 编码）和内容坏掉对画师是同一件事。
    except ValueError as error:
        raise HTTPException(500, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(500, detail=f"读不了挂载记录：{tl._mounts_path()}（{error}）") from error


def _view(mount: TeamLibraryMount) -> TeamLibraryView:
    index = idx.read_index(mount.library_id)
    return TeamLibraryView(
        library_id=mount.library_id,
        project_id=mount.project_id,
        name=mount.name,
        mount_path=mount.mount_path,
        mounted_at=mount.mounted_at,
        reachable=tl.library_reachable(mount),
        asset_count=len(index.entries) if index else 0,
        scanned_at=index.scanned_at if index else None,
    )


def _mount_or_404(library_id: str) -> TeamLibraryMount:
    _mounts()  # 挂载表损坏 → 500 带文件名，别被下面当成 404
    try:
        return tl.get_mount(library_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个团队库") from None


def _index_or_503(mount: TeamLibraryMount) -> TeamLibraryIndex:
    """读端点只读缓存索引，绝不顺手扫一次。

    扫描要走整棵工作副本，几万个文件时是秒级；挂在读端点上，每个没命中缓存的请求都会各扫
    一遍（没有单飞），刷新一下页面就是并发全量扫描。扫描只发生在挂载与 rescan——那两处本来
    就在调 scan_library，而且是画师主动触发、等得起的动作。
    """
    if not tl.library_reachable(mount):
        raise HTTPException(503, detail=_UNREACHABLE)
    index = idx.read_index(mount.library_id)
    if index is None:
        raise HTTPException(
            503,
            detail={"code": "library_unreachable", "message": "索引尚未建立，请重新扫描"},
        )
    return index


def _reject_reserved_mount_path(raw: str) -> None:
    """data root 自身 / 它的祖先 / 它里面的任意目录都不能当挂载点。

    挂载会往目录里写 `.atelier-library.json`、并把整棵树当团队库扫描；指到 data root
    （或它上面的某一层）就等于把画师自己的全部创作资产当成「团队库」，采用时还会自采自己；
    指到它里面（画布目录、创作资产、.runtime）就是往工作目录里写别人的清单。
    """
    import os

    try:
        folder = Path(os.path.expandvars(os.path.expanduser(raw))).resolve()
    except (OSError, ValueError) as error:
        raise HTTPException(422, detail="路径不合法") from error
    root = data_root.resolve_data_root().resolve()
    if folder == root or folder in root.parents or root in folder.parents:
        raise HTTPException(422, detail="不能把工作目录、它的上级或里面的目录当团队库")


@team_library_router.get("/profile")
def get_profile() -> dict:
    # 契约响应是 `{display_name: null}`，UserProfile 的必填 display_name 表达不了，这里直接回 dict。
    profile = tl.read_profile()
    return {"display_name": profile.display_name if profile else None}


@team_library_router.put("/profile", response_model=UserProfile)
def put_profile(payload: UserProfile) -> UserProfile:
    try:
        return tl.write_profile(payload.display_name)
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@team_library_router.get("/team-libraries", response_model=list[TeamLibraryView])
def get_team_libraries(project_id: str = Query(...)) -> list[TeamLibraryView]:
    return [_view(mount) for mount in _mounts(project_id)]


@team_library_router.post("/team-libraries", response_model=TeamLibraryView, status_code=201)
def post_team_library(payload: TeamLibraryMountRequest) -> TeamLibraryView:
    profile = tl.read_profile()
    if profile is None:
        raise HTTPException(409, detail={"code": "profile_required", "message": "先设置显示名"})
    _reject_reserved_mount_path(payload.path)
    try:
        mount = tl.mount_library(
            project_id=payload.project_id,
            path=payload.path,
            name=payload.name,
            created_by=profile.display_name,
        )
    except FileNotFoundError:
        raise HTTPException(422, detail="目录不存在") from None
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    idx.scan_library(mount)
    from viewer_server.watcher import sync_team_library_watch

    sync_team_library_watch(mount.library_id)
    return _view(mount)


@team_library_router.delete("/team-libraries/{library_id}", status_code=204)
def delete_team_library(library_id: str, project_id: str = Query(...)) -> Response:
    try:
        tl.unmount_library(library_id, project_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这个团队库") from None
    except ValueError as error:
        raise HTTPException(500, detail=str(error)) from error
    from viewer_server.watcher import sync_team_library_watch

    sync_team_library_watch(library_id)
    return Response(status_code=204)


@team_library_router.post("/team-libraries/{library_id}/rescan", response_model=TeamLibraryView)
def post_rescan(library_id: str) -> TeamLibraryView:
    mount = _mount_or_404(library_id)
    if not tl.library_reachable(mount):
        raise HTTPException(503, detail=_UNREACHABLE)
    idx.scan_library(mount)
    # 启动时不可达的库没 schedule 上：恢复后画师点重扫，顺手把监听补上。
    from viewer_server.watcher import sync_team_library_watch

    sync_team_library_watch(library_id)
    return _view(mount)


@team_library_router.get(
    "/team-libraries/{library_id}/assets", response_model=TeamLibraryAssetPage
)
def get_team_assets(
    library_id: str,
    kind: str | None = None,
    author: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    cursor: str | None = None,
    limit: int = Query(default=200),
) -> TeamLibraryAssetPage:
    mount = _mount_or_404(library_id)
    index = _index_or_503(mount)
    # limit 是夹紧不是拒绝：翻页参数越界是客户端小毛病，不值得让整页资产打不开。
    try:
        return idx.query_index(
            index, kind=kind, author=author, tag=tag, q=q, cursor=cursor,
            limit=max(1, min(limit, 200)),
        )
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error


@team_library_router.get("/team-libraries/{library_id}/assets/{entry_id}/content")
def get_team_asset_content(library_id: str, entry_id: str) -> FileResponse:
    mount = _mount_or_404(library_id)
    index = _index_or_503(mount)
    try:
        entry = idx.get_entry(index, entry_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这条团队资产") from None
    # 提示词没有文件本体：直接判定，不靠底层抛异常。
    if entry.kind == "prompt":
        raise HTTPException(404, detail="提示词没有文件本体")
    try:
        path = idx.entry_content_path(mount, entry)
    except (FileNotFoundError, OSError):
        raise HTTPException(404, detail="找不到这条团队资产的文件") from None
    return FileResponse(path, media_type=entry.mime_type or "application/octet-stream")


@team_library_router.get("/team-libraries/{library_id}/assets/{entry_id}/thumb")
def get_team_asset_thumb(
    library_id: str, entry_id: str, w: int = Query(default=256, ge=32, le=1024)
) -> Response:
    mount = _mount_or_404(library_id)
    index = _index_or_503(mount)
    try:
        entry = idx.get_entry(index, entry_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这条团队资产") from None
    data = idx.thumbnail_bytes(mount, entry, w)
    if data is None:
        raise HTTPException(404, detail="没有缩略图")
    return Response(
        content=data,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=300"},
    )


@team_library_router.post(
    "/team-libraries/{library_id}/assets/{entry_id}/adopt",
    response_model=TeamAssetAdoptResponse,
)
def post_team_asset_adopt(
    library_id: str, entry_id: str, payload: TeamAssetAdoptRequest
) -> TeamAssetAdoptResponse:
    mount = _mount_or_404(library_id)
    index = _index_or_503(mount)
    try:
        entry = idx.get_entry(index, entry_id)
    except KeyError:
        raise HTTPException(404, detail="找不到这条团队资产") from None
    try:
        asset, created = adopt_team_asset(mount=mount, entry=entry, project_id=payload.project_id)
    except FileNotFoundError:
        raise HTTPException(404, detail="找不到这条团队资产的文件") from None
    # 库里 asset.json 坏掉走 ValidationError（它不是 ValueError 的子类），一样只是「现在不能采用」。
    except (TeamAssetAdoptError, ValidationError) as error:
        raise HTTPException(
            409, detail={"code": "not_adoptable", "message": str(error)}
        ) from error
    except ValueError as error:
        raise HTTPException(422, detail=str(error)) from error
    return TeamAssetAdoptResponse(asset=asset, created=created)
