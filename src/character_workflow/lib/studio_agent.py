"""Studio 工作区给共用对话引擎提供会话、工具、媒体和确认摘要。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from character_workflow.lib import canvas_agent_cost as cost
from character_workflow.lib import canvas_agent_library as library
from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib import canvas_agent_video as video
from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib import studio_agent_sessions as sessions
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_agent_schema import MAX_BATCH_GENERATIONS
from character_workflow.lib.canvas_agent_tools import _size_checks, _transparency
from character_workflow.lib.canvas_tool_common import CanvasToolError
from character_workflow.lib.creation_assets import (
    asset_media_content,
    creation_asset_media_path,
    get_creation_asset,
)
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import (
    CANVAS_DRAFT_PARAM_FIELDS,
    CanvasAgentPlan,
    JobParams,
    StudioAgentStep,
)

INSTRUCTIONS = """你是 Atelier 创作台的创作助手。仅在用户明确要求生成时提交付费任务。
先 list_models 选择允许的 alias、model 与参数。参考素材只用用户的附件、资产或本会话结果的 media_ref。
用 run_generation / run_generations 提交，再用 wait_for_run(s) 等待；看图或视频联系表后核对并汇报。
部分成功或提交状态不明时不要自动重新生成。多步骤任务用 update_plan。使用技能前读取说明。用中文简短回答。"""


REFERENCE_FIELDS = {
    "image": "reference_images",
    "video": "reference_videos",
    "audio": "reference_audios",
}


class Reference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    media_ref: str = Field(min_length=1, max_length=200)
    slot: Literal["reference", "first_frame", "last_frame"] = "reference"


class Generation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["image", "video"]
    alias: str | None = None
    model: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=40_000)
    params: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=40)
    references: list[Reference] = Field(default_factory=list, max_length=16)
    count: int = Field(default=1, ge=1, le=4)

    def parameters(self, sid):
        allowed = CANVAS_DRAFT_PARAM_FIELDS[self.kind] - {
            "workflow_inputs",
            "creation_asset_source_title",
            "prompt_asset_id",
            "n",
        }
        if self.params.keys() - allowed:
            raise ValueError("生成参数包含未开放的字段")
        params = JobParams.model_validate({**self.params, "n": self.count}).model_dump(
            exclude_none=True
        )
        refs = sorted(
            self.references,
            key=lambda ref: {"first_frame": 0, "reference": 1, "last_frame": 2}[ref.slot],
        )
        frame_slots = [ref.slot for ref in refs if ref.slot != "reference"]
        if frame_slots:
            if (
                self.kind != "video"
                or len(frame_slots) != len(refs)
                or len(set(frame_slots)) != len(frame_slots)
            ):
                raise ValueError("首尾帧只适用于视频且每个位置只能指定一张图")
            params["frame_mode"] = (
                "firstlast" if len(frame_slots) == 2 else frame_slots[0].split("_")[0]
            )
        for ref in refs:
            path, kind = media_path(sid, ref.media_ref)
            if (frame_slots or self.kind == "image") and kind != "image":
                raise ValueError("这个参考位置需要图片")
            if not path.is_file():
                raise ValueError("参考素材文件不存在")
            field = REFERENCE_FIELDS[kind]
            params.setdefault(field, []).append(str(path))
        return params


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Generation] = Field(min_length=1, max_length=MAX_BATCH_GENERATIONS)


def items_for(tool, args):
    return (
        Batch.model_validate(args).items
        if tool == "run_generations"
        else [Generation.model_validate(args)]
    )


def check_models(items, scope):
    by_kind = {}
    for item in items:
        if item.kind not in by_kind:
            by_kind[item.kind] = {(row["alias"], row["model"]) for row in scope.models(item.kind)}
        if (item.alias, item.model) not in by_kind[item.kind]:
            raise ValueError("当前创作设置不允许使用这个类型或模型")


def estimate_rows(items, sid, scope=None):
    if scope is not None:
        check_models(items, scope)
    rows = []
    for index, item in enumerate(items):
        params = item.parameters(sid)
        if item.kind == "video":
            params["n"] = 1
        amount = cost._estimate(item.kind, item.alias, item.model, params)
        if item.kind == "video" and amount is not None:
            amount *= item.count
        rows.append(
            {
                "index": index,
                "title": runtime.redact(item.prompt)[:80],
                "model": item.model,
                "count": item.count,
                "estimate_cny": amount,
            }
        )
    return rows


def job_for(sid, job_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job_id):
        raise ValueError("无效的任务 ID")
    job = read_job(job_id)
    if job.namespace != "studio" or job.studio_agent_session_id != sid:
        raise ValueError("任务不属于当前对话")
    return job


def media_path(sid, ref):
    session = sessions.read(sid)
    if ref.startswith("upload:"):
        aid = ref[7:]
        if aid not in session.uploads or not re.fullmatch(r"[a-f0-9]{32}\.[a-z0-9]{1,8}", aid):
            raise ValueError("附件不属于当前对话")
        return sessions.upload_dir(sid) / aid, "image"
    if ref.startswith("asset:"):
        asset_id = ref[6:]
        asset = get_creation_asset(asset_id)
        media = asset_media_content(asset)
        mentioned = any(asset_id in turn.asset_ids for turn in session.turns)
        if not media or not (
            mentioned or (asset.category and media.mime_type.startswith("image/"))
        ):
            raise ValueError("素材不在本机参考库或本轮引用中")
        return creation_asset_media_path(asset_id), media.mime_type.split("/")[0]
    match = re.fullmatch(r"output:([A-Za-z0-9_-]+):(\d{1,5})", ref)
    if not match:
        raise ValueError("无法识别的媒体引用")
    job = job_for(sid, match[1])
    index = int(match[2])
    if index >= len(job.output_paths):
        raise ValueError("结果序号超出范围")
    return Path(job.output_paths[index]), job.kind.value


def result_view(sid, job_id, check=False):
    job = job_for(sid, job_id)
    outputs = []
    for index, output in enumerate(job.output_paths):
        ref = f"output:{job_id}:{index}"
        row = {"index": index, "media_ref": ref, "kind": job.kind.value}
        if check:
            try:
                path = Path(output)
                if job.kind == "video":
                    info = video.probe(path)
                    checks = _size_checks(job.params, info["width"], info["height"])
                    if job.params.duration:
                        ms = info["duration_ms"]
                        checks.append(
                            {
                                "name": "duration",
                                "actual": ms,
                                "expected": job.params.duration * 1000,
                                "ok": abs(ms - job.params.duration * 1000) <= 1000,
                            }
                        )
                else:
                    _, width, height = library.image_preview(path)
                    checks = [*_size_checks(job.params, width, height), _transparency(path)]
                row["checks"] = [
                    *checks,
                    {"name": "format", "actual": path.suffix.lower(), "ok": None},
                ]
            except (ValueError, OSError):
                row["error"] = "无法读取结果媒体"
        outputs.append(row)
    return {
        "job_id": job_id,
        "status": job.status.value,
        "error": runtime.redact(job.error or ""),
        "outputs": outputs,
    }


def submit(workspace, item, params, call_id, index):
    from viewer_server.routes import _StudioJobCreate, _create_user_job, _store_runtime_upload

    if not call_id:
        raise ValueError("生成调用缺少唯一标识")
    identity = json.dumps([workspace.session_id, workspace.active_turn, call_id, index])
    jid = "studio-" + hashlib.sha256(identity.encode()).hexdigest()[:32]
    # 与删除/停止共用外部会话锁：已取消的后台工作不能在会话清理后再创建 Job。
    with sessions.lock(workspace.session_id):
        session = sessions.read(workspace.session_id)
        if session.status != "running" or session.turns[-1].turn_id != workspace.active_turn:
            raise ValueError("这一轮已结束")
        try:
            existing = job_for(workspace.session_id, jid)
        except FileNotFoundError:
            existing = None
        if existing:
            return jid
        for field in REFERENCE_FIELDS.values():
            if paths := params.get(field):
                params[field] = [
                    str(_store_runtime_upload(path.suffix.lower(), path.read_bytes()).resolve())
                    for path in map(Path, paths)
                ]
        body = _StudioJobCreate(
            prompt=item.prompt, alias=item.alias, model=item.model, kind=item.kind, params=params
        )
        job = _create_user_job(
            body,
            namespace="studio",
            job_id=jid,
            studio_agent_session_id=workspace.session_id,
            studio_agent_turn_id=workspace.active_turn,
        )
        workspace.schedule(job.job_id)
    return jid


def tool_error(error):
    if isinstance(error, ValidationError):
        return "参数错误：生成工具参数不符合要求"
    if isinstance(error, OSError):
        return "错误：无法访问本机素材或任务文件"
    return "错误：" + runtime.redact(str(getattr(error, "detail", error)))[:800]


class StudioWorkspace:
    event = "studio-agent"
    project_id = None

    def __init__(self, sid, schedule, notify=None):
        self.session_id = sid
        self.schedule = schedule
        self.notify = notify
        self.active_turn = None
        self.response_times: dict[str, deque[str]] = defaultdict(deque)

    def observe_response(self, response):
        # SDK 等 on_llm_end 返回才执行本次响应里的工具。重复的正文按出现顺序匹配。
        received_at = sessions.now()
        for item in response.output:
            if item.type == "message" and item.role == "assistant":
                text = runtime.redact(runtime._output_text(item.model_dump()).strip())
                self.response_times[text].append(received_at)

    def read(self):
        session = sessions.read(self.session_id)
        self.active_turn = session.turns[-1].turn_id if session.turns else None
        return session

    def mutate(self, update):
        step_events = []

        def scoped(current, now):
            if self.active_turn and current.turns[-1].turn_id != self.active_turn:
                raise CanvasToolError("SESSION_BUSY", "对话已切换轮次", 409)
            fields = update(current, now)
            if "messages" in fields:
                for message in fields["messages"][len(current.messages) :]:
                    if message.turn_id is None:
                        message.turn_id = self.active_turn
                    if message.role == "assistant" and (
                        times := self.response_times.get(message.text)
                    ):
                        message.created_at = times.popleft()
            if current.turns and "status" in fields:
                turns = list(current.turns)
                steps = list(turns[-1].steps)
                for approval in fields.get("pending_approvals", []):
                    if not any(step.step_id == approval.call_id for step in steps):
                        steps.append(
                            StudioAgentStep(
                                step_id=approval.call_id,
                                tool=approval.tool,
                                status="running",
                                summary=approval.summary,
                            )
                        )
                if fields["status"] in {"failed", "interrupted"}:
                    terminal = fields["status"]
                    if any(step.status == "running" for step in steps):
                        steps = [
                            step.model_copy(update={"status": terminal})
                            if step.status == "running"
                            else step
                            for step in steps
                        ]
                    else:
                        steps.append(
                            StudioAgentStep(
                                step_id=f"model-{turns[-1].turn_id}",
                                tool="model",
                                status=terminal,
                                summary=runtime.redact(fields.get("error") or ""),
                            )
                        )
                turns[-1] = turns[-1].model_copy(
                    update={"status": fields["status"], "steps": steps}
                )
                fields["turns"] = turns
            if self.notify and "turns" in fields:
                previous = {step.step_id: step for step in current.turns[-1].steps}
                step_events.extend(
                    step for step in fields["turns"][-1].steps if previous.get(step.step_id) != step
                )
            return fields

        session = sessions.mutate(self.session_id, scoped)
        for step in step_events:
            self.notify(self.event, {**self.address(), "kind": "step", "step": step.model_dump()})
        return session

    def turn_id(self, session):
        return session.turns[-1].turn_id

    def address(self):
        return {"session_id": self.session_id, "turn_id": self.active_turn}

    def instructions(self, session):
        return INSTRUCTIONS + skills.skills_prompt()

    def hydrate(self, history):
        return runtime.hydrate_refs(history, self.media, "（引用的素材已不可用）")

    def media(self, ref):
        try:
            if ref.startswith("frames:"):
                payload = json.loads(ref[7:])
                path, kind = media_path(self.session_id, payload["media_ref"])
                if kind != "video":
                    return None
                _, _, body = video.contact_sheet_for(
                    path, payload.get("count", 6), payload.get("start_ms"), payload.get("end_ms")
                )
                return "data:image/jpeg;base64," + base64.b64encode(body).decode("ascii")
            path, kind = media_path(self.session_id, ref)
            return library.image_preview(path)[0] if kind == "image" else None
        except (KeyError, OSError, ValueError):
            return None

    def record_decision(self, approval, approved, output):
        if approved:
            self.finish_step(approval.call_id, approval.tool, output)
        else:
            self.record_step(approval.call_id, approval.tool, "rejected", approval.summary)

    def finish_step(self, call_id, tool, output):
        status, summary = "completed", ""
        if runtime.is_tool_error(output):
            status, summary = "failed", runtime.tool_error_label(output)
        elif tool == "run_generations":
            result = json.loads(output)
            summary = runtime.generations_outcome(output) or ""
            if result.get("failed"):
                status = "failed"
        self.record_step(call_id, tool, status, summary)

    def record_step(self, call_id, tool, status, summary):
        def update(current, now):
            if current.status != "running":
                return {}
            turns = list(current.turns)
            steps = {step.step_id: step for step in turns[-1].steps}
            old = steps.get(call_id)
            steps[call_id] = StudioAgentStep(
                step_id=call_id,
                tool=tool,
                status=status,
                summary=runtime.redact(summary)[:800] or (old.summary if old else ""),
            )
            turns[-1] = turns[-1].model_copy(update={"steps": list(steps.values())})
            return {"turns": turns}

        self.mutate(update)

    def messages(self, items, turn_id):
        return runtime.display_messages(
            items, turn_id, describe=self.describe_tool, canvas_references=False
        )

    @staticmethod
    def describe_tool(tool, args):
        if tool == "run_generation":
            return "提交生成任务"
        if tool == "run_generations":
            return "批量提交生成任务"
        return runtime.summarize_call(tool, args)

    def created_fields(self, current, created):
        return {}

    def summary(self, tool, args, changes):
        if tool in {"run_generation", "run_generations"}:
            try:
                rows = estimate_rows(items_for(tool, args), self.session_id)
            except (OSError, ValueError, TypeError, LookupError):
                return "生成参数或参考素材无效，无法估价"
            amount = sum(row["estimate_cny"] or 0 for row in rows)
            priced = sum(row["estimate_cny"] is not None for row in rows)
            label = f"预计 {amount:g} 元" if priced else "未计价"
            return f"{len(rows)} 项生成，{label}" + (
                f"（{len(rows) - priced} 项未计价）" if 0 < priced < len(rows) else ""
            )
        return self.describe_tool(tool, args)

    def execute_approved(self, session, approval, created, rejected):
        return (
            self.invoke_sync(
                approval.tool,
                runtime._arguments(approval.arguments),
                runtime.ModelScope.of(session),
                approval.call_id,
                rejected,
            ),
            set(),
            None,
        )

    def invoke_sync(self, name, args, scope, call_id, rejected=frozenset()):
        try:
            return json.dumps(
                self.execute(name, args, scope, call_id, rejected), ensure_ascii=False
            )
        except Exception as error:
            return tool_error(error)

    def execute(self, name, args, scope, call_id, rejected):
        sid = self.session_id
        if name in {"run_generation", "run_generations"}:
            items = items_for(name, args)
            chosen = {index: item for index, item in enumerate(items) if index not in rejected}
            check_models(chosen.values(), scope)
            prepared = {index: item.parameters(sid) for index, item in chosen.items()}
            rows = []
            for index, item in enumerate(items):
                row = {"index": index, "status": "rejected"}
                if index not in rejected:
                    try:
                        jid = submit(self, item, prepared[index], call_id, index)
                        row.update(status="submitted", job_id=jid)
                    except Exception as error:
                        if name == "run_generation":
                            raise
                        row.update(
                            status="failed",
                            error=tool_error(error),
                        )
                rows.append(row)
            if name == "run_generation":
                return rows[0]
            return {
                "items": rows,
                **{
                    state: sum(row["status"] == state for row in rows)
                    for state in ("submitted", "failed", "rejected")
                },
            }
        if name == "list_models":
            kinds = [args["mode"]] if args.get("mode") else scope.kinds()
            return {"models": [row for kind in kinds for row in scope.models(kind)]}
        if name == "search_library":
            limit = int(args.get("limit", 12))
            if not 1 <= limit <= 12:
                raise ValueError("limit 需为 1–12")
            return library.search_library(None, args.get("category"), limit)
        if name in {"load_skill", "read_skill_file"}:
            return {
                "name": args["name"],
                "content": skills.read_skill(args["name"])
                if name == "load_skill"
                else skills.read_skill_file(args["name"], args["path"]),
            }
        if name == "update_plan":
            plan = CanvasAgentPlan(items=args["items"], updated_at=sessions.now())
            with sessions.lock(sid):
                sessions.read(sid)
                path = sessions.plan_path(sid)
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(path, plan.model_dump(mode="json"))
            return {"ok": True, "items": len(plan.items)}
        if name in {"get_run", "check_run"}:
            return result_view(sid, args["job_id"], name == "check_run")
        if name in {"read_media", "read_video_frames"}:
            path, kind = media_path(sid, args["media_ref"])
            if name == "read_video_frames":
                if kind != "video" or not 1 <= args.get("count", 6) <= 9:
                    raise ValueError("需要视频素材与 1–9 帧")
                info = video.probe(path)
                frames = video.sample_indices(
                    info, args.get("count", 6), args.get("start_ms"), args.get("end_ms")
                )
                return {**info, "frames": frames, "attach_images": ["frames:" + json.dumps(args)]}
            if kind == "image":
                _, width, height = library.image_preview(path)
                return {
                    "kind": kind,
                    "width": width,
                    "height": height,
                    "attach_images": [args["media_ref"]],
                }
            return {"kind": kind, **(video.probe(path) if kind == "video" else {})}
        raise ValueError("这个工具不属于创作台")

    async def wait(self, ids):
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_BATCH_GENERATIONS:
            raise ValueError("需要 1–20 个任务 ID")

        def lookup(jid):
            try:
                return result_view(self.session_id, jid)
            except (OSError, ValueError) as error:
                return {"lookup_error": runtime.redact(str(error))}

        views = await vision.wait_for_runs({jid: lambda jid=jid: lookup(jid) for jid in ids})
        images = {}
        for jid, view in views.items():
            if view.get("outputs"):
                view.update(await asyncio.to_thread(result_view, self.session_id, jid, True))
                images[jid] = [
                    row["media_ref"]
                    if row["kind"] == "image"
                    else "frames:" + json.dumps({"media_ref": row["media_ref"]})
                    for row in view["outputs"]
                ]
        attached, omitted = vision.pick_attachments(images)
        return {"runs": views, "attach_images": attached, "omitted": omitted}

    def tools(self):
        from agents import FunctionTool

        names = (
            "list_models",
            "search_library",
            "load_skill",
            "read_skill_file",
            "update_plan",
            "get_run",
            "check_run",
            "wait_for_run",
            "wait_for_runs",
            "read_media",
            "read_video_frames",
            "run_generation",
            "run_generations",
        )

        def build(name):
            # SDK 继续派发无需确认的工具；估价失败的这一次调用只能返回错误，不能执行任何生成。
            invalid_calls = {}
            description, schema = runtime.TOOL_SPECS[name]
            if name in {"run_generation", "run_generations"}:
                schema = runtime._inline_refs(
                    (Generation if name == "run_generation" else Batch).model_json_schema()
                )
                description = (
                    "按创作参数提交付费 Studio 生成，返回 job_id；部分成功保留，禁止自动重试。"
                )
            else:
                schema = json.loads(
                    json.dumps(schema)
                    .replace('"version_id"', '"media_ref"')
                    .replace('"run_id"', '"job_id"')
                    .replace('"run_ids"', '"job_ids"')
                )
                description = description.replace("本项目", "本机").replace("run_id", "job_id")

            async def invoke(ctx, raw):
                call_id = ctx.tool_call_id
                try:
                    args = json.loads(raw or "{}")
                    await asyncio.to_thread(
                        self.record_step, call_id, name, "running", self.describe_tool(name, args)
                    )
                    if call_id in invalid_calls:
                        output = invalid_calls.pop(call_id)
                    elif name.startswith("wait_for_"):
                        ids = args["job_ids"] if name == "wait_for_runs" else [args["job_id"]]
                        output = json.dumps(await self.wait(ids), ensure_ascii=False)
                    else:
                        output = await asyncio.to_thread(
                            self.invoke_sync, name, args, ctx.context.scope, call_id
                        )
                        if name == "update_plan" and not runtime.is_tool_error(output):
                            ctx.context.notify(self.event, {**self.address(), "kind": "plan"})
                except (OSError, ValueError, KeyError, TypeError) as error:
                    output = tool_error(error)
                await asyncio.to_thread(self.finish_step, call_id, name, output)
                return output

            async def approval(ctx, args, call_id):
                try:
                    rows = await asyncio.to_thread(
                        estimate_rows, items_for(name, args), self.session_id, ctx.context.scope
                    )
                except (OSError, ValueError, TypeError, LookupError) as error:
                    invalid_calls[call_id] = tool_error(error)
                    return False
                return ctx.context.permission_mode != "auto" or cost.needs_cost_confirmation(
                    sum(row["estimate_cny"] or 0 for row in rows)
                )

            return FunctionTool(
                name=name,
                description=description,
                params_json_schema=schema,
                strict_json_schema=False,
                on_invoke_tool=invoke,
                needs_approval=approval if name.startswith("run_generation") else False,
            )

        return [build(name) for name in names]
