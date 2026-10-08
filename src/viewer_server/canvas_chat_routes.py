"""画布内置 Agent 的对话入口：发消息、裁决待确认操作、停止、改会话设置、列对话模型。

会话的增删查沿用 routes.py 里的 /agent/sessions 端点。一轮对话在服务端事件循环里作为任务运行，
进度经 SSE `canvas-agent` 事件推给页面（kind=delta 是流式文字，kind=session 表示会话已落盘）。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, FastAPI, File, Form, Response, UploadFile

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib.canvas_agent_models import list_chat_models
from character_workflow.lib.canvas_agent_sessions import (
    mutate_canvas_agent_session, read_canvas_agent_session,
)
from character_workflow.lib.schemas import (
    CanvasAgentApprovalsSubmit, CanvasAgentSession, CanvasAgentSessionUpdate,
    CanvasAgentTurnCreate,
)
from character_workflow.lib.workshop import WorkshopError
from viewer_server.sse import hub

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/canvas")
SESSION = "/projects/{project_id}/agent/sessions/{session_id}"

_tasks: dict[tuple[str, str], asyncio.Task] = {}


def is_running(project_id: str, session_id: str) -> bool:
    task = _tasks.get((project_id, session_id))
    return task is not None and not task.done()


def recover_if_stale(session: CanvasAgentSession) -> CanvasAgentSession:
    """running 但本进程没有对应任务 = 上次服务在这一轮中途退出；改成 interrupted 才能继续对话。"""
    if session.status == "running" and not is_running(session.project_id, session.session_id):
        return runtime.mark_interrupted(session.project_id, session.session_id)
    return session


def cancel(project_id: str, session_id: str) -> None:
    task = _tasks.get((project_id, session_id))
    if task is not None and not task.done():
        task.cancel()


def _schedule(project_id: str, session_id: str) -> None:
    async def turn() -> None:
        try:
            await runtime.run_turn(project_id, session_id, hub.broadcast)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 — 会话文件被删等；模型侧失败 run_turn 已落盘
            logger.warning("canvas agent task crashed: %s/%s", project_id, session_id,
                           exc_info=True)
        finally:
            _tasks.pop((project_id, session_id), None)

    _tasks[(project_id, session_id)] = asyncio.get_running_loop().create_task(turn())


async def _call(function, *args):
    try:
        return await asyncio.to_thread(function, *args)
    except KeyError:
        raise WorkshopError("INVALID_TARGET", "找不到这个画布项目或 Agent 会话", 404) from None


@router.get("/agent/models")
async def get_chat_models() -> dict:
    return await asyncio.to_thread(list_chat_models)


@router.patch(SESSION, response_model=CanvasAgentSession)
async def patch_session(project_id: str, session_id: str,
                        payload: CanvasAgentSessionUpdate) -> CanvasAgentSession:
    fields = payload.model_dump(exclude_none=True)
    if fields.get("effort") == "off":
        fields["effort"] = None

    def update(current: CanvasAgentSession, _now: str) -> dict:
        if current.status == "running":
            raise WorkshopError("SESSION_BUSY", "这一轮结束后才能修改设置", 409)
        return fields

    return await _call(mutate_canvas_agent_session, project_id, session_id, update)


@router.post(f"{SESSION}/messages", response_model=CanvasAgentSession, status_code=202)
async def post_message(project_id: str, session_id: str,
                       payload: CanvasAgentTurnCreate) -> CanvasAgentSession:
    if is_running(project_id, session_id):
        raise WorkshopError("SESSION_BUSY", "上一轮还没结束", 409)
    await _call(recover_if_stale, await _call(read_canvas_agent_session, project_id, session_id))
    session = await _call(runtime.begin_user_turn, project_id, session_id, payload.text,
                          payload.node_ids, payload.skill)
    _schedule(project_id, session_id)
    return session


@router.post(f"{SESSION}/approvals", response_model=CanvasAgentSession, status_code=202)
async def post_approvals(project_id: str, session_id: str,
                         payload: CanvasAgentApprovalsSubmit) -> CanvasAgentSession:
    if is_running(project_id, session_id):
        raise WorkshopError("SESSION_BUSY", "上一轮还没结束", 409)
    decisions = {decision.call_id: decision.approve for decision in payload.decisions}
    session = await _call(runtime.resolve_approvals, project_id, session_id, decisions)
    _schedule(project_id, session_id)
    return session


def _reject_pending(current: CanvasAgentSession, _now: str) -> dict:
    """停止 = 拒绝全部待确认操作，并且不再续跑。"""
    outputs = [{"type": "function_call_output", "call_id": approval.call_id,
                "output": "用户停止了这一轮，操作未执行。"}
               for approval in current.pending_approvals]
    return {"history": [*current.history, *outputs], "pending_approvals": [],
            "status": "interrupted"}


@router.post(f"{SESSION}/cancel", response_model=CanvasAgentSession)
async def post_cancel(project_id: str, session_id: str) -> CanvasAgentSession:
    task = _tasks.get((project_id, session_id))
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    session = await _call(read_canvas_agent_session, project_id, session_id)
    if session.status == "awaiting_approval":
        session = await _call(mutate_canvas_agent_session, project_id, session_id,
                              _reject_pending)
        runtime.notify_session(hub.broadcast, project_id, session_id)
    return await _call(recover_if_stale, session)


@router.get("/agent/skills")
async def get_skills() -> dict:
    rows = await asyncio.to_thread(skills.list_skills)
    return {"skills": [row.as_dict() for row in rows]}


async def _read_upload(upload: UploadFile, budget: int) -> bytes:
    data = await upload.read(budget + 1)
    if len(data) > budget:
        raise WorkshopError("CONTENT_TOO_LARGE", skills.TOO_LARGE, 413)
    return data


@router.post("/agent/skills/import")
async def import_skill(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(default=[]),
    replace: bool = Form(default=False),
) -> dict:
    """zip（单个 .zip 文件）、文件夹（paths 与 files 一一对应的相对路径）或单个 SKILL.md。"""
    if len(files) > skills.MAX_FILES:
        raise WorkshopError("CONTENT_TOO_LARGE", skills.TOO_LARGE, 413)
    if len(files) == 1 and (files[0].filename or "").lower().endswith(".zip"):
        payload = await _read_upload(files[0], skills.MAX_TOTAL_BYTES)
        contents = await asyncio.to_thread(skills.files_from_zip, payload)
    else:
        if paths and len(paths) != len(files):
            raise WorkshopError("INVALID_PARAMETERS", "文件与路径数量不一致", 422)
        contents, budget = {}, skills.MAX_TOTAL_BYTES
        for index, upload in enumerate(files):
            data = await _read_upload(upload, budget)
            budget -= len(data)
            contents[paths[index] if paths else (upload.filename or "SKILL.md")] = data
    info = await asyncio.to_thread(lambda: skills.install_skill(contents, replace=replace))
    return info.as_dict()


@router.delete("/agent/skills/{name}", status_code=204)
async def remove_skill(name: str) -> Response:
    await asyncio.to_thread(skills.delete_skill, name)
    return Response(status_code=204)


def register_canvas_chat_routes(app: FastAPI) -> None:
    app.include_router(router)
