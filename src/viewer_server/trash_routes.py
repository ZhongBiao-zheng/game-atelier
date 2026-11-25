"""回收站接口（只给本机页面）：列出、还原、彻底删除、清空。移入由各功能的删除接口调 `lib/trash.py`。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from character_workflow.lib import trash

router = APIRouter(prefix="/api/trash")


def _view(entry: trash.TrashEntry) -> dict[str, Any]:
    return {
        "trash_id": entry.trash_id,
        "kind": entry.kind,
        "label": entry.label,
        "deleted_at": entry.deleted_at,
        "expires_at": entry.expires_at().isoformat(),
        "days_left": entry.days_left(),
        "meta": entry.meta,
    }


def _not_found() -> HTTPException:
    return HTTPException(404, {"code": "TRASH_NOT_FOUND", "message": "回收站里没有这一项，可能已还原或已删除"})


@router.get("")
def listing() -> dict[str, Any]:
    return {"items": [_view(entry) for entry in trash.list_trash()]}


@router.post("/{trash_id}/restore")
def restore(trash_id: str) -> dict[str, Any]:
    try:
        return _view(trash.restore(trash_id))
    except trash.TrashNotFound as error:
        raise _not_found() from error
    except trash.TrashConflict as error:
        raise HTTPException(409, {"code": "TRASH_CONFLICT", "message": str(error)}) from error
    except trash.TrashError as error:
        raise HTTPException(422, {"code": "TRASH_INVALID", "message": str(error)}) from error


@router.delete("/{trash_id}")
def purge(trash_id: str) -> dict[str, bool]:
    try:
        trash.purge(trash_id)
    except trash.TrashNotFound as error:
        raise _not_found() from error
    return {"ok": True}


@router.delete("")
def purge_all() -> dict[str, int]:
    return {"purged": trash.purge_all()}
