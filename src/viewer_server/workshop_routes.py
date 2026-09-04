"""Authenticated typed Workshop endpoints; approval dispatches the existing Job Runner."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Callable
from uuid import uuid4

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse

from character_workflow.lib import workshop, workshop_generation as generation
from character_workflow.lib.workshop_schema import (
    AcknowledgeFeedbackInput, ApproveGenerationInput, CreateTargetInput, GetGenerationInput,
    AppendLessonInput, ApproveRequestInput, ListMediaInput, ListProjectsInput,
    ListPromptAssetsInput, ListTargetsInput, PrepareGenerationInput, ReadDocumentInput,
    ReadMediaInput, ReadPromptAssetInput, TargetInput,
    WithdrawGenerationInput, WriteDocumentInput,
)
from viewer_server.sse import hub


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/workshop")


class WorkshopRuntime:
    def __init__(self, grant_is_active: Callable[[str, str, str], bool]):
        self.grant_is_active = grant_is_active
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="workshop")
        self.queued: set[str] = set()
        self.lock = Lock()
        self.closed = False

    def schedule(self, job_id: str) -> None:
        with self.lock:
            if self.closed or job_id in self.queued:
                return
            if len(self.queued) >= 32:
                raise workshop.WorkshopError("QUEUE_FULL", "执行队列已满；请求已保存，可稍后重新确认")
            self.queued.add(job_id)
            self.executor.submit(self._run, job_id)

    def _run(self, job_id: str) -> None:
        from character_workflow.lib.job_runner import JobExecutionBusy, JobRunnerError, run_job
        try:
            run_job(job_id, workshop_grant_is_active=self.grant_is_active)
        except (JobExecutionBusy, JobRunnerError, workshop.WorkshopError):
            logger.info("Workshop execution stopped for %s", job_id)
        except Exception:
            logger.exception("Workshop execution failed for %s", job_id)
        finally:
            with self.lock:
                self.queued.discard(job_id)

    def recover(self) -> None:
        for job_id in generation.recover_requests(self.grant_is_active):
            self.schedule(job_id)

    def close(self) -> None:
        with self.lock:
            self.closed = True
        self.executor.shutdown(wait=False, cancel_futures=True)


def principal(request: Request):
    return getattr(request.state, "connection_principal", None)


@router.post("/list-projects")
def list_projects(request: Request, payload: ListProjectsInput):
    return workshop.list_projects(principal(request), payload)


@router.post("/get-context")
def get_context(request: Request, payload: TargetInput):
    return workshop.get_context(principal(request), payload)


@router.post("/list-targets")
def list_targets(request: Request, payload: ListTargetsInput):
    return workshop.list_targets(principal(request), payload)


@router.post("/list-models")
def list_models(request: Request, payload: TargetInput):
    return generation.list_models(principal(request), payload)


@router.post("/create-target")
def create_target(request: Request, payload: CreateTargetInput):
    return workshop.create_target(principal(request), payload)


@router.post("/read-document")
def read_document(request: Request, payload: ReadDocumentInput):
    return workshop.read_document(principal(request), payload)


@router.post("/write-document")
def write_document(request: Request, payload: WriteDocumentInput):
    return workshop.write_document(principal(request), payload)


@router.post("/acknowledge-feedback")
def acknowledge_feedback(request: Request, payload: AcknowledgeFeedbackInput):
    return workshop.acknowledge_feedback(principal(request), payload)


@router.post("/list-media")
def list_media(request: Request, payload: ListMediaInput):
    return workshop.list_media(principal(request), payload)


@router.post("/read-media")
def read_media(request: Request, payload: ReadMediaInput):
    return workshop.read_media(principal(request), payload)


@router.post("/prepare-generation")
def prepare_generation(request: Request, payload: PrepareGenerationInput):
    result = generation.prepare_generation(principal(request), payload)
    hub.broadcast("workshop-request-changed", {"request_id": result["request_id"]})
    return result


@router.post("/get-generation")
def get_generation(request: Request, payload: GetGenerationInput):
    return generation.get_generation(principal(request), payload)


@router.post("/withdraw-generation")
def withdraw_generation(request: Request, payload: WithdrawGenerationInput):
    result = generation.withdraw_generation(principal(request), payload)
    hub.broadcast("workshop-request-changed", {"request_id": result["request_id"]})
    return result


@router.post("/read-lessons")
def read_lessons(request: Request, payload: TargetInput):
    return workshop.read_lessons(principal(request), payload)


@router.post("/list-prompt-assets")
def list_prompt_assets(request: Request, payload: ListPromptAssetsInput):
    return workshop.list_prompt_assets(principal(request), payload)


@router.post("/read-prompt-asset")
def read_prompt_asset(request: Request, payload: ReadPromptAssetInput):
    return workshop.read_prompt_asset(principal(request), payload)


@router.post("/append-lesson")
def append_lesson(request: Request, payload: AppendLessonInput):
    return workshop.append_lesson(principal(request), payload)


def _approve(request: Request, request_id: str, expected_revision: int) -> dict:
    runtime = request.app.state.workshop_runtime
    result = generation.approve_generation(principal(request), request_id,
                                           expected_revision, runtime.grant_is_active)
    hub.broadcast("workshop-request-changed", {"request_id": result["request_id"]})
    if result["job"] is None or result["job"]["status"] == "pending":
        runtime.schedule(result["job_id"])
    return result


@router.post("/approve-generation")
def approve_generation_tool(request: Request, payload: ApproveRequestInput):
    return _approve(request, payload.request_id, payload.expected_revision)


@router.get("/requests")
def list_requests(request: Request, page: int = Query(1, ge=1, le=10000),
                  page_size: int = Query(20, ge=1, le=100)):
    return generation.list_requests(principal(request), page, page_size)


@router.post("/requests/{request_id}/approve")
def approve_generation(request_id: str, request: Request, payload: ApproveGenerationInput):
    return _approve(request, request_id, payload.expected_revision)


@router.get("/requests/{request_id}")
def get_request(request_id: str, request: Request):
    if workshop.actor_id(principal(request)) != "local":
        raise workshop.WorkshopError("CAPABILITY_DENIED", "此页面仅供本地用户查看", 403)
    return generation.get_generation(principal(request), GetGenerationInput(request_id=request_id))


@router.get("/requests/{request_id}/references/{media_id}")
def get_reference(request_id: str, media_id: str, request: Request):
    path, mime_type = generation.frozen_reference(principal(request), request_id, media_id)
    inline = mime_type in {"image/png", "image/jpeg", "image/webp", "image/gif"}
    return FileResponse(path, media_type=mime_type, filename=None if inline else path.name,
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def register_workshop_routes(app: FastAPI,
                            grant_is_active: Callable[[str, str, str], bool]) -> WorkshopRuntime:
    runtime = WorkshopRuntime(grant_is_active)
    app.state.workshop_runtime = runtime
    app.include_router(router)

    async def handle_error(_request: Request, error: workshop.WorkshopError):
        return JSONResponse({"error": {"code": error.code, "message": error.message,
                                       "request_id": str(uuid4())}}, status_code=error.status)

    app.add_exception_handler(workshop.WorkshopError, handle_error)
    return runtime
