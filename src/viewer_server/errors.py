"""跨路由模块共用的 HTTP 错误映射。"""
from __future__ import annotations

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def asset_state_broken_error(error: Exception) -> HTTPException:
    """CreationAssetStateError（本机资产库数据损坏 / blob 缺失）的唯一 HTTP 映射：500 asset_state_broken。

    判据是「谁能修」：服务端数据坏了，刷新重试永远不会成功，所以不是 409（前端 409 = 刷新后重试）。
    创作资产、画布插入 / 复刻、团队库采用 / 重新采用 / 分享 / 过时检查都走这里，别在路由里各写一份。
    带 exc_info：底层常是 ValidationError，日志里要看得出是哪条记录坏了。
    """
    logger.warning("creation asset state broken: %s", error, exc_info=error)
    return HTTPException(500, detail={"code": "asset_state_broken", "message": str(error)})
