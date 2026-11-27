"""Local canvas group execution endpoints."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from character_workflow.lib import canvas_group_runs as runs

from character_workflow.lib.canvas_group_plan import group_plan, quote_id

router = APIRouter(prefix="/api/canvas/projects/{project_id}")


@router.post("/groups/{group_id}/run-plan")
def plan(project_id: str, group_id: str):
    try:
        result = group_plan(project_id, group_id)
        return {**result, "quote_id": quote_id(project_id, group_id, result)}
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "找不到这个画布项目或分组") from None



class ConfirmedPlan(BaseModel):
    order: list[str] = Field(max_length=10_000)
    quote_id: str
    total_cny: float = Field(ge=0, allow_inf_nan=False)


def _command(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "找不到这个分组或执行记录") from None
    except RuntimeError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/groups/{group_id}/group-runs", status_code=201)
def start(project_id: str, group_id: str, body: ConfirmedPlan):
    return _command(runs.start, project_id, group_id, body.order, body.total_cny,
                    confirmed_quote=body.quote_id)


@router.get("/group-runs")
def listing(project_id: str):
    return _command(runs.list_runs, project_id)


@router.post("/group-runs/{run_id}/resume")
def resume(project_id: str, run_id: str):
    return _command(runs.resume, project_id, run_id)


@router.post("/group-runs/{run_id}/cancel")
def cancel(project_id: str, run_id: str):
    return _command(runs.cancel, project_id, run_id)
