"""画布内置 Agent：一轮对话 = OpenAI Agents SDK 跑到结束或停在待确认。

- 工具直接调用 canvas_agent_tools（principal=local），和外部 MCP 共用一套业务层与校验。
- 权限：「审查」每次改动都确认；「Auto」只放行新增（生成、建节点、连线，以及改本会话新建的节点）。
- 待确认时不保存 SDK 内部状态：会话里只存 input items + 待确认清单；用户裁决后由这里执行或拒绝，
  把 function_call_output 补进历史，再从历史续跑一轮。
- 图片在历史里只存 atelier-media://<version_id>，每轮发给模型前才换成缩略图 data URL。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from types import SimpleNamespace
from typing import Any, Awaitable, Callable

from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib import keys
from character_workflow.lib.canvas_agent_models import chat_base_url
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasChange, CanvasListModelsInput, CanvasProjectInput,
    CanvasReadMediaInput, GetRunInput, RunInput,
)
from character_workflow.lib.canvas_agent_sessions import (
    mutate_canvas_agent_session, read_canvas_agent_session, with_appended_messages,
)
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.schemas import (
    CanvasAgentApproval, CanvasAgentMessageCreate, CanvasAgentReference, CanvasAgentSession,
    redact_canvas_agent_private_text as redact,
)
from character_workflow.lib.workshop import WorkshopError

logger = logging.getLogger(__name__)

Notify = Callable[[str, dict], None]

MAX_TURNS = 30
TOOL_OUTPUT_LIMIT = 20_000
DELTA_FLUSH_SECONDS = 0.15
MEDIA_SCHEME = "atelier-media://"
LOCAL = SimpleNamespace(kind="local", session_id="canvas-chat", grant_id=None)

READ_TOOLS = frozenset({"get_canvas", "list_models", "get_run", "read_media", "load_skill",
                        "read_skill_file", "wait_for_run"})
ADDITIVE_OPS = frozenset({"add_text", "add_media_node", "add_surface", "connect"})
NODE_TARGET_OPS = frozenset({"set_text", "set_draft", "move", "remove_node"})

INSTRUCTIONS = """你是 Game Atelier 画布里的创作助手，帮游戏美术和策划在无限画布上出图、出视频。

工作方式：
- 先用 get_canvas 看清画布现状，再动手；节点 id、版本 id 都以读到的为准，不要编。
- 生成一张图或一段视频的标准步骤：apply_changes 里 add_surface 建一个空的图片/视频节点 →
  set_draft 写提示词、模型（alias 与 model 必须来自 list_models）、参数 → 需要参考图时 connect
  把参考节点连到它 → run_generation 发起生成。
- 这几步放进同一次 apply_changes：add_surface 时自己指定 node_id（如 cat-1），同一批后面的
  set_draft / connect 用这个 node_id 引用它；节点标题不能当 id 用。
- 新节点放在已有内容旁边，避免重叠：参考现有节点的 position 和 size，往右或往下留出间距。
- 发起生成后调用 wait_for_run 等结果，结果图会附在工具结果后面给你看。看完向用户简短汇报：
  画面是否符合要求、哪里需要改。只有用户明确让你「多试几次 / 迭代到满意」时才自己改提示词重跑。
- 想看画布上已有的某张图，用 read_media，图片同样会附给你。
- 生成是付费的。不要自动重试失败的生成；失败时告诉用户原因，由用户决定。
- 用户拒绝某个操作时，不要换个方式再做同一件事，先问用户想怎么改。
- 回复用中文，简短直接。"""


@dataclass
class TurnContext:
    project_id: str
    permission_mode: str
    created_node_ids: set[str] = field(default_factory=set)


# ── 权限 ────────────────────────────────────────────────────────────────────────

def needs_confirmation(tool: str, arguments: dict, mode: str, created_node_ids: set[str]) -> bool:
    """审查模式：所有写操作都确认。Auto：只有修改 / 删除用户已有内容才确认。"""
    if tool in READ_TOOLS:
        return False
    if mode != "auto":
        return True
    if tool == "run_generation":
        return False
    if tool == "apply_changes":
        for change in arguments.get("changes") or []:
            op = change.get("op") if isinstance(change, dict) else None
            if op in ADDITIVE_OPS:
                continue
            if op in NODE_TARGET_OPS and change.get("node_id") in created_node_ids:
                continue
            return True
        return False
    return True


# ── 工具执行（同步，跑在线程里）──────────────────────────────────────────────────

def _current_revision(project_id: str) -> int:
    return read_canvas_document(project_id).revision


def _schedule_canvas_job(job_id: str) -> None:
    from character_workflow.lib.canvas_runs import run_canvas_job_scheduled

    def target() -> None:
        try:
            run_canvas_job_scheduled(job_id)
        except Exception:  # noqa: BLE001 — run_canvas_job 已把失败写进 job 与候选
            logger.warning("canvas agent run failed: %s", job_id)

    threading.Thread(target=target, name=f"canvas-agent-run-{job_id}", daemon=True).start()


def _with_fresh_revision(project_id: str, call: Callable[[int], dict]) -> dict:
    """确认可能等了很久，画布早已被用户改过：执行时取当前修订号，撞车再读一次。"""
    try:
        return call(_current_revision(project_id))
    except WorkshopError as error:
        if error.code != "DOCUMENT_CONFLICT":
            raise
        return call(_current_revision(project_id))


def execute_tool(project_id: str, tool: str, arguments: dict) -> tuple[dict, list[str]]:
    """Run one tool call; returns (result, node ids it created). Raises WorkshopError."""
    if tool == "get_canvas":
        return tools.get_document(LOCAL, CanvasProjectInput(project_id=project_id)), []
    if tool == "list_models":
        payload = CanvasListModelsInput(project_id=project_id, mode=arguments.get("mode", "image"))
        return tools.list_models(LOCAL, payload), []
    if tool == "get_run":
        payload = GetRunInput(project_id=project_id, run_id=arguments["run_id"])
        return tools.get_run(LOCAL, payload), []
    if tool == "read_media":
        payload = CanvasReadMediaInput(project_id=project_id, version_id=arguments["version_id"])
        result = tools.read_media(LOCAL, payload)
        result.pop("preview", None)  # 工具结果只收文本；图片由 vision 在调模型前附上
        if result.get("kind") == "image":
            result[vision.ATTACH_KEY] = [payload.version_id]
        return result, []
    if tool == "load_skill":
        return {"name": arguments["name"], "content": skills.read_skill(arguments["name"])}, []
    if tool == "read_skill_file":
        return {"path": arguments["path"],
                "content": skills.read_skill_file(arguments["name"], arguments["path"])}, []
    if tool == "apply_changes":
        result = _with_fresh_revision(project_id, lambda revision: tools.apply_changes(
            LOCAL, ApplyChangesInput(project_id=project_id, expected_revision=revision,
                                     changes=arguments.get("changes") or []),
        ))
        return result, list(result.get("node_ids") or [])
    if tool == "run_generation":
        def submit(revision: int) -> dict:
            result, job = tools.run(LOCAL, RunInput(
                project_id=project_id, surface_node_id=arguments["surface_node_id"],
                expected_revision=revision, requested_count=arguments.get("count", 1),
            ))
            _schedule_canvas_job(job.job_id)
            return result
        result = _with_fresh_revision(project_id, submit)
        return result, [result["result_node_id"]] if result.get("result_node_id") else []
    raise WorkshopError("INVALID_TARGET", f"未知工具 {tool}", 422)


def run_tool_safely(project_id: str, tool: str, arguments: dict) -> tuple[str, list[str]]:
    """Tool output text for the model; errors become text the model can react to."""
    try:
        result, created = execute_tool(project_id, tool, arguments)
    except WorkshopError as error:
        return f"错误（{error.code}）：{error.message}", []
    except (KeyError, TypeError, ValueError) as error:
        return f"参数错误：{error}", []
    text = json.dumps(result, ensure_ascii=False)
    if len(text) > TOOL_OUTPUT_LIMIT:
        text = text[:TOOL_OUTPUT_LIMIT] + "…（已截断）"
    return text, created


def is_tool_error(text: str) -> bool:
    return text.startswith(("错误", "参数错误"))


def tool_error_label(text: str) -> str:
    """面板上的一行说明；完整的校验信息只给模型看（它要靠这个改参数）。"""
    if text.startswith("参数错误"):
        return "参数不合规，已退回模型修正"
    return text.splitlines()[0][:200]


# ── 工具定义（给模型看的 schema）─────────────────────────────────────────────────

TOOL_SPECS: dict[str, tuple[str, dict]] = {
    "get_canvas": ("读取当前画布：节点、文本、生成配置、连线、媒体版本。",
                   {"type": "object", "properties": {}}),
    "list_models": ("列出可用于生成配置的图片 / 视频模型（alias + model + 参数能力）。",
                    {"type": "object", "properties": {
                        "mode": {"type": "string", "enum": ["image", "video"]}}}),
    "apply_changes": (
        "在当前画布上批量改动：add_text / add_media_node / add_surface / set_text / set_draft / "
        "connect / disconnect / move / remove_node。整批原子提交。", {}),
    "run_generation": ("在已写好生成配置的图片 / 视频节点上发起生成（付费）。",
                       {"type": "object", "required": ["surface_node_id"], "properties": {
                           "surface_node_id": {"type": "string"},
                           "count": {"type": "integer", "minimum": 1, "maximum": 4}}}),
    "get_run": ("查询一次生成的状态与产物版本。",
                {"type": "object", "required": ["run_id"],
                 "properties": {"run_id": {"type": "string"}}}),
    "read_media": ("读取一个媒体版本的元数据（类型、尺寸、时长）。",
                   {"type": "object", "required": ["version_id"],
                    "properties": {"version_id": {"type": "string"}}}),
    "wait_for_run": ("等一次生成跑完（最多约 4 分钟），返回状态与产物版本；成功的图片会附给你看。",
                     {"type": "object", "required": ["run_id"],
                      "properties": {"run_id": {"type": "string"}}}),
    "load_skill": ("读取一个 Skill 的完整说明（名称见系统提示里的 Skill 列表）。",
                   {"type": "object", "required": ["name"],
                    "properties": {"name": {"type": "string"}}}),
    "read_skill_file": ("读取 Skill 附带的参考文件（路径见 load_skill 结果末尾的清单）。",
                        {"type": "object", "required": ["name", "path"],
                         "properties": {"name": {"type": "string"},
                                        "path": {"type": "string"}}}),
}


def _inline_refs(schema: dict) -> dict:
    """展开 $ref / $defs、去掉 discriminator：聚合商把工具转给 Claude 等模型时常丢掉 $defs，
    模型看不到真实结构就自己编字段（实测 Tuzi 的 Claude 把 op 写成 action）。"""
    defs = schema.get("$defs", {})

    def walk(value):
        if isinstance(value, dict):
            if "$ref" in value:
                return walk(defs[value["$ref"].rsplit("/", 1)[-1]])
            return {key: walk(item) for key, item in value.items()
                    if key not in {"$defs", "discriminator"}}
        if isinstance(value, list):
            return [walk(item) for item in value]
        return value

    return walk(schema)


def _params_schema(name: str, base: dict) -> dict:
    if name != "apply_changes":
        return base
    from pydantic import TypeAdapter
    changes = _inline_refs(TypeAdapter(list[CanvasChange]).json_schema())
    return {"type": "object", "required": ["changes"], "properties": {"changes": changes}}


def arguments_valid(project_id: str, tool: str, arguments: dict) -> bool:
    """写操作的参数先按真实入参模型校验：不合格的调用不打扰用户，直接把校验错误回给模型去改。"""
    from pydantic import ValidationError
    try:
        if tool == "apply_changes":
            ApplyChangesInput(project_id=project_id, expected_revision=0,
                              changes=arguments.get("changes") or [])
        elif tool == "run_generation":
            RunInput(project_id=project_id, expected_revision=0,
                     surface_node_id=arguments.get("surface_node_id", ""),
                     requested_count=arguments.get("count", 1))
    except (ValidationError, TypeError):
        return False
    return True


def _is_image_version(project_id: str, version_id: str) -> bool:
    version = read_canvas_document(project_id).content_versions.get(version_id)
    return version is not None and version.kind == "image"


async def _wait_for_run(project_id: str, run_id: str) -> str:
    """轮询期间不占线程：每次查询进线程池，等待用 asyncio.sleep。"""
    try:
        result = await vision.wait_for_run(
            lambda: tools.get_run(LOCAL, GetRunInput(project_id=project_id, run_id=run_id)),
            lambda version_id: _is_image_version(project_id, version_id),
        )
    except WorkshopError as error:
        return f"错误（{error.code}）：{error.message}"
    return json.dumps(result, ensure_ascii=False)


def build_tools() -> list:
    from agents import FunctionTool

    def make(name: str, description: str, schema: dict) -> FunctionTool:
        async def invoke(ctx, raw: str) -> str:
            turn: TurnContext = ctx.context
            arguments = json.loads(raw or "{}")
            if name == "wait_for_run":
                return await _wait_for_run(turn.project_id, str(arguments.get("run_id", "")))
            text, created = await asyncio.to_thread(run_tool_safely, turn.project_id, name,
                                                    arguments)
            turn.created_node_ids.update(created)
            return text

        async def approval(ctx, arguments: dict, _call_id: str) -> bool:
            turn: TurnContext = ctx.context
            if not arguments_valid(turn.project_id, name, arguments):
                return False  # 执行时会因校验失败直接返回错误，没有任何副作用
            return needs_confirmation(name, arguments, turn.permission_mode,
                                      turn.created_node_ids)

        # 只读工具直接给 False：部分模型（Tuzi 的 Claude）对无参工具传空字符串参数，SDK 判为
        # 「参数无法解析」后会无视回调、一律要求人工确认，读画布也弹确认卡。
        return FunctionTool(name=name, description=description, params_json_schema=schema,
                            on_invoke_tool=invoke, strict_json_schema=False,
                            needs_approval=False if name in READ_TOOLS else approval)

    return [make(name, desc, _params_schema(name, schema))
            for name, (desc, schema) in TOOL_SPECS.items()]


# ── 历史 ↔ 模型输入 ──────────────────────────────────────────────────────────────

def _media_data_url(project_id: str, version_id: str) -> str | None:
    try:
        media = tools.read_media(LOCAL, CanvasReadMediaInput(project_id=project_id,
                                                             version_id=version_id))
    except WorkshopError:
        return None
    preview = media.get("preview")
    return f"data:{preview['mime_type']};base64,{preview['data_base64']}" if preview else None


def hydrate(project_id: str, history: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Replace atelier-media refs with data URLs; returns (items, data_url → ref)."""
    reverse: dict[str, str] = {}

    def convert(value: Any) -> Any:
        if isinstance(value, dict):
            url = value.get("image_url")
            if value.get("type") == "input_image" and isinstance(url, str) \
                    and url.startswith(MEDIA_SCHEME):
                data_url = _media_data_url(project_id, url.removeprefix(MEDIA_SCHEME))
                if data_url is None:
                    return {"type": "input_text", "text": "（引用的图片已不在画布上）"}
                reverse[data_url] = url
                return {**value, "image_url": data_url}
            return {key: convert(item) for key, item in value.items()}
        if isinstance(value, list):
            return [convert(item) for item in value]
        return value

    return convert(history), reverse


def dehydrate(items: list[dict], reverse: dict[str, str]) -> list[dict]:
    def convert(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: convert(item) for key, item in value.items()}
        if isinstance(value, list):
            return [convert(item) for item in value]
        if isinstance(value, str) and value in reverse:
            return reverse[value]
        if isinstance(value, str) and value.startswith("data:"):
            return "（图片已省略）"
        return value

    return convert(items)


def _jsonable(items: list) -> list[dict]:
    return json.loads(json.dumps(items, ensure_ascii=False, default=str))


def user_item(project_id: str, text: str, node_ids: list[str]) -> tuple[dict, list[dict]]:
    """User message item plus display references for the nodes the user attached."""
    document = read_canvas_document(project_id)
    by_id = {node.id: node for node in document.nodes}
    content: list[dict] = [{"type": "input_text", "text": text}]
    references: list[dict] = []
    for node_id in node_ids:
        node = by_id.get(node_id)
        if node is None:
            continue
        version_id = getattr(node.data, "current_version_id", None)
        references.append({"reference_id": node_id, "kind": "node", "node_id": node_id,
                           "version_id": version_id, "title": node.title})
        content.append({"type": "input_text",
                        "text": f"[引用节点 {node_id}「{node.title}」类型 {node.type}]"})
        version = document.content_versions.get(version_id or "")
        if version is not None and version.kind == "image":
            content.append({"type": "input_image", "detail": "auto",
                            "image_url": f"{MEDIA_SCHEME}{version_id}"})
    return {"role": "user", "content": content}, references


def _output_text(item: dict) -> str:
    return "".join(part.get("text", "") for part in item.get("content") or []
                   if isinstance(part, dict) and part.get("type") == "output_text")


def _reasoning_text(item: dict) -> str:
    return "\n".join(part.get("text", "") for part in item.get("summary") or []
                     if isinstance(part, dict))


def _arguments(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


READ_LABELS = {"get_canvas": "读取画布", "list_models": "查看可用模型", "get_run": "查询生成进度",
               "read_media": "读取媒体信息", "wait_for_run": "等待生成结果"}


def summarize_call(tool: str, arguments: dict) -> str:
    if tool == "load_skill":
        return str(arguments.get("name", ""))
    if tool == "read_skill_file":
        # 只显示文件名：带目录的相对路径会被落盘前的隐私替换当成本机路径藏掉。
        return f"{arguments.get('name', '')} · {PurePosixPath(str(arguments.get('path', ''))).name}"
    if tool in READ_LABELS:
        return READ_LABELS[tool]
    if tool == "run_generation":
        return f"在节点 {arguments.get('surface_node_id')} 上生成 {arguments.get('count', 1)} 个结果"
    if tool == "apply_changes":
        lines = []
        for change in arguments.get("changes") or []:
            if not isinstance(change, dict):
                continue
            op = change.get("op")
            target = change.get("title") or change.get("node_id") or change.get("connection_id") or ""
            detail = ""
            if op == "set_draft":
                detail = f"：{str(change.get('prompt', ''))[:200]}（{change.get('model')}）"
            lines.append(f"{op} {target}{detail}".strip())
        return "\n".join(lines)
    return json.dumps(arguments, ensure_ascii=False)[:500]


def display_messages(items: list[dict], turn_id: str) -> list[CanvasAgentMessageCreate]:
    """Model-side items (this run's new ones) → messages the panel shows.

    待确认的调用（还没有 output）不在这里出现：面板用确认卡展示它，裁决后由 resolve_approvals
    补一条带结果的工具消息，同一个操作只显示一次。"""
    item_by_call = {item.get("call_id"): item for item in items
                    if item.get("type") == "function_call_output"}
    outputs = {call_id: str(item.get("output", "")) for call_id, item in item_by_call.items()}
    messages: list[CanvasAgentMessageCreate] = []
    reasoning: list[str] = []
    for item in items:
        kind = item.get("type")
        if kind == "reasoning":
            reasoning.append(_reasoning_text(item))
        elif kind == "message" and item.get("role") == "assistant":
            text = _output_text(item).strip()
            summary = redact("\n".join(part for part in reasoning if part))[:40_000]
            if text or summary:
                messages.append(CanvasAgentMessageCreate(
                    role="assistant", turn_id=turn_id, text=redact(text),
                    reasoning_summary=summary or None,
                ))
            reasoning = []
        elif kind == "function_call" and item.get("call_id") in outputs:
            name = str(item.get("name"))
            output = outputs[item.get("call_id")]
            text = summarize_call(name, _arguments(item.get("arguments")))
            if is_tool_error(output):
                text = f"{tool_error_label(output)}\n{text}"
            # 附给模型看的图同时作为引用显示在对话里（面板按 version_id 出缩略图）。
            images = vision.attached_ids(item_by_call.get(item.get("call_id"), {}))
            messages.append(CanvasAgentMessageCreate(
                role="tool", turn_id=turn_id, title=name, text=redact(text),
                references=[CanvasAgentReference(reference_id=vid, kind="content", version_id=vid,
                                                 title="生成结果") for vid in images],
            ))
    return messages


# ── 一轮对话 ────────────────────────────────────────────────────────────────────

def build_agent(session: CanvasAgentSession):
    from agents import Agent, ModelSettings, OpenAIChatCompletionsModel, set_tracing_disabled
    from openai import AsyncOpenAI
    from openai.types.shared import Reasoning
    set_tracing_disabled(True)  # 否则 SDK 会把对话轨迹上传到 OpenAI
    key = keys.find_by_alias(session.model_alias or "")
    if key is None or not session.model:
        raise WorkshopError("INVALID_PARAMETERS", "请先选择对话模型", 422)
    client = AsyncOpenAI(base_url=chat_base_url(key), api_key=key.access_key, max_retries=2)
    settings = ModelSettings(reasoning=Reasoning(effort=session.effort)) if session.effort \
        else ModelSettings()
    return Agent(
        name="canvas-agent", instructions=INSTRUCTIONS + skills.skills_prompt(),
        tools=build_tools(),
        model=OpenAIChatCompletionsModel(model=session.model, openai_client=client),
        model_settings=settings,
    )


def friendly_error(error: BaseException) -> str:
    from agents.exceptions import MaxTurnsExceeded
    from openai import APIConnectionError, APIError, APIStatusError, APITimeoutError
    if isinstance(error, WorkshopError):
        return error.message
    if isinstance(error, MaxTurnsExceeded):
        return "这一轮步骤太多，已停下；可以让它继续"
    if isinstance(error, APITimeoutError):
        return "对话模型响应超时"
    if isinstance(error, APIConnectionError):
        return "连不上对话模型的服务商"
    if isinstance(error, APIStatusError):
        message = ""
        if isinstance(error.body, dict):
            detail = error.body.get("error", error.body)
            message = str(detail.get("message") if isinstance(detail, dict) else detail)
        lowered = message.lower()
        if "image" in lowered or "vision" in lowered or "multimodal" in lowered:
            return f"该模型不能看图，请换一个支持图片输入的模型（{error.status_code}）"
        if "tool" in lowered or "function" in lowered:
            return f"该模型不支持工具调用，请换一个（{error.status_code}）"
        return f"对话模型返回错误 {error.status_code}：{redact(message)[:300]}"
    if isinstance(error, APIError):  # 流式响应里的错误不带状态码（如模型已下线的 410）
        return f"对话模型返回错误：{redact(str(error.message))[:300]}"
    return "对话出错，详情见服务日志"


class DeltaBuffer:
    def __init__(self, notify: Notify, project_id: str, session_id: str) -> None:
        self.notify, self.project_id, self.session_id = notify, project_id, session_id
        self.pending = ""
        self.last = 0.0

    def add(self, text: str) -> None:
        self.pending += text
        if time.monotonic() - self.last >= DELTA_FLUSH_SECONDS:
            self.flush()

    def tool(self, name: str) -> None:
        """模型开始调用工具：先把已有文字推出去，再告诉面板正在做哪一步。"""
        self.flush()
        self.notify("canvas-agent", {"project_id": self.project_id, "session_id": self.session_id,
                                     "kind": "tool", "text": name})

    def flush(self) -> None:
        if self.pending:
            self.notify("canvas-agent", {"project_id": self.project_id,
                                         "session_id": self.session_id,
                                         "kind": "delta", "text": self.pending})
            self.pending = ""
        self.last = time.monotonic()


def _run_config(project_id: str):
    """每次调模型前把最近的结果图附上（只影响这次请求，不进历史）。"""
    from agents import RunConfig
    from agents.run_config import ModelInputData

    async def attach(data) -> ModelInputData:
        items = await asyncio.to_thread(
            vision.with_attached_images, list(data.model_data.input),
            lambda version_id: _media_data_url(project_id, version_id),
        )
        return ModelInputData(input=items, instructions=data.model_data.instructions)

    return RunConfig(call_model_input_filter=attach)


async def _run_model(session: CanvasAgentSession, history: list[dict], buffer: DeltaBuffer):
    from agents import Runner
    agent = build_agent(session)
    context = TurnContext(session.project_id, session.permission_mode,
                          set(session.created_node_ids))
    result = Runner.run_streamed(agent, history, context=context, max_turns=MAX_TURNS,
                                 run_config=_run_config(session.project_id))
    async for event in result.stream_events():
        data = getattr(event, "data", None)
        if getattr(event, "type", "") == "raw_response_event" \
                and getattr(data, "type", "") == "response.output_text.delta":
            buffer.add(data.delta)
        elif getattr(event, "type", "") == "run_item_stream_event" \
                and getattr(event, "name", "") == "tool_called":
            buffer.tool(str(getattr(getattr(event.item, "raw_item", None), "name", "")))
    buffer.flush()
    return result, context


# 测试替换点：(session, hydrated history, buffer) → (RunResult-like, TurnContext)
run_model: Callable[..., Awaitable[Any]] = _run_model


def notify_session(notify: Notify, project_id: str, session_id: str) -> None:
    notify("canvas-agent", {"project_id": project_id, "session_id": session_id,
                            "kind": "session"})


async def run_turn(project_id: str, session_id: str, notify: Notify) -> None:
    """Continue the session from its stored history until done or awaiting approval."""
    session = await asyncio.to_thread(read_canvas_agent_session, project_id, session_id)
    turn_id = f"turn-{int(time.time() * 1000)}"
    base = list(session.history)
    hydrated, reverse = await asyncio.to_thread(hydrate, project_id, base)
    buffer = DeltaBuffer(notify, project_id, session_id)
    try:
        result, context = await run_model(session, hydrated, buffer)
    except asyncio.CancelledError:
        await asyncio.to_thread(_finish_failed, project_id, session_id, turn_id,
                                "interrupted", "已停止")
        notify_session(notify, project_id, session_id)
        raise
    except Exception as error:  # noqa: BLE001 — 任何失败都要落到会话里，面板才看得到
        logger.warning("canvas agent turn failed: %s", type(error).__name__, exc_info=True)
        await asyncio.to_thread(_finish_failed, project_id, session_id, turn_id,
                                "failed", friendly_error(error))
        notify_session(notify, project_id, session_id)
        return

    items = dehydrate(_jsonable(result.to_input_list()), reverse)
    new_items = items[len(base):]
    pending = []
    for interruption in result.interruptions:
        call = interruption.raw_item
        pending.append(CanvasAgentApproval(
            call_id=call.call_id, tool=call.name, arguments=call.arguments or "{}",
            summary=redact(summarize_call(call.name, _arguments(call.arguments)))[:4000],
        ))
    usage = result.context_wrapper.usage

    def update(current: CanvasAgentSession, now: str) -> dict:
        return {
            **with_appended_messages(current, display_messages(new_items, turn_id), now),
            "history": items,
            "pending_approvals": pending,
            "status": "awaiting_approval" if pending else "idle",
            "error": None,
            "created_node_ids": sorted(set(current.created_node_ids) | context.created_node_ids),
            "token_usage": {
                "input_tokens": current.token_usage.input_tokens + usage.input_tokens,
                "output_tokens": current.token_usage.output_tokens + usage.output_tokens,
            },
        }

    await asyncio.to_thread(mutate_canvas_agent_session, project_id, session_id, update)
    notify_session(notify, project_id, session_id)


def _finish_failed(project_id: str, session_id: str, turn_id: str, status: str,
                   message: str) -> None:
    def update(current: CanvasAgentSession, now: str) -> dict:
        error = CanvasAgentMessageCreate(role="error", turn_id=turn_id, text=message)
        return {**with_appended_messages(current, [error], now), "status": status,
                "error": message, "pending_approvals": []}

    mutate_canvas_agent_session(project_id, session_id, update)


# ── 会话入口（路由在线程里调用；之后由路由调度 run_turn）────────────────────────

def begin_user_turn(project_id: str, session_id: str, text: str, node_ids: list[str],
                    skill: str | None = None) -> CanvasAgentSession:
    """Append the user's message and mark the session running.

    用户在输入框点选了 Skill：把它的正文直接附在本条消息里，不靠模型自己判断要不要 load_skill。"""
    item, references = user_item(project_id, text, node_ids)
    if skill:
        item["content"].append({"type": "input_text", "text": (
            f"[本轮按 Skill「{skill}」的说明来做；其中提到的脚本不能执行]\n{skills.read_skill(skill)}")})

    def update(current: CanvasAgentSession, now: str) -> dict:
        if current.status in {"running", "awaiting_approval"}:
            raise WorkshopError("SESSION_BUSY", "上一轮还没结束", 409)
        if not current.model or not current.model_alias:
            raise WorkshopError("INVALID_PARAMETERS", "请先选择对话模型", 422)
        message = CanvasAgentMessageCreate(
            role="user", text=redact(text), title=skill,
            references=[CanvasAgentReference(**ref) for ref in references],
        )
        title = current.title
        if not current.messages and current.title == "新对话":
            title = re.sub(r"\s+", " ", redact(text)).strip()[:40] or current.title
        return {**with_appended_messages(current, [message], now), "title": title,
                "history": [*current.history, item], "status": "running", "error": None}

    return mutate_canvas_agent_session(project_id, session_id, update)


def resolve_approvals(project_id: str, session_id: str,
                      decisions: dict[str, bool]) -> CanvasAgentSession:
    """Execute approved calls, reject the rest, append their outputs, mark running."""
    session = read_canvas_agent_session(project_id, session_id)
    if session.status != "awaiting_approval":
        raise WorkshopError("SESSION_BUSY", "没有待确认的操作", 409)
    if set(decisions) != {approval.call_id for approval in session.pending_approvals}:
        raise WorkshopError("INVALID_PARAMETERS", "请对每个待确认操作都给出决定", 422)
    outputs: list[dict] = []
    results: list[CanvasAgentMessageCreate] = []
    created: set[str] = set()
    for approval in session.pending_approvals:
        if decisions[approval.call_id]:
            text, new_nodes = run_tool_safely(project_id, approval.tool,
                                              _arguments(approval.arguments))
            created.update(new_nodes)
            label = tool_error_label(text) if is_tool_error(text) else "已执行"
        else:
            text, label = "用户拒绝了这个操作。", "已拒绝"
        outputs.append({"type": "function_call_output", "call_id": approval.call_id,
                        "output": text})
        results.append(CanvasAgentMessageCreate(role="tool", title=approval.tool,
                                                text=redact(f"{label}\n{approval.summary}")))

    def update(current: CanvasAgentSession, now: str) -> dict:
        if current.status != "awaiting_approval":
            raise WorkshopError("SESSION_BUSY", "没有待确认的操作", 409)
        return {**with_appended_messages(current, results, now),
                "history": [*current.history, *outputs], "pending_approvals": [],
                "status": "running",
                "created_node_ids": sorted(set(current.created_node_ids) | created)}

    return mutate_canvas_agent_session(project_id, session_id, update)


def mark_interrupted(project_id: str, session_id: str) -> CanvasAgentSession:
    """running with no live task (server restarted mid-turn) → interrupted."""
    _finish_failed(project_id, session_id, f"turn-{int(time.time() * 1000)}", "interrupted",
                   "服务重启，这一轮已中断")
    return read_canvas_agent_session(project_id, session_id)
