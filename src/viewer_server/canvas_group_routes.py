"""Local canvas group execution endpoints."""
from fastapi import APIRouter, HTTPException

from character_workflow.lib.canvas_group_plan import group_plan

router = APIRouter(prefix="/api/canvas/projects/{project_id}")


@router.post("/groups/{group_id}/run-plan")
def plan(project_id: str, group_id: str):
    try:
        return group_plan(project_id, group_id)
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "找不到这个画布项目或分组") from None

