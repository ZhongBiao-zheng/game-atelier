"""Submit borrowed-provider jobs through the host's normal canvas queue."""
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.canvas_runs import (
    CanvasRunCommandError, submit_canvas_run, submit_image_edit_run, submit_layer_decomposition_run,
)
from character_workflow.lib.jobs import new_job_id, read_job
from character_workflow.lib.collab_borrow import BorrowedGeneration, borrowable_models, resolve_channel
from character_workflow.lib.schemas import PublicGenerationParams
from viewer_server.collab_access import require_guest, share_entry
from viewer_server.collab_proxy import remote_json
from viewer_server.collab_submissions import RequestId, submission

lan_router = APIRouter(prefix="/collab/v1/projects/{project_id}")
local_router = APIRouter(prefix="/api/collab/remote/{peer_key}/projects/{project_id}")


class BorrowSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: RequestId
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)
    channel_id: str = Field(pattern="^[a-f0-9]{32}$")
    model: str = Field(min_length=1, max_length=200)
    prompt: str | None = Field(default=None, max_length=40000)
    params: PublicGenerationParams | None = None


def _authorize(request, project_id):
    guest = require_guest(request, project_id, edit=True)
    if not share_entry(project_id).allow_borrow_provider:
        raise HTTPException(403, "房主未开放供应商")
    return guest


@lan_router.get("/borrowable-models")
def models(request: Request, project_id: str):
    _authorize(request, project_id)
    rows = borrowable_models()
    _authorize(request, project_id)
    return {"models": rows}


@lan_router.post("/runs/borrowed", status_code=202)
def borrowed_run(project_id: str, request: Request, body: BorrowSubmission, background: BackgroundTasks):
    from viewer_server.routes import _run_canvas_job_safely
    guest = _authorize(request, project_id)
    with submission(("borrowed", project_id, guest.client_id), body) as entry:
        if "receipt" in entry.state:
            return entry.state["receipt"]
        # Reading the document also finishes interrupted canvas transactions before job lookup.
        doc = read_canvas_document(project_id)
        job = None
        if entry.state:
            job_id = entry.state["job_id"]
            try:
                job = read_job(job_id)
            except FileNotFoundError:
                pass
        else:
            job_id = new_job_id()
        if job is None:
            if not entry.state:
                entry.save(job_id=job_id)
            try:
                job = _submit_borrowed(project_id, request, body, guest, doc, job_id)
            except HTTPException as error:
                if 400 <= error.status_code < 500:
                    entry.path.unlink(missing_ok=True)
                raise
        status = {"done": "done", "partial": "done", "failed": "failed", "canceled": "interrupted"}
        receipt = {"collab_run_id": job.canvas_run.run_id, "node_id": job.canvas_run.result_node_id,
                   "status": status.get(job.status.value, "pending")}
        entry.save(receipt=receipt)
        if job.status == "pending":
            background.add_task(_run_canvas_job_safely, job.job_id)
        return receipt


def _submit_borrowed(project_id, request, body, guest, doc, job_id):
    try:
        key, _model = resolve_channel(body.channel_id, body.model)
        selection = BorrowedGeneration(channel=body.channel_id, model=body.model, prompt=body.prompt,
                                      params=body.params, guest_name=guest.display_name, client_id=guest.client_id,
                                      authorize=lambda: _authorize(request, project_id), job_id=job_id)
        node = next((node for node in doc.nodes if node.id == body.surface_node_id), None)
        if node is None:
            raise HTTPException(404, "生成节点不存在")
        if node.type == "layer_stack":
            job, _doc = submit_layer_decomposition_run(project_id, node.id, body.expected_revision,
                                                        key.alias, body.model, borrow=selection)
        elif node.type == "image_edit":
            job, _doc = submit_image_edit_run(project_id, node.id, body.expected_revision,
                                              body.requested_count, borrow=selection)
        else:
            job, _doc = submit_canvas_run(project_id, node.id, body.expected_revision,
                                          body.requested_count, borrow=selection)
    except CanvasRunCommandError as error:
        raise HTTPException(422, detail={"code": error.code, "message": error.message}) from error
    except (KeyError, ValueError):
        raise HTTPException(422, "模型或生成参数不可用，请检查共享画布的输入") from None
    except RuntimeError as error:
        if str(error).startswith("revision_conflict:"):
            raise HTTPException(409, "画布已更新，请重试") from None
        raise
    return job


@local_router.get("/borrowable-models")
def remote_models(project_id: str, peer_key: str, request: Request):
    return remote_json(request, peer_key, project_id, "borrowable-models")


@local_router.post("/runs/borrowed", status_code=202)
def remote_borrowed_run(project_id: str, peer_key: str, request: Request, body: BorrowSubmission):
    return remote_json(request, peer_key, project_id, "runs/borrowed", method="POST", json=body.model_dump())
