"""供应商自定义图标的读写接口（I1）。

挂在主应用 `/api/` 下，由本地会话中间件鉴权；网关应用不挂这个 router。
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from character_workflow.lib import provider_icons

provider_icon_router = APIRouter(prefix="/api")


@provider_icon_router.get("/provider-icons/{sha}")
def get_provider_icon(sha: str) -> FileResponse:
    """只读 `.config/provider-icons/<sha>.png`；sha 不合规或文件不在都是 404，界面退回首字母。"""
    path = provider_icons.file_path(sha)
    if path is None:
        raise HTTPException(404, "图标不存在")
    # 文件名就是内容的 sha256，内容不会变，可以长期缓存。
    return FileResponse(path, media_type="image/png", headers={
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
    })


@provider_icon_router.post("/provider-icons")
def upload_provider_icon(file: UploadFile = File(...)) -> dict:
    """校验、重新编码并落盘，只返回 `{icon: "file:<sha>"}`；不改 KEY，由表单保存时一并写入。

    文件名与 Content-Type 一概不看，只认文件头。同步路由：解码在线程池里跑，不占事件循环。"""
    raw = file.file.read(provider_icons.MAX_BYTES + 1)
    if len(raw) > provider_icons.MAX_BYTES:
        raise HTTPException(413, "图片超过 1 MB")
    try:
        return {"icon": provider_icons.store(raw)}
    except provider_icons.IconRejected as error:
        raise HTTPException(422, str(error)) from None
