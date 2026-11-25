"""仅本机创作台使用的 Agent 对话入口。"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import secrets
from datetime import datetime
from typing import Annotated
from weakref import WeakValueDictionary

from fastapi import APIRouter, File, Header, HTTPException, Response, UploadFile
from fastapi.concurrency import contextmanager_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib.agent_context import MEDIA_SCHEME
from character_workflow.lib import (
    agent_usage,
    canvas_agent_cost as cost,
    canvas_agent_runtime as runtime,
)
from character_workflow.lib import canvas_agent_skills as skills, studio_agent_sessions as sessions
from character_workflow.lib.atomic_io import atomic_write_bytes, read_text_with_retry
from character_workflow.lib.canvas_agent_sessions import with_appended_messages
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.creation_assets import asset_media_content, get_creation_asset
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.schemas import (
    CanvasAgentApprovalsSubmit,
    CanvasAgentMessageCreate,
    CanvasAgentPlan,
    CanvasAgentSessionId,
    CanvasAgentSessionUpdate,
    StudioAgentTurn,
)
from character_workflow.lib.studio_agent import (
    StudioWorkspace,
    estimate_rows,
    items_for,
    media_path,
)
from viewer_server.routes import _canvas_if_match, _read_media_upload, _start_studio_job_task
from viewer_server.sse import hub

router = APIRouter(prefix="/api/studio/agent")
T = "/sessions/{session_id}"
_tasks: dict[str, asyncio.Task] = {}
# 同一会话的认领/发送/删除在同一事件循环内串行，防止恢复检查误判正在启动的任务。

_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
logger = logging.getLogger(__name__)


def guard(sid):
    return _locks.setdefault(sid, asyncio.Lock())


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_message_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    text: str = Field(default="", max_length=40_000)
    skill: str | None = Field(default=None, max_length=64)
    attachment_ids: list[str] = Field(default_factory=list, max_length=16)
    asset_ids: list[str] = Field(default_factory=list, max_length=16)


def workspace(sid):
    loop = asyncio.get_running_loop()

    def schedule(job_id):
        return asyncio.run_coroutine_threadsafe(_start_studio_job_task(job_id), loop).result()

    return StudioWorkspace(sid, schedule, hub.broadcast)


def begin(sid, payload):
    started = False

    def update(session, now):
        nonlocal started
        if any(turn.client_message_id == payload.client_message_id for turn in session.turns):
            return {}
        if session.status in {"running", "awaiting_approval"}:
            raise CanvasToolError("SESSION_BUSY", "上一轮还没结束", 409)
        if not session.model or not session.model_alias:
            raise CanvasToolError("INVALID_PARAMETERS", "请先选择对话模型", 422)
        if not (payload.text.strip() or payload.attachment_ids or payload.asset_ids):
            raise CanvasToolError("INVALID_PARAMETERS", "请输入想法或添加参考", 422)
        text = runtime.redact(payload.text)
        content = [{"type": "input_text", "text": text}] if text else []
        for index, aid in enumerate(payload.attachment_ids, 1):
            if aid not in session.uploads:
                raise CanvasToolError("INVALID_TARGET", "附件不属于当前对话", 422)
            ref = "upload:" + aid
            content.extend(
                [
                    {"type": "input_text", "text": f"图{index} {ref}"},
                    {
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": MEDIA_SCHEME + ref,
                    },
                ]
            )
        counts = {"image": len(payload.attachment_ids), "video": 0, "audio": 0}
        for asset_id in payload.asset_ids:
            try:
                asset = get_creation_asset(asset_id)
            except (OSError, ValueError, KeyError):
                raise CanvasToolError("INVALID_TARGET", "找不到引用的本机资产", 422) from None
            ref = "asset:" + asset_id
            media = asset_media_content(asset)
            kind = media.mime_type.split("/")[0] if media else None
            label = ""
            if kind in counts:
                counts[kind] += 1
                label = {"image": "图", "video": "视频", "audio": "音频"}[kind] + str(counts[kind])
            content.append({"type": "input_text", "text": f"{label} {ref} {asset.title}".strip()})
            if media and media.mime_type.startswith("image/"):
                content.append(
                    {
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": MEDIA_SCHEME + ref,
                    }
                )
            elif asset.content.kind == "prompt":
                from character_workflow.lib.prompt_variables import build_prompt_variable_template

                content.append(
                    {
                        "type": "input_text",
                        "text": build_prompt_variable_template(asset.content.segments, {}),
                    }
                )
        if payload.skill:
            content.append({"type": "input_text", "text": skills.selected_skill_prompt(payload.skill)})
        tid = "turn-" + secrets.token_hex(12)
        msg = CanvasAgentMessageCreate(role="user", text=text, turn_id=tid, title=payload.skill)
        turn = StudioAgentTurn(
            turn_id=tid,
            client_message_id=payload.client_message_id,
            attachment_ids=payload.attachment_ids,
            asset_ids=payload.asset_ids,
        )
        title = (
            session.title
            if session.turns or session.title != "新对话"
            else (re.sub(r"\s+", " ", text).strip()[:40] or "参考素材")
        )
        started = True
        return {
            **with_appended_messages(session, [msg], now),
            "title": title,
            "status": "running",
            "error": None,
            "turns": [*session.turns, turn],
            "history": [*session.history, {"role": "user", "content": content}],
        }

    return sessions.mutate(sid, update), started


def interrupt(ws, reason):
    session = ws.read()
    if session.status in {"running", "awaiting_approval"}:

        def update(current, now):
            answered = runtime._answered_call_ids(current.history)
            dangling = [
                {
                    "type": "function_call_output",
                    "call_id": item["call_id"],
                    "output": runtime.INTERRUPTED_OUTPUT,
                }
                for item in current.history
                if item.get("type") == "function_call" and item.get("call_id") not in answered
            ]
            message = CanvasAgentMessageCreate(role="error", text=reason, turn_id=ws.active_turn)
            return {
                **with_appended_messages(current, [message], now),
                "status": "interrupted",
                "error": reason,
                "history": [*current.history, *dangling],
                "pending_approvals": [],
            }

        return ws.mutate(update)
    return session


async def recover_abandoned_turns():
    for row in await asyncio.to_thread(sessions.summaries):
        if row["status"] == "running":
            ws = workspace(row["session_id"])
            await asyncio.to_thread(interrupt, ws, "服务重启，这一轮已中断")


def launch(ws):
    async def run():
        try:
            await runtime.run_workspace_turn(ws, hub.broadcast)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, CanvasToolError) and error.code == "SESSION_DELETING":
                return  # DELETE 已认领会话，负责等本轮退出并清理文件。
            logger.exception("Studio Agent 回合中断")
            await asyncio.to_thread(interrupt, ws, f"这一轮已中断（{type(error).__name__}）")
        finally:
            if _tasks.get(ws.session_id) is asyncio.current_task():
                _tasks.pop(ws.session_id, None)
            hub.broadcast(ws.event, {**ws.address(), "kind": "session"})

    _tasks[ws.session_id] = asyncio.create_task(run())


@router.get("/sessions")
def list_sessions():
    return {"sessions": sessions.summaries()}


@router.post("/sessions", status_code=201)
def create_session(payload: CanvasAgentSessionUpdate):
    fields = payload.model_dump(exclude_unset=True)
    if fields.get("effort") == "off":
        fields["effort"] = None
    return sessions.public(sessions.create(fields))


@router.get(T)
async def get_session(session_id: CanvasAgentSessionId):
    async with guard(session_id):
        ws = workspace(session_id)
        # guard 阻止新任务启动，但已有任务可以在读盘期间进入待审批并退出。
        # 先记下任务归属，不能用读盘后的任务表判定较早的 running 快照已被遗弃。
        was_live = session_id in _tasks
        row = await asyncio.to_thread(ws.read)
        if row.status == "running" and not was_live:
            row = await asyncio.to_thread(interrupt, ws, "服务重启，这一轮已中断")
        return sessions.public(row)


@router.patch(T)
def patch_session(session_id: CanvasAgentSessionId, payload: CanvasAgentSessionUpdate):
    def update(current, now):
        if current.status in {"running", "awaiting_approval"}:
            raise CanvasToolError("SESSION_BUSY", "这一轮结束后才能修改设置", 409)
        fields = payload.model_dump(exclude_unset=True)
        if fields.get("effort") == "off":
            fields["effort"] = None
        return fields

    return sessions.public(sessions.mutate(session_id, update))


@router.post(T + "/messages", status_code=202)
async def send(session_id: CanvasAgentSessionId, payload: Message):
    async with guard(session_id):
        row, started = await asyncio.to_thread(begin, session_id, payload)
        if started:
            launch(workspace(session_id))
        return sessions.public(row)


@router.post(T + "/approvals", status_code=202)
async def approve(session_id: CanvasAgentSessionId, payload: CanvasAgentApprovalsSubmit):
    async with guard(session_id):
        ws = workspace(session_id)
        await asyncio.to_thread(ws.read)
        decisions = {item.call_id: item.approve for item in payload.decisions}
        indexes = {item.call_id: item.items for item in payload.decisions if item.items is not None}
        row = await asyncio.to_thread(runtime.resolve_workspace_approvals, ws, decisions, indexes)
        launch(ws)
        return sessions.public(row)


@router.get(T + "/approvals/{call_id}/items")
def batch(session_id: CanvasAgentSessionId, call_id: str):
    session = sessions.read(session_id)
    item = next(
        (
            a
            for a in session.pending_approvals
            if a.call_id == call_id and a.tool == "run_generations"
        ),
        None,
    )
    if not item:
        raise HTTPException(404, detail="没有这个待确认操作")
    return {
        "items": estimate_rows(items_for(item.tool, runtime._arguments(item.arguments)), session_id),
        **({"turn_estimate_cny": cost.TurnSpend(session.history).submitted}
           if session.permission_mode == "auto" else {}),
        "confirm_above_cny": cost.confirm_above_cny(),
    }


async def stop_task(sid):
    if task := _tasks.get(sid):
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@router.post(T + "/cancel")
async def cancel(session_id: CanvasAgentSessionId):
    async with guard(session_id):
        await stop_task(session_id)
        ws = workspace(session_id)
        row = await asyncio.to_thread(interrupt, ws, "已停止")
        hub.broadcast(ws.event, {**ws.address(), "kind": "session"})
        return sessions.public(row)


@router.delete(T, status_code=204)
async def delete(
    session_id: CanvasAgentSessionId,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
):
    if session_id == sessions.DEFAULT_SESSION_ID:
        raise HTTPException(400, detail="默认对话不能删除")
    revision = _canvas_if_match(if_match, "对话")
    async with guard(session_id):
        async with contextmanager_in_threadpool(sessions.delete(session_id, revision)):
            await stop_task(session_id)
        return Response(status_code=204)


@router.get(T + "/plan")
def plan(session_id: CanvasAgentSessionId):
    sessions.read(session_id)
    try:
        return CanvasAgentPlan.model_validate_json(
            read_text_with_retry(sessions.plan_path(session_id))
        )
    except FileNotFoundError:
        return None


@router.get(T + "/usage")
def usage(session_id: CanvasAgentSessionId):
    row = sessions.read(session_id)
    agent_usage.settle_pending(None, session_id)
    return agent_usage.session_totals(None, session_id, datetime.fromisoformat(row.created_at))


@router.get(T + "/jobs")
def jobs(session_id: CanvasAgentSessionId):
    sessions.read(session_id)
    return {
        "jobs": [job for job in list_jobs() if sessions.owns_job(session_id, job)]
    }


@router.post(T + "/attachments", status_code=201)
async def upload(session_id: CanvasAgentSessionId, file: UploadFile = File(...)):
    raw, ext, body, kind = await _read_media_upload(file)
    if kind != "image" or len(body) > 25 * 1024 * 1024:
        raise HTTPException(422, detail="附件需要 25 MiB 以内的图片")
    aid = secrets.token_hex(16) + ext

    def store(current, now):
        from PIL import Image

        try:
            with Image.open(io.BytesIO(body)) as image:
                if image.width * image.height > 40_000_000:
                    raise ValueError("图片像素超限")
                image.verify()
        except (ValueError, OSError, Image.DecompressionBombError):
            raise HTTPException(422, detail="图片无效或像素超限") from None
        directory = sessions.upload_dir(session_id)
        directory.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(directory / aid, body)
        return {"uploads": {**current.uploads, aid: raw.replace("\\", "/").split("/")[-1][:120]}}

    await asyncio.to_thread(sessions.mutate, session_id, store)
    return {
        "attachment_id": aid,
        "kind": "image",
        "title": raw.replace("\\", "/").split("/")[-1][:120],
    }


@router.get(T + "/attachments/{attachment_id}")
def attachment(session_id: CanvasAgentSessionId, attachment_id: str):
    try:
        path, _ = media_path(session_id, "upload:" + attachment_id)
    except ValueError:
        raise HTTPException(404, detail="附件不存在") from None
    return FileResponse(path)
