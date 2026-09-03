"""Authenticated typed canvas tool endpoints; a run schedules the same canvas job worker as the Web."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, FastAPI, Request

from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasListModelsInput, CanvasListProjectsInput, CanvasProjectInput,
    CanvasReadMediaInput, GetRunInput, ImportMediaInput, RunInput,
)

router = APIRouter(prefix="/api/canvas-agent")


def principal(request: Request):
    return getattr(request.state, "connection_principal", None)


@router.post("/list-projects")
def list_projects(request: Request, payload: CanvasListProjectsInput):
    return tools.list_projects(principal(request), payload)


@router.post("/get-document")
def get_document(request: Request, payload: CanvasProjectInput):
    return tools.get_document(principal(request), payload)


@router.post("/list-models")
def list_models(request: Request, payload: CanvasListModelsInput):
    return tools.list_models(principal(request), payload)


@router.post("/apply-changes")
def apply_changes(request: Request, payload: ApplyChangesInput):
    return tools.apply_changes(principal(request), payload)


@router.post("/import-media")
def import_media(request: Request, payload: ImportMediaInput):
    return tools.import_media(principal(request), payload)


@router.post("/run")
def run(request: Request, payload: RunInput, background: BackgroundTasks):
    from viewer_server import routes as web_routes
    result, job = tools.run(principal(request), payload)
    background.add_task(web_routes._run_canvas_job_safely, job.job_id)
    return result


@router.post("/get-run")
def get_run(request: Request, payload: GetRunInput):
    return tools.get_run(principal(request), payload)


@router.post("/read-media")
def read_media(request: Request, payload: CanvasReadMediaInput):
    return tools.read_media(principal(request), payload)


def register_canvas_agent_routes(app: FastAPI) -> None:
    app.include_router(router)
