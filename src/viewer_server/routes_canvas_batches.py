"""The only HTTP entry points that approve and schedule a Canvas batch."""
from contextlib import contextmanager
from typing import Iterator

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import ValidationError

from character_workflow.lib.canvas_batches import (
    CanvasBatchCreate,
    CanvasBatchRun,
    cancel_canvas_batch,
    list_canvas_batches,
    prepare_canvas_batch,
    read_canvas_batch,
    run_canvas_batch,
    start_canvas_batch,
)
from character_workflow.lib.canvas_runs import CanvasRunCommandError
from character_workflow.lib.canvas_projects import CanvasStorageError

router = APIRouter(prefix="/api/canvas/projects/{project_id}/batch-runs")


@contextmanager
def _command_errors() -> Iterator[None]:
    try:
        yield
    except KeyError as error:
        raise HTTPException(404, detail={"code": "canvas_batch_missing",
            "message": "找不到画布项目、节点或批量记录"}) from error
    except (FileNotFoundError, CanvasStorageError, ValidationError) as error:
        raise HTTPException(500, detail={"code": "canvas_batch_storage_error",
            "message": "批量执行存档缺失或不符合契约，请检查服务记录；未自动重试生成"}) from error
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={"code": error.code, "message": error.message}) from error
    except ValueError as error:
        raise HTTPException(422, detail={"code": "canvas_batch_invalid", "message": str(error)}) from error
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise HTTPException(409, detail={"code": "revision_conflict",
                "message": "画布已改变，请重新确认批量执行",
                "current_revision": int(str(error).split(":", 1)[1])}) from error
        raise HTTPException(409, detail={"code": "canvas_batch_conflict", "message": str(error)}) from error


@router.get("", response_model=list[CanvasBatchRun])
def get_batches(project_id: str) -> list[CanvasBatchRun]:
    with _command_errors():
        return list_canvas_batches(project_id)


@router.post("/prepare", response_model=CanvasBatchRun, status_code=201)
def prepare_batch(project_id: str, payload: CanvasBatchCreate) -> CanvasBatchRun:
    with _command_errors():
        return prepare_canvas_batch(project_id, payload)


@router.get("/{batch_id}", response_model=CanvasBatchRun)
def get_batch(project_id: str, batch_id: str) -> CanvasBatchRun:
    with _command_errors():
        return read_canvas_batch(project_id, batch_id)


@router.post("/{batch_id}/start", response_model=CanvasBatchRun)
def start_batch(project_id: str, batch_id: str, background: BackgroundTasks) -> CanvasBatchRun:
    with _command_errors():
        run, should_schedule = start_canvas_batch(project_id, batch_id)
    if should_schedule:
        background.add_task(run_canvas_batch, project_id, batch_id)
    return run


@router.post("/{batch_id}/cancel", response_model=CanvasBatchRun)
def cancel_batch(project_id: str, batch_id: str) -> CanvasBatchRun:
    with _command_errors():
        return cancel_canvas_batch(project_id, batch_id)
