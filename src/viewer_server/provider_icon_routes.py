"""供应商自定义图标的读写接口（I1）。

挂在主应用 `/api/` 下，由本地会话中间件鉴权；网关应用不挂这个 router。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
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
