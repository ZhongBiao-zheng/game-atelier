"""供应商自定义图标的读写接口（I1）。

挂在主应用 `/api/` 下，由本地会话中间件鉴权；网关应用不挂这个 router。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

# provider_icons 带着 Pillow：一律在函数内导入，服务启动时不加载（test_server_startup_imports）。
logger = logging.getLogger(__name__)
provider_icon_router = APIRouter(prefix="/api")
MAX_URL_LENGTH = 2048


@provider_icon_router.get("/provider-icons/{sha}")
def get_provider_icon(sha: str) -> FileResponse:
    """只读 `.config/provider-icons/<sha>.png`；sha 不合规或文件不在都是 404，界面退回首字母。"""
    from character_workflow.lib import provider_icons

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
    from character_workflow.lib import provider_icons

    raw = file.file.read(provider_icons.MAX_BYTES + 1)
    if len(raw) > provider_icons.MAX_BYTES:
        raise HTTPException(413, provider_icons.TOO_LARGE)
    try:
        return {"icon": provider_icons.store(raw)}
    except provider_icons.IconRejected as error:
        raise HTTPException(422, str(error)) from None
    except Exception as error:  # noqa: BLE001 —— 弹层只显示约定的一句原因，不能露出英文的 500
        logger.exception("上传供应商图标意外失败（%s）", type(error).__name__)
        raise HTTPException(422, provider_icons.UNREADABLE) from None


class _FetchPayload(BaseModel):
    model_config = {"extra": "forbid"}
    url: str


@provider_icon_router.post("/provider-icons/fetch")
def fetch_provider_icon(payload: _FetchPayload) -> dict:
    """按网址取站点图标（走 outbound_guard，只连公网、重定向逐跳重查）；同样只返回引用、不改 KEY。"""
    from character_workflow.lib import provider_icon_fetch

    url = payload.url.strip()
    if not url:
        raise HTTPException(422, provider_icon_fetch.NOT_FOUND)
    if len(url) > MAX_URL_LENGTH:
        raise HTTPException(422, "网址过长")
    try:
        return {"icon": provider_icon_fetch.fetch_site_icon(url)}
    except provider_icon_fetch.IconNotFound as error:
        raise HTTPException(422, str(error)) from None
    except Exception as error:  # noqa: BLE001 —— 弹层只显示约定的一句原因，不能露出英文的 500
        logger.exception("按网址获取供应商图标意外失败（%s）", type(error).__name__)
        raise HTTPException(422, provider_icon_fetch.CONNECT_FAILED) from None
