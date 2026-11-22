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

from character_workflow.lib import agent_usage
from character_workflow.lib import canvas_agent_cost as cost
from character_workflow.lib import canvas_agent_layout as layout
from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib import keys, canvas_specs, team_library_specs
from character_workflow.lib.net_env import SOCKS_PROXY_MESSAGE, UNSUPPORTED_SOCKS_PREFIXES
from character_workflow.lib.canvas_agent_models import agent_can_use, chat_base_url
from character_workflow.lib.canvas_agent_schema import (
    MAX_BATCH_GENERATIONS, ApplyChangesInput, CanvasChange, CanvasListModelsInput, CanvasProjectInput,
    CanvasReadMediaInput, CanvasReadSpecInput, CanvasReadVideoFramesInput, CanvasSearchLibraryInput, CanvasSearchTeamInput,
    CurrentRevisionRunInput, GetRunInput,
)
from character_workflow.lib.canvas_agent_sessions import (
    mutate_canvas_agent_session, read_canvas_agent_session, with_appended_messages,
)
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.schemas import (
    CanvasAgentApproval, CanvasAgentMessageCreate, CanvasAgentReference, CanvasAgentSession,
    redact_canvas_agent_private_text as redact,
)
from character_workflow.lib.canvas_tool_common import CanvasToolError

logger = logging.getLogger(__name__)

Notify = Callable[[str, dict], None]

MAX_TURNS = 30
TOOL_OUTPUT_LIMIT = 20_000
DELTA_FLUSH_SECONDS = 0.15
MEDIA_SCHEME = "atelier-media://"
LOCAL = SimpleNamespace(kind="local", session_id="canvas-chat", grant_id=None)

READ_TOOLS = frozenset({"get_canvas", "list_models", "get_run", "check_run", "read_media",
                        "read_video_frames",
                        "load_skill",
                        "read_skill_file", "wait_for_run", "wait_for_runs", "read_spec",
                        "search_library", "update_plan",
                        "search_team"})

INSTRUCTIONS = """你是 Game Atelier 画布里的创作助手，帮游戏美术和策划在无限画布上出图、出视频。

工作方式：
- 先用 get_canvas 看清画布现状，再动手；节点 id、版本 id 都以读到的为准，不要编。
- 生成一张图或一段视频的标准步骤：apply_changes 里 add_surface 建一个空的图片/视频节点 →
  set_draft 写提示词、模型（alias 与 model 是两个独立的字段，都必须来自 list_models；alias 为 null 的那行是「自动」，
  按设定顺序选供应商，优先用它）、参数 → 需要参考图时 connect
  把参考节点连到它 → run_generation 发起生成。一次要出多个节点时，配好全部 draft 后用
  run_generations 一次发起（最多 20 项）；结果逐项返回，部分成功不回滚。之后用 wait_for_runs
  一起等这些 run_id，每个 run 的状态、checks 与失败原因逐项给出。
- 这几步放进同一次 apply_changes：add_surface 时自己指定 node_id（如 cat-1），同一批后面的
  set_draft / connect 用这个 node_id 引用它；节点标题不能当 id 用。
- 用画布上已有的图当参考（用户带进来的节点、上一次出的图）：直接 connect 那个节点到新的生成节点，
  不要 add_media_node 把它复制成新节点再连。
- 需求涉及画布上多个已有角色或元素时（如「他们俩的儿子」「把 A 和 B 放进同一场景」），把相关的
  节点都 connect 到生成节点，每个都作为参考图；数量不超过 list_models 里该模型的 reference_limits.image。
  只连一张会丢掉另一个角色的特征。
- 新节点的位置由系统自动排在上一次出图的右侧、不和其他节点重叠；add_* 的 position 填 {x: 0, y: 0}
  即可，不用自己计算。
- 发起生成后调用 wait_for_run 等结果，结果图会附在工具结果后面给你看（视频附一张联系表），并带上
  checks：尺寸 / 比例、视频时长是否符合配置，有没有透明通道、格式。ok=false 的要向用户指出；之后想再核对用 check_run。看完向用户简短汇报：
  画面是否符合要求、哪里需要改。只有用户明确让你「多试几次 / 迭代到满意」时才自己改提示词重跑。
- 想看画布上已有的某张图，用 read_media，图片同样会附给你。想看视频的画面，用 read_video_frames：
  等间隔取帧拼成一张带时间码的联系表附给你（默认 6 帧，最多 9 帧，可限定时间范围）。
- 图片尺寸：要固定像素写 size（如 1024x1536），按比例写 ratio（可加 resolution），二选一；
  不要同时写，界面按你写的那种显示。
- 对比节点（type=compare）只接两张图：connect 时 slot 填 before 或 after；不填则先 before 后 after，
  指定的一路已有图会被替换。
- list_models 返回空列表时不要建生成节点，告诉用户在输入框的「模型偏好」里选择模型。
- 生成是付费的。不要自动重试失败的生成；失败时告诉用户原因，由用户决定。
- 用户拒绝某个操作时，不要换个方式再做同一件事，先问用户想怎么改。
- 用户提出出图需求时：判断类别 → read_spec(类别) → 同时调 search_library(类别) 与 search_team(类别)，
  按需再搜相关类别（例如弹窗需要按钮和底图）；search_team 还可以用 query 按标题关键词找。
  两边结果放在一起挑：优先 3–5 张同类、0–2 张相关类，总数不超过 list_models 中该模型的
  reference_limits.image。两边都为空或无匹配时直说，按项目和类别规范继续。
- search_team 返回的 asset_id 形如 team:…，直接用在 add_asset_node 上；放上画布即采用成本机资产，
  返回的 team_assets 给出对应的本机资产 ID。
- 选好参考后，在回复里列出每张参考的标题、类别（团队资产注明来自哪个团队库）与一句选择理由。一次 apply_changes 完成：
  add_asset_node 各参考 → add_surface → set_draft → connect 每个参考到生成节点。
  每个参考必须成为可见节点和 input 连线，不得隐藏输入。add_asset_node 返回 asset_nodes 与
  node_aliases；已有同一资产时复用原节点及其冻结版本，同批连线会自动改用真实节点 ID。
  不要为已有参考创建重复节点；只有用户明确要求生成时才 run_generation。
- 要三步以上才能做完的任务（例如批量出多张图、查参考 → 生成 → 核对），开始时用 update_plan 列出待办，
  每完成一步就整份更新一次状态；一两步就能做完的不用写。
- 用户纠正了规律性问题时，用 append_lesson 记下经验，等用户采纳。
- 回复用中文，简短直接。"""


@dataclass(frozen=True)
class ModelScope:
    """会话的创作模式与模型偏好：决定 Agent 能看到、能用哪些生成模型。"""
    creation_mode: str = "all"
    # None = 自动（全部可用）；否则只能用这些（空集 = 不能生成）。
    preferred: frozenset[tuple[str, str]] | None = None

    @classmethod
    def of(cls, session: CanvasAgentSession) -> "ModelScope":
        preferred = None if session.auto_models else frozenset(
            (ref.alias, ref.model) for ref in session.preferred_models)
        return cls(session.creation_mode, preferred)

    def kinds(self) -> tuple[str, ...]:
        return ("image", "video") if self.creation_mode == "all" else (self.creation_mode,)

    def models(self, kind: str) -> list[dict]:
        """该类型可用的生成模型。"""
        if kind not in self.kinds():
            return []
        from character_workflow.lib.canvas_model_catalog import model_rows
        rows = model_rows(kind)
        if self.preferred is None:
            return rows
        return [row for row in rows if (row["alias"], row["model"]) in self.preferred]


ALL_MODELS = ModelScope()

CREATION_MODE_PROMPTS = {
    "all": "",
    "image": "\n\n当前是「图像创作」模式：只生成图片，不要生成视频。",
    "video": "\n\n当前是「视频创作」模式：只生成视频；需要参考图时用画布上已有的图片。",
}


@dataclass
class TurnContext:
    project_id: str
    permission_mode: str
    created_node_ids: set[str] = field(default_factory=set)
    scope: ModelScope = ALL_MODELS
    # 用量记录用：每次模型请求结束记一行（usage_hooks）。
    session_id: str = ""
    model_alias: str = ""
    model: str = ""
    # 工具在本轮里推送面板事件用（update_plan 写完待办推 kind=plan）；测试里不传就不推。
    notify: Notify | None = None


# ── 权限 ────────────────────────────────────────────────────────────────────────

def needs_confirmation(tool: str, mode: str) -> bool:
    """审查模式：所有写操作都确认。Auto：出图、修改、删除都不询问（2026-10-09 定），
    唯一例外是估价超过确认金额的生成（2026-11-19 定，见 generation_over_threshold）。"""
    return tool not in READ_TOOLS and not _plugin_tool_is_read_only(tool) and mode != "auto"


def confirmation_required(project_id: str, tool: str, arguments: dict, mode: str) -> bool:
    """一次工具调用要不要停下来等用户确认。审查模式：写操作都确认。
    Auto：只有这里列出的情况确认（新增一种就在这里加一条，别散到别处）：
    - 生成估价超过确认金额（2026-11-19 定）。删除维持不确认（2026-11-19 飙哥再次确认）。
    - 插件工具声明了 always_confirm（ADR-0043）：PS 联动的脚本执行，每次都确认（2026-11-19 管理会话定）。"""
    if tool.startswith(PLUGIN_TOOL_PREFIX) and plugin_tools().get(tool, {}).get("always_confirm"):
        return True
    if needs_confirmation(tool, mode):
        return True
    if tool == "run_generation":
        return generation_over_threshold(project_id, arguments)
    if tool == "run_generations":
        return generations_over_threshold(project_id, arguments)
    return False


def generation_over_threshold(project_id: str, arguments: dict) -> bool:
    """Auto 下 run_generation 估价超过确认金额时也要确认；未计价不拦。"""
    estimate = cost.generation_estimate(project_id, str(arguments.get("surface_node_id", "")),
                                        _count(arguments))
    return cost.needs_cost_confirmation(estimate["estimate_cny"])


def generations_over_threshold(project_id: str, arguments: dict) -> bool:
    """Auto 下 run_generations 按合计估价判断；未计价的项不计入合计，也不单独拦。"""
    return cost.needs_cost_confirmation(_generations_estimate(project_id, arguments, [])["total"])


def _generations_estimate(project_id: str, arguments: dict, batch_changes: list[dict]) -> dict:
    """{rows: [{node_id, count, model, estimate_cny}], total, unpriced}；total 只算有价格的项，全部未计价时为 None。"""
    rows = []
    for item in _generation_items(arguments):
        try:
            estimate = cost.generation_estimate(project_id, item["surface_node_id"], item["count"],
                                                batch_changes)
        except Exception:  # noqa: BLE001 — 估价只用于展示和金额判断，读不到 draft 按未计价
            logger.warning("canvas agent generation estimate failed", exc_info=True)
            estimate = {"model": None, "estimate_cny": None}
        rows.append({"node_id": item["surface_node_id"], "count": item["count"],
                     "model": estimate["model"], "estimate_cny": estimate["estimate_cny"]})
    priced = [row["estimate_cny"] for row in rows if row["estimate_cny"] is not None]
    return {"rows": rows, "total": round(sum(priced), 6) if priced else None,
            "unpriced": len(rows) - len(priced)}


def _generation_items(arguments: dict) -> list[dict]:
    return [{"surface_node_id": str(item.get("surface_node_id", "")), "count": _count(item)}
            for item in arguments.get("items") or [] if isinstance(item, dict)]


def _count(arguments: dict) -> int:
    value = arguments.get("count", 1)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 1


# ── 插件贡献的工具（ADR-0037）────────────────────────────────────────────────────

PLUGIN_TOOL_PREFIX = "plugin_"


def plugin_tools() -> dict[str, dict]:
    """已启用插件在清单里声明的 Agent 工具。沙箱插件只读清单；宿主插件登记了 hidden_agent_tools 时
    加载它的服务端模块问一次此刻要藏起哪些（ADR-0043）。"""
    from character_workflow.lib import plugin_registry, plugin_server
    enabled = plugin_registry.enabled_ids()
    found: dict[str, dict] = {}
    for record in plugin_registry.scan():
        if record.lock is None or record.plugin_id not in enabled:
            continue
        hidden = plugin_server.hidden_agent_tools(record.plugin_id) if record.lock.contributes.agent_tools else set()
        for tool in record.lock.contributes.agent_tools:
            if tool.name in hidden:
                continue
            name = f"{PLUGIN_TOOL_PREFIX}{record.plugin_id.replace('-', '_')}_{tool.name}"
            found[name] = {
                "plugin_id": record.plugin_id, "tool": tool.name, "route": tool.route,
                "read_only": tool.read_only,
                "description": f"（插件：{record.lock.name}）{tool.description}",
                "parameters": tool.parameters,
                "always_confirm": tool.always_confirm, "summary_field": tool.summary_field,
            }
    return found


def _plugin_tool_is_read_only(tool: str) -> bool:
    return tool.startswith(PLUGIN_TOOL_PREFIX) and bool(plugin_tools().get(tool, {}).get("read_only"))


def _execute_plugin_tool(project_id: str, tool: str, arguments: dict) -> tuple[dict, list[str]]:
    from character_workflow.lib import plugin_server
    from character_workflow.lib.plugin_registry import PluginError
    spec = plugin_tools().get(tool)
    if spec is None:
        raise CanvasToolError("INVALID_TARGET", f"未知工具 {tool}（插件可能已停用）", 422)
    tools.authorize(LOCAL, project_id, "canvas_read" if spec["read_only"] else "canvas_edit")
    try:
        result, created = plugin_server.call(spec["plugin_id"], "POST", spec["route"], project_id=project_id,
                                             origin="agent", params=arguments, caller="画布 Agent")
    except PluginError as error:
        raise CanvasToolError(error.code, error.message, error.status) from None
    # 插件返回的预览图（如 PS 文档的样子）不进工具结果文本：存进临时图片，由 vision 在调模型前附上。
    preview = result.pop("preview", None)
    if preview is not None:
        ref = vision.store_preview(preview)
        if ref is not None:
            result[vision.ATTACH_KEY] = [ref]
    return result, created


# ── 工具执行（同步，跑在线程里）──────────────────────────────────────────────────

def _current_revision(project_id: str) -> int:
    return read_canvas_document(project_id).revision


def _schedule_canvas_job(job_id: str) -> None:
    from character_workflow.lib import canvas_run_queue

    def report(future) -> None:
        # run_canvas_job 已把失败写进 job 与候选
        if future.exception() is not None:
            logger.warning("canvas agent run failed: %s", job_id)

    canvas_run_queue.submit(job_id).add_done_callback(report)


def _with_fresh_revision(project_id: str, call: Callable[[int], dict]) -> dict:
    """确认可能等了很久，画布早已被用户改过：执行时取当前修订号，撞车再读一次。"""
    try:
        return call(_current_revision(project_id))
    except CanvasToolError as error:
        if error.code != "DOCUMENT_CONFLICT":
            raise
        return call(_current_revision(project_id))


def _check_generation_allowed(project_id: str, node_id: str, scope: ModelScope) -> None:
    """发起生成前按会话的创作模式与模型偏好把关（set_draft 不拦，付费的这一步拦）。"""
    node = next((n for n in read_canvas_document(project_id).nodes if n.id == node_id), None)
    if node is None:
        return  # 交给 run 报「找不到这个生成节点」
    draft = getattr(node.data, "generation_draft", None) or getattr(node.data, "draft", None)
    if draft is None or draft.mode not in ("image", "video"):
        return
    if draft.mode not in scope.kinds():
        raise CanvasToolError("INVALID_PARAMETERS",
                            f"当前创作模式不能生成{'视频' if draft.mode == 'video' else '图片'}", 422)
    allowed = {(row["alias"], row["model"]) for row in scope.models(draft.mode)}
    if not allowed:
        raise CanvasToolError("INVALID_PARAMETERS", "模型偏好里没有可用的"
                            f"{'视频' if draft.mode == 'video' else '图片'}模型，请用户先在模型偏好里选择", 422)
    if (draft.alias, draft.model) not in allowed:
        if draft.alias is None:
            raise CanvasToolError("INVALID_PARAMETERS", "set_draft 缺少 alias：alias 与 model 是两个"
                                "字段，都要填 list_models 返回的值", 422)
        raise CanvasToolError("INVALID_PARAMETERS",
                            f"模型 {draft.alias}/{draft.model} 不在可用范围内，请从 list_models 里选", 422)


def _with_draft_aliases(changes: list, scope: ModelScope) -> list:
    """set_draft 漏填 alias 时，在可用模型里按 model 唯一匹配补上。

    不补的话 run 会回落到默认 Key（可能是欠费 / 不含这个模型的那家）。"""
    result = []
    for change in changes:
        if isinstance(change, dict) and change.get("op") == "set_draft" and not change.get("alias") \
                and change.get("mode") in scope.kinds():
            aliases = {row["alias"] for row in scope.models(change["mode"])
                       if row["model"] == change.get("model")}
            if len(aliases) == 1:
                change = {**change, "alias": aliases.pop()}
        result.append(change)
    return result


def execute_tool(project_id: str, tool: str, arguments: dict, scope: ModelScope = ALL_MODELS,
                 created_ids: frozenset[str] = frozenset(),
                 rejected: frozenset[int] = frozenset()) -> tuple[dict, list[str]]:
    """Run one tool call; returns (result, node ids it created). Raises CanvasToolError.

    created_ids: 本会话已建的节点，新节点排位时用来找「上一次出图」。
    rejected: run_generations 里用户在确认卡上拒绝的项（下标）。"""
    if tool == "search_library":
        return tools.search_library(LOCAL, CanvasSearchLibraryInput(project_id=project_id, **arguments)), []
    if tool == "search_team":
        return tools.search_team(LOCAL, CanvasSearchTeamInput(project_id=project_id, **arguments)), []
    if tool == "read_spec":
        return tools.read_spec(LOCAL, CanvasReadSpecInput(project_id=project_id, **arguments)), []
    if tool == "append_lesson":
        return canvas_specs.append_lesson(project_id, arguments["text"]), []
    if tool == "get_canvas":
        return canvas_view(project_id, arguments.get("node_ids")), []
    if tool == "list_models":
        payload = CanvasListModelsInput(project_id=project_id, mode=arguments.get("mode", "image"))
        tools.authorize(LOCAL, payload.project_id, "canvas_read")
        return {"models": scope.models(payload.mode)}, []
    if tool == "check_run":
        return tools.check_run(LOCAL, GetRunInput(project_id=project_id, run_id=arguments["run_id"])), []
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
    if tool == "read_video_frames":
        payload = CanvasReadVideoFramesInput(project_id=project_id, **arguments)
        result = tools.read_video_frames(LOCAL, payload)
        # 联系表落临时文件（.runtime/agent-images/，与插件工具附图同一机制），调模型前再附上。
        ref = vision.store_preview(result.pop("preview"))
        if ref is None:
            raise CanvasToolError("CONTENT_TOO_LARGE", "联系表太大，减少帧数后重试", 413)
        result[vision.ATTACH_KEY] = [ref]
        return result, []
    if tool == "load_skill":
        return {"name": arguments["name"], "content": skills.read_skill(arguments["name"])}, []
    if tool == "read_skill_file":
        return {"path": arguments["path"],
                "content": skills.read_skill_file(arguments["name"], arguments["path"])}, []
    if tool == "apply_changes":
        def apply(revision: int) -> dict:
            # 新节点的位置不用模型给的，按「上一次出图右侧、不重叠」重新排（见 canvas_agent_layout）。
            changes = layout.with_auto_positions(
                read_canvas_document(project_id),
                _with_draft_aliases(arguments.get("changes") or [], scope), created_ids)
            return tools.apply_changes(LOCAL, ApplyChangesInput(
                project_id=project_id, expected_revision=revision, changes=changes))
        result = _with_fresh_revision(project_id, apply)
        return result, list(result.get("node_ids") or [])
    if tool == "run_generation":
        _check_generation_allowed(project_id, arguments["surface_node_id"], scope)

        result, job = tools.run(LOCAL, CurrentRevisionRunInput(
            project_id=project_id, surface_node_id=arguments["surface_node_id"],
            requested_count=arguments.get("count", 1)))
        _schedule_canvas_job(job.job_id)
        return result, [result["result_node_id"]] if result.get("result_node_id") else []
    if tool == "run_generations":
        return tools.submit_batch(_generation_items(arguments),
                                  lambda item: execute_tool(project_id, "run_generation", item, scope),
                                  wait_tool="wait_for_runs", document_tool="get_canvas", rejected=rejected)
    if tool.startswith(PLUGIN_TOOL_PREFIX):
        return _execute_plugin_tool(project_id, tool, arguments)
    raise CanvasToolError("INVALID_TARGET", f"未知工具 {tool}", 422)


def generations_outcome(text: str) -> str | None:
    """run_generations 结果在面板上的一行说明；不是这个形状时返回 None。"""
    try:
        result = json.loads(text)
    except ValueError:
        return None
    if not isinstance(result, dict) or "items" not in result:
        return None
    parts = [f"{label} {result.get(key, 0)} 项"
             for key, label in (("submitted", "已提交"), ("rejected", "已拒绝"), ("failed", "失败"))
             if result.get(key)]
    return "，".join(parts) or "没有执行任何项"


def canvas_view(project_id: str, node_ids: list[str] | None) -> dict:
    """完整画布超过工具输出上限时改回概览，而不是按字符截断：截断会让模型把读不到的节点当成不存在。"""
    view = tools.get_document(LOCAL, CanvasProjectInput(project_id=project_id))
    if node_ids:
        wanted = set(node_ids)
        missing = wanted - {node["id"] for node in view["nodes"]}
        if missing:
            raise CanvasToolError("INVALID_TARGET", f"画布里没有节点 {'、'.join(sorted(missing))}", 422)
        nodes = [node for node in view["nodes"] if node["id"] in wanted]
        version_ids = {node.get("version_id") for node in nodes}
        return {**view, "nodes": nodes,
                "connections": [edge for edge in view["connections"]
                                if wanted & {edge["source_node_id"], edge["target_node_id"]}],
                "media_versions": [m for m in view["media_versions"] if m["version_id"] in version_ids]}
    if len(json.dumps(view, ensure_ascii=False)) <= TOOL_OUTPUT_LIMIT:
        return view
    group_of = {member: node["id"] for node in view["nodes"] for member in node.get("member_node_ids", [])}
    rows = [[node["id"], node["type"], node["title"],
             node["version_id"] is not None if "version_id" in node else None,
             node["draft"] is not None if "draft" in node else None,
             group_of.get(node["id"])] for node in view["nodes"]]
    overview = {"project_id": view["project_id"], "revision": view["revision"], "overview": True,
                "hint": "画布较大，这是概览：省略了版本 ID、文本正文、生成配置、位置和连线 ID。"
                        "has_content 为 false 才表示节点没有内容（分组为 null）；要引用或修改节点前，"
                        "先用 get_canvas 的 node_ids 读取这些节点的完整信息。",
                "node_columns": ["id", "type", "title", "has_content", "has_draft", "group"],
                "nodes": rows,
                "connections": [[edge["source_node_id"], edge["target_node_id"], edge["slot"]]
                                for edge in view["connections"]]}
    # 仍超限时只列最新的节点，并明说省略了多少，避免模型把没列出的节点当成不存在。
    while len(json.dumps(overview, ensure_ascii=False)) > TOOL_OUTPUT_LIMIT and overview["nodes"]:
        keep = len(overview["nodes"]) * 3 // 4
        overview["nodes"] = overview["nodes"][-keep:] if keep else []
        overview["omitted_nodes"] = len(rows) - len(overview["nodes"])
    return overview


def run_tool_safely(project_id: str, tool: str, arguments: dict, scope: ModelScope = ALL_MODELS,
                    created_ids: frozenset[str] = frozenset(),
                    rejected: frozenset[int] = frozenset()) -> tuple[str, list[str]]:
    """Tool output text for the model; errors become text the model can react to."""
    try:
        result, created = execute_tool(project_id, tool, arguments, scope, created_ids, rejected)
    except CanvasToolError as error:
        return f"错误（{error.code}）：{error.message}", []
    except (KeyError, TypeError, ValueError) as error:
        return f"参数错误：{error}", []
    except Exception as error:  # noqa: BLE001 — 穿出去会让 Auto 整轮失败、确认路径返回 500 后被重复执行
        logger.exception("canvas agent tool %s failed unexpectedly", tool)
        return redact(UNEXPECTED_ERROR.format(kind=type(error).__name__)), []
    text = json.dumps(result, ensure_ascii=False)
    if tool != "read_spec" and len(text) > TOOL_OUTPUT_LIMIT:
        text = text[:TOOL_OUTPUT_LIMIT] + "…（已截断）"
    return text, created


# 工具执行中出现未预期的异常：操作可能已部分生效（任务已建、改动已提交、外部脚本已跑），不能重跑。
# 只写异常类型名，不带异常原文（可能含本机路径或密钥）；完整堆栈在日志里。
UNEXPECTED_ERROR = ("错误（UNEXPECTED）：执行时出现未预期错误（{kind}），这个操作可能已经部分生效。"
                    "先用 get_canvas / get_run 查看现状，再告诉用户；不要重试。")
UNEXPECTED_LABEL = "执行出错，可能已部分生效，请查看画布"
INTERRUPTED_OUTPUT = ("服务中断，这个操作已中断、结果未知，可能已经部分生效。"
                      "先用 get_canvas / get_run 查看现状，再告诉用户；不要重试。")


def is_tool_error(text: str) -> bool:
    return text.startswith(("错误", "参数错误"))


def tool_error_label(text: str) -> str:
    """面板上的一行说明；完整的校验信息只给模型看（它要靠这个改参数）。"""
    if text.startswith("参数错误"):
        return "参数不合规，已退回模型修正"
    if text.startswith("错误（UNEXPECTED）"):
        return UNEXPECTED_LABEL
    return text.splitlines()[0][:200]


# ── 工具定义（给模型看的 schema）─────────────────────────────────────────────────

TOOL_SPECS: dict[str, tuple[str, dict]] = {
    "search_library": ("搜索本项目已定稿参考图，返回资产 ID、标题、类别和尺寸，并附缩略图。",
                       {"type": "object", "properties": {
                           "category": {"type": "string"},
                           "limit": {"type": "integer", "minimum": 1, "maximum": 12}}}),
    "search_team": ("搜索本画布挂载的团队库里的图片，按类别或标题关键词，返回资产 ID（team:…）、标题、类别、"
                    "标签、作者和团队库名，并附缩略图。",
                    {"type": "object", "properties": {
                        "query": {"type": "string", "maxLength": 60},
                        "category": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 12}}}),
    "read_spec": ("读取类别规范全文：项目规范与本画布团队库的同名类别规范，冲突以项目为准；不存在返回空文本。",
                  {"type": "object", "required": ["category"],
                   "properties": {"category": {"type": "string"}}}),
    "append_lesson": ("记录一条待审项目经验，用户采纳后才生效。",
                      {"type": "object", "required": ["text"],
                       "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 300}}}),
    "get_canvas": ("读取当前画布：节点、文本、生成配置、连线、媒体版本。不传 node_ids 读整张画布"
                   "（画布较大时返回概览）；node_ids 只能填画布上已有节点的 id，用来读概览里的具体节点。",
                   {"type": "object", "properties": {
                       "node_ids": {"type": "array", "items": {"type": "string"},
                                    "minItems": 1, "maxItems": 20}}}),
    "list_models": ("列出可用于生成配置的图片 / 视频模型（alias + model + 参数能力）。",
                    {"type": "object", "properties": {
                        "mode": {"type": "string", "enum": ["image", "video"]}}}),
    "apply_changes": (
        "在当前画布上批量改动：add_text / add_media_node / add_asset_node / add_surface / set_text / set_draft / "
        "connect / disconnect / move / remove_node。整批原子提交。", {}),
    "run_generation": ("在已写好生成配置的图片 / 视频节点上发起生成（付费）。",
                       {"type": "object", "required": ["surface_node_id"], "properties": {
                           "surface_node_id": {"type": "string"},
                           "count": {"type": "integer", "minimum": 1, "maximum": 4}}}),
    "run_generations": ("一次在多个已写好生成配置的图片 / 视频节点上发起生成（付费）：1–20 项，每项 1–4 张，"
                        "同一节点只能出现一次（要多张用 count）。"
                        "逐项提交，结果逐项返回：submitted / rejected（用户拒绝）/ failed（提交出错）。"
                        "部分成功不回滚，已提交的项照常运行并计费。不要自动重试失败的生成。",
                        {"type": "object", "required": ["items"], "properties": {
                            "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                                "type": "object", "required": ["surface_node_id"], "properties": {
                                    "surface_node_id": {"type": "string"},
                                    "count": {"type": "integer", "minimum": 1, "maximum": 4}}}}}}),
    "get_run": ("查询一次生成的状态与产物版本。",
                {"type": "object", "required": ["run_id"],
                 "properties": {"run_id": {"type": "string"}}}),
    "read_media": ("读取一个媒体版本的元数据（类型、尺寸、时长）。",
                   {"type": "object", "required": ["version_id"],
                    "properties": {"version_id": {"type": "string"}}}),
    "check_run": ("核对一次生成的结果：每个成功的候选给出尺寸 / 比例、视频时长是否符合配置，"
                  "有没有透明通道与格式（ok=null 只报事实）。只读。",
                  {"type": "object", "required": ["run_id"],
                   "properties": {"run_id": {"type": "string"}}}),
    "read_video_frames": ("看一个视频版本的画面：等间隔取 count 帧（1–9，默认 6）拼成一张带时间码的"
                          "联系表附给你；可用 start_ms / end_ms 限定时间范围。只读。",
                          {"type": "object", "required": ["version_id"], "properties": {
                              "version_id": {"type": "string"},
                              "count": {"type": "integer", "minimum": 1, "maximum": 9},
                              "start_ms": {"type": "integer", "minimum": 0},
                              "end_ms": {"type": "integer", "minimum": 1}}}),
    "wait_for_run": ("等一次生成跑完（最多约 4 分钟），返回状态与产物版本；成功的图片会附给你看。",
                     {"type": "object", "required": ["run_id"],
                      "properties": {"run_id": {"type": "string"}}}),
    "wait_for_runs": ("一起等多个生成跑完（1–20 个 run_id，最多约 4 分钟），逐项返回状态、产物版本、checks "
                      "与失败原因。附图最多 4 张：总数不超过 4 张时全附，否则每个 run 只附第一张。只读。",
                      {"type": "object", "required": ["run_ids"], "properties": {
                          "run_ids": {"type": "array", "minItems": 1, "maxItems": 20,
                                      "items": {"type": "string"}}}}),
    "update_plan": ("写下或更新这次任务的待办清单，面板顶部显示给用户：最多 12 条，每条 title + status"
                    "（pending / in_progress / completed），每次整份替换。不改画布，不需要确认。",
                    {"type": "object", "required": ["items"], "properties": {
                        "items": {"type": "array", "maxItems": 12, "items": {
                            "type": "object", "required": ["title", "status"], "properties": {
                                "title": {"type": "string", "minLength": 1, "maxLength": 80},
                                "status": {"type": "string",
                                           "enum": ["pending", "in_progress", "completed"]}}}}}}),
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
        if tool == "append_lesson":
            canvas_specs.validate_lesson(arguments.get("text"))
        if tool == "apply_changes":
            ApplyChangesInput(project_id=project_id, expected_revision=0,
                              changes=arguments.get("changes") or [])
        elif tool == "run_generation":
            CurrentRevisionRunInput(
                project_id=project_id, surface_node_id=arguments.get("surface_node_id", ""),
                requested_count=arguments.get("count", 1))
        elif tool == "run_generations":
            items = arguments.get("items")
            if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH_GENERATIONS:
                return False
            for item in items:
                CurrentRevisionRunInput(
                    project_id=project_id, surface_node_id=item.get("surface_node_id", ""),
                    requested_count=item.get("count", 1))
            if tools.repeated_nodes(_generation_items(arguments)):
                return False
    except (ValidationError, TypeError, ValueError, AttributeError):
        return False
    return True


async def _wait_for_run(project_id: str, run_id: str) -> str:
    """轮询期间不占线程：每次查询进线程池，等待用 asyncio.sleep。"""
    try:
        result = await tools.wait_for_run(LOCAL, GetRunInput(project_id=project_id, run_id=run_id))
        if result["status"] in vision.TERMINAL_STATUSES:
            result = await asyncio.to_thread(_with_run_checks, project_id, run_id, result)
    except CanvasToolError as error:
        return f"错误（{error.code}）：{error.message}"
    return json.dumps(result, ensure_ascii=False)


async def _wait_for_runs(project_id: str, run_ids: list) -> str:
    """多个 run 一起等；每个 run 跑完附上 checks，附图按 vision.pick_attachments 挑。"""
    wanted = list(dict.fromkeys(str(run_id) for run_id in run_ids or []))
    if not 1 <= len(wanted) <= MAX_BATCH_GENERATIONS:
        return f"错误（INVALID_PARAMETERS）：run_ids 需为 1–{MAX_BATCH_GENERATIONS} 个"
    views = await vision.wait_for_runs(
        {run_id: (lambda run_id=run_id: _lookup_run(project_id, run_id)) for run_id in wanted})
    result = await asyncio.to_thread(_runs_result, project_id, views)
    return json.dumps(result, ensure_ascii=False)


def _update_plan(turn: TurnContext, arguments: dict) -> str:
    from pydantic import ValidationError

    from character_workflow.lib import canvas_agent_plans as plans
    try:
        plan = plans.write_plan(turn.project_id, turn.session_id, arguments.get("items"))
    except ValidationError as error:
        return f"参数错误：{error}"
    if turn.notify is not None:
        turn.notify("canvas-agent", {"project_id": turn.project_id, "session_id": turn.session_id,
                                     "kind": "plan"})
    done = sum(1 for item in plan.items if item.status == "completed")
    return json.dumps({"ok": True, "items": len(plan.items), "completed": done}, ensure_ascii=False)


def _lookup_run(project_id: str, run_id: str) -> dict:
    try:
        return tools.get_run(LOCAL, GetRunInput(project_id=project_id, run_id=run_id))
    except CanvasToolError as error:
        return {"run_id": run_id, "lookup_error": f"{error.code}：{error.message}"}


def _runs_result(project_id: str, views: dict[str, dict]) -> dict:
    runs: list[dict] = []
    media: dict[str, list[str]] = {}
    for run_id, view in views.items():
        if view.get("status") in vision.TERMINAL_STATUSES:
            # 联系表只给可能附得上的 run 做：附图最多 4 个 run。
            view = _with_run_checks(project_id, run_id, view,
                                    sheet=len(media) < vision.MAX_ATTACH_IMAGES)
            refs = tools.image_versions(project_id, vision.succeeded_version_ids(view)) + view.pop(vision.ATTACH_KEY, [])
            if refs:
                media[run_id] = refs
        runs.append({"run_id": run_id, **view})
    attached, skipped = vision.pick_attachments(media)
    statuses = [run.get("status") or "lookup_error" for run in runs]
    result: dict = {"runs": runs, "counts": {status: statuses.count(status)
                                              for status in dict.fromkeys(statuses)}}
    if attached:
        result[vision.ATTACH_KEY] = attached
    if sum(len(refs) for refs in media.values()) > len(attached):
        note = f"附图最多 {vision.MAX_ATTACH_IMAGES} 张，每个 run 只附了第一张"
        if skipped:
            note += f"，这些 run 没有附图：{', '.join(skipped)}"
        result["note"] = note + "；要看其余结果用 read_media。"
    return result


def _with_run_checks(project_id: str, run_id: str, result: dict, sheet: bool = True) -> dict:
    result, video = tools.with_run_checks(LOCAL, GetRunInput(project_id=project_id, run_id=run_id),
                                         result, sheet=sheet)
    return _attach_video_preview(result, video)


def _attach_video_preview(result, video):
    if video and (ref := vision.store_preview(video["preview"])):
        result[vision.ATTACH_KEY] = [*result.get(vision.ATTACH_KEY, []), ref]
    return result


def build_tools() -> list:
    from agents import FunctionTool

    def make(name: str, description: str, schema: dict) -> FunctionTool:
        async def invoke(ctx, raw: str) -> str:
            turn: TurnContext = ctx.context
            arguments = json.loads(raw or "{}")
            if name == "wait_for_run":
                return await _wait_for_run(turn.project_id, str(arguments.get("run_id", "")))
            if name == "update_plan":
                return await asyncio.to_thread(_update_plan, turn, arguments)
            if name == "wait_for_runs":
                run_ids = arguments.get("run_ids")
                return await _wait_for_runs(turn.project_id, run_ids if isinstance(run_ids, list) else [])
            text, created = await asyncio.to_thread(run_tool_safely, turn.project_id, name,
                                                    arguments, turn.scope,
                                                    frozenset(turn.created_node_ids))
            turn.created_node_ids.update(created)
            return text

        async def approval(ctx, arguments: dict, _call_id: str) -> bool:
            turn: TurnContext = ctx.context
            if not arguments_valid(turn.project_id, name, arguments):
                return False  # 执行时会因校验失败直接返回错误，没有任何副作用
            return await asyncio.to_thread(confirmation_required, turn.project_id, name,
                                           arguments, turn.permission_mode)

        # 只读工具直接给 False：部分模型（Tuzi 的 Claude）对无参工具传空字符串参数，SDK 判为
        # 「参数无法解析」后会无视回调、一律要求人工确认，读画布也弹确认卡。
        return FunctionTool(name=name, description=description, params_json_schema=schema,
                            on_invoke_tool=invoke, strict_json_schema=False,
                            needs_approval=False if name in READ_TOOLS or name in read_only_plugin_tools
                            else approval)

    # 每次组装 Agent 时读一遍已启用的插件：启停在下一轮对话生效。
    contributed = plugin_tools()
    read_only_plugin_tools = {name for name, spec in contributed.items() if spec["read_only"]}
    return [make(name, desc, _params_schema(name, schema))
            for name, (desc, schema) in TOOL_SPECS.items()] + [
        make(name, spec["description"], spec["parameters"]) for name, spec in contributed.items()]


# ── 历史 ↔ 模型输入 ──────────────────────────────────────────────────────────────

def _media_data_url(project_id: str, version_id: str) -> str | None:
    from character_workflow.lib.canvas_agent_library import ASSET_IMAGE_PREFIX, TEAM_ASSET_PREFIX, reference_preview
    if version_id.startswith(vision.PREVIEW_PREFIX):
        return vision.preview_data_url(version_id)
    if version_id.startswith((ASSET_IMAGE_PREFIX, TEAM_ASSET_PREFIX)):
        return reference_preview(project_id, version_id)
    try:
        media = tools.read_media(LOCAL, CanvasReadMediaInput(project_id=project_id,
                                                             version_id=version_id))
    except CanvasToolError:
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
               "read_video_frames": "查看视频画面", "check_run": "核对生成结果",
               "read_media": "读取媒体信息", "wait_for_run": "等待生成结果",
               "wait_for_runs": "等待多个生成结果", "update_plan": "更新待办",
               "search_library": "查找项目参考", "search_team": "查找团队库参考",
               "read_spec": "读取类别规范"}


def _money(value: float) -> str:
    """与前端 formatGenerationCost 同一写法：两位小数去尾零，不足一分写 <0.01¥。"""
    rounded = round(value + 1e-12, 2)
    if value > 0 and rounded == 0:
        return "<0.01¥"
    return f"{rounded:.2f}".rstrip("0").rstrip(".") + "¥"


def generation_summary(project_id: str, arguments: dict, batch_changes: list[dict]) -> str:
    """确认卡上的生成摘要：节点、张数、模型、估价；未计价照写。"""
    count = _count(arguments)
    node_id = str(arguments.get("surface_node_id", ""))
    try:
        estimate = cost.generation_estimate(project_id, node_id, count, batch_changes)
    except Exception:  # noqa: BLE001 — 摘要只是展示，读不到 draft 也要能弹卡
        logger.warning("canvas agent generation estimate failed", exc_info=True)
        estimate = {"model": None, "estimate_cny": None}
    lines = [f"在节点 {node_id} 上生成 {count} 个结果"]
    if estimate["model"]:
        price = estimate["estimate_cny"]
        lines.append(f"{estimate['model']} · {'未计价' if price is None else '预计 ' + _money(price)}")
        if cost.needs_cost_confirmation(price):
            lines.append(f"超过确认金额 {_money(cost.confirm_above_cny())}")
    return "\n".join(lines)


def generation_rows(project_id: str, arguments: dict, batch_changes: list[dict]) -> list[dict]:
    """批量生成每一项：{index, node_id, title, model, count, estimate_cny}；估价按调用时的 draft 与价格现算。
    确认卡（逐项接口）、待确认摘要、执行记录都用这一份，Auto 判断用同一个 _generations_estimate。"""
    try:
        titles = {node.id: node.title for node in read_canvas_document(project_id).nodes}
    except Exception:  # noqa: BLE001 — 只是展示，读不到就显示节点 id
        titles = {}
    return [{"index": index, "node_id": row["node_id"],
             "title": _one_line(titles.get(row["node_id"], row["node_id"])),
             "model": _one_line(row["model"]) if row["model"] else None,
             "count": row["count"], "estimate_cny": row["estimate_cny"]}
            for index, row in enumerate(_generations_estimate(project_id, arguments, batch_changes)["rows"])]


def _row_line(row: dict) -> str:
    price = row["estimate_cny"]
    return " · ".join([f"{row['index'] + 1}. {row['title']}", row["model"] or "读不到生成配置",
                       f"{row['count']} 张", "未计价" if price is None else f"预计 {_money(price)}"])


def _rows_total(rows: list[dict], label: str) -> str:
    priced = [row["estimate_cny"] for row in rows if row["estimate_cny"] is not None]
    if not priced:
        return f"{label}未计价"
    text = f"{label}预计 {_money(round(sum(priced), 6))}"
    return text + (f"（{len(rows) - len(priced)} 项未计价）" if len(priced) < len(rows) else "")


def generations_summary(project_id: str, arguments: dict, batch_changes: list[dict]) -> str:
    """批量生成待确认的文字摘要：首行总数，每项一行，末尾合计。面板的勾选与重算走逐项接口
    （batch_items），这段文字只在逐项接口拿不到时整段显示，并写进会话里的执行记录。"""
    rows = generation_rows(project_id, arguments, batch_changes)
    lines = [f"批量生成 {len(rows)} 项，共 {sum(row['count'] for row in rows)} 张",
             *(_row_line(row) for row in rows), _rows_total(rows, "合计")]
    total = _generations_estimate(project_id, arguments, batch_changes)["total"]
    if cost.needs_cost_confirmation(total):
        lines.append(f"超过确认金额 {_money(cost.confirm_above_cny())}")
    return "\n".join(lines)


def batch_items(project_id: str, session_id: str, call_id: str) -> dict:
    """确认卡的逐项数据（只在响应里，不落盘）：这次待确认里的这一个批量生成调用，估价按现在的 draft 现算。"""
    session = read_canvas_agent_session(project_id, session_id)
    approval = next((item for item in session.pending_approvals if item.call_id == call_id), None) \
        if session.status == "awaiting_approval" else None
    if approval is None or approval.tool != "run_generations":
        raise CanvasToolError("NOT_FOUND", "没有这个待确认的批量生成", 404)
    batch_changes = [change for item in session.pending_approvals if item.tool == "apply_changes"
                     for change in _arguments(item.arguments).get("changes") or []]
    return {"confirm_above_cny": cost.confirm_above_cny(),
            "items": generation_rows(project_id, _arguments(approval.arguments), batch_changes)}


def generations_record(rows: list[dict], text: str) -> str | None:
    """执行记录：每项标出已提交 / 已拒绝 / 失败，末行是已提交项按执行那一刻估价的合计。
    rows 在执行前现算；text 不是批量结果的形状（整批被退回等）时返回 None。"""
    try:
        result = json.loads(text)
    except ValueError:
        return None
    if not isinstance(result, dict) or not isinstance(result.get("items"), list):
        return None
    status = {item.get("index"): item for item in result["items"] if isinstance(item, dict)}
    labels = {"submitted": "已提交", "rejected": "已拒绝"}
    lines = [generations_outcome(text) or "没有执行任何项"]
    for row in rows:
        item = status.get(row["index"], {})
        mark = labels.get(item.get("status")) or f"失败：{item.get('error') or '未执行'}"
        lines.append(f"{_row_line(row)} — {mark}")
    submitted = [row for row in rows if status.get(row["index"], {}).get("status") == "submitted"]
    lines.append(_rows_total(submitted, "已提交项合计") if submitted else "没有提交任何项")
    return "\n".join(lines)


def _one_line(text: str, limit: int = 40) -> str:
    """确认卡里一项占一行：标题、模型名去掉换行并截到 limit 字。20 项最长约 2300 字，
    不会碰到摘要 4000 字的上限把合计行截掉；也不会让标题里的换行伪造出「序号. 」开头的行。"""
    return " ".join(str(text).split())[:limit]


def summarize_call(tool: str, arguments: dict) -> str:
    if tool == "load_skill":
        return str(arguments.get("name", ""))
    if tool == "read_skill_file":
        # 只显示文件名：带目录的相对路径会被落盘前的隐私替换当成本机路径藏掉。
        return f"{arguments.get('name', '')} · {PurePosixPath(str(arguments.get('path', ''))).name}"
    if tool in READ_LABELS:
        return READ_LABELS[tool]
    if tool.startswith(PLUGIN_TOOL_PREFIX):
        spec = plugin_tools().get(tool, {})
        field = spec.get("summary_field")
        if field and isinstance(arguments.get(field), str):
            # 确认卡显示这个参数的原文（PS 联动：脚本全文），前面一行说明是哪个工具。
            return f"{spec.get('description', tool)}\n{arguments[field]}"
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

def call_tag_for(session: CanvasAgentSession) -> str:
    """经网关时每轮带的关联标记：会话 id + 会话 revision（每次写会话都 +1，同一轮内不变）。"""
    return f"{session.session_id}:{session.revision}"


def start_host_settlement(session: CanvasAgentSession) -> None:
    """经网关的会话：登记这一轮的关联标记，后台向主机查结算额（查不到就留到下一轮或下次打开面板）。"""
    key = keys.find_by_alias(session.model_alias or "")
    if key is None or key.provider != agent_usage.GATEWAY_PROVIDER:
        return

    def work() -> None:
        try:
            agent_usage.add_pending(project_id=session.project_id, session_id=session.session_id,
                                    call_tag=call_tag_for(session), alias=key.alias,
                                    model=session.model or "")
            agent_usage.settle_pending(session.project_id, session.session_id)
        except Exception:  # noqa: BLE001 — 结算只是显示用，失败下次补查
            logger.warning("canvas agent host settlement failed", exc_info=True)

    threading.Thread(target=work, name="agent-host-settlement", daemon=True).start()


def _agent_client(key: keys.KeySpec, protocol: str | None,
                  on_gateway_wait: Callable[[], None] | None, call_tag: str | None):
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    from character_workflow.lib import llm_protocols
    # 局域网网关：直连不读本机代理；SDK 自带重试关掉（读超时也会重发，可能重复计费），
    # 只保留「主机确定没收下才重发」（gateway_text_wait，第 5 批 5-4）。
    if key.provider == "atelier":
        from character_workflow.lib.gateway_text_wait import UpdatingAwareTransport
        transport = UpdatingAwareTransport(on_wait=on_gateway_wait)
    else:
        from character_workflow.lib.direct_text_retry import DirectTextTransport
        from character_workflow.lib.llm_protocols.transport import ProtocolTransport, direct_or_proxied

        transport = DirectTextTransport(direct_or_proxied(chat_base_url(key)))
        if protocol in (llm_protocols.ANTHROPIC_MESSAGES, llm_protocols.GEMINI_GENERATE_CONTENT):
            base_url = (key.base_url or "").strip()
            if not base_url:
                raise CanvasToolError("MODEL_UNAVAILABLE", "供应商缺少 API 地址", 422)
            transport = ProtocolTransport(protocol=protocol, base_url=base_url,
                                          access_key=key.access_key, inner=transport)
    http_client = DefaultAsyncHttpxClient(trust_env=False, transport=transport)
    # 经网关时带关联标记，主机把它记在这把密钥的用量行上，成员每轮结束按它查回结算额。
    headers = {"X-Atelier-Call-Tag": call_tag} if key.provider == "atelier" and call_tag else None
    return AsyncOpenAI(base_url=chat_base_url(key), api_key=key.access_key, max_retries=0,
                       http_client=http_client, default_headers=headers)


def build_agent(session: CanvasAgentSession, on_gateway_wait: Callable[[], None] | None = None,
                call_tag: str | None = None):
    from agents import (
        Agent, ModelSettings, OpenAIChatCompletionsModel, OpenAIResponsesModel, set_tracing_disabled,
    )
    from openai.types.shared import Reasoning

    from character_workflow.lib import llm_protocols
    key = keys.find_by_alias(session.model_alias or "")
    if key is None or not session.model:
        raise CanvasToolError("INVALID_PARAMETERS", "请先选择对话模型", 422)
    if not key.enabled:
        raise CanvasToolError("MODEL_UNAVAILABLE", "供应商已停用", 422)
    spec = next((m for m in key.models if m.id == session.model), None)
    if not agent_can_use(spec):
        raise CanvasToolError("MODEL_UNAVAILABLE", "该模型的接口暂不支持 Agent", 422)
    from character_workflow.lib.llm_protocols import detect
    if detect.agent_tools_unverified(key, spec):
        # 列表里本来就不列；已有会话正选着它、或直接调接口构造时给明确原因与去哪里改。
        raise CanvasToolError("MODEL_UNAVAILABLE", detect.AGENT_UNVERIFIED, 422)
    protocol = spec.protocol if spec is not None else None
    try:
        set_tracing_disabled(True)  # SDK 首次构造 tracing 客户端也会读取代理环境。
        client = _agent_client(key, protocol, on_gateway_wait, call_tag)
    except ValueError as error:
        detail = str(error).lower()
        if not (detail.startswith("unknown scheme for proxy url")
                and any(prefix in detail for prefix in UNSUPPORTED_SOCKS_PREFIXES)):
            raise
        raise CanvasToolError("MODEL_UNAVAILABLE", SOCKS_PROXY_MESSAGE, 422) from None
    settings = ModelSettings(reasoning=Reasoning(effort=session.effort)) if session.effort \
        else ModelSettings()
    # SDK 只为 OpenAI 官方地址默认请求流式用量；兼容地址也必须显式请求末尾的 usage 块。
    if protocol in (None, llm_protocols.OPENAI_CHAT):
        settings.include_usage = True
    return Agent(
        name="canvas-agent",
        instructions=INSTRUCTIONS + CREATION_MODE_PROMPTS[session.creation_mode]
        + skills.skills_prompt() + team_library_specs.agent_instructions(session.project_id),
        tools=build_tools(),
        model=(OpenAIResponsesModel if protocol == llm_protocols.OPENAI_RESPONSES
               else OpenAIChatCompletionsModel)(model=session.model, openai_client=client),
        model_settings=settings,
    )


# 上游明确说模型不支持工具调用的句式（样例与来源见 tests/test_canvas_agent_errors.py）。
_NO_TOOL_SUPPORT = re.compile(
    r"(does not|doesn't|do not) support (tools?|tool[ _-]?(use|calling|calls?)|function[ _-]?call(ing|s)?)"
    r"|(function[ _-]?calling|tool[ _-]?(use|calling)|tools?)( parameter)? (is|are) not (supported|enabled)"
    r"|function calling is not enabled for"
    r"|no endpoints found that support tool use"
    r"|unsupported parameter:? '?tools'?"
    r"|\"?auto\"? tool choice requires --enable-auto-tool-choice"
    r"|不支持(工具|函数|function|tool)",
    re.IGNORECASE)
# 上游明确说模型不能接收图片的句式。
_NO_IMAGE_SUPPORT = re.compile(
    r"(does not|doesn't|do not) support (images?|image inputs?|vision|multi-?modal)"
    r"|(images?|image inputs?|vision|multi-?modal)( content)? (is|are) not supported"
    r"|image_url is only supported by certain models"
    r"|unknown variant .?image_url.?, expected .?text"
    r"|not a (multi-?modal|vision) model"
    r"|不支持(图片|图像|视觉|多模态|image)",
    re.IGNORECASE)


def friendly_error(error: BaseException) -> str:
    from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError, ModelRefusalError
    from openai import APIConnectionError, APIError, APIStatusError, APITimeoutError
    from character_workflow.lib.direct_text_retry import INTERRUPTED, TextInterrupted

    if isinstance(error, TextInterrupted) or isinstance(error.__cause__, TextInterrupted):
        return INTERRUPTED
    if isinstance(error, CanvasToolError):
        return error.message
    if isinstance(error, MaxTurnsExceeded):
        return "这一轮步骤太多，已停下；可以让它继续"
    if isinstance(error, ModelRefusalError):
        return ("模型拒绝了这次请求（服务商内容审核），可以换个说法或换个模型"
                f"（原始报错：{redact(str(error.refusal))[:300]}）")
    if isinstance(error, ModelBehaviorError):
        raw = redact(str(error.message))[:300]
        if "finish_reason='length'" in error.message:
            return f"模型的输出额度在给出内容前用完了，可以重试、关掉思考或换个模型（原始报错：{raw}）"
        if "`response.incomplete`" in error.message or "`response.failed`" in error.message:
            return f"对话模型返回错误：{raw}"
    if isinstance(error, APITimeoutError):
        return "对话模型响应超时"
    if isinstance(error, APIConnectionError):
        return "连不上对话模型的服务商"
    if isinstance(error, APIStatusError):
        message = ""
        if isinstance(error.body, dict):
            detail = error.body.get("error", error.body)
            message = str(detail.get("message") if isinstance(detail, dict) else detail)
        raw = f"{error.status_code} {redact(message)[:300]}"
        # 只有上游明确说「不支持」时才给换模型的提示，并附上原文；签名缺失、调用与结果不配对、
        # 图片太大这类工具 / 图片相关的错误不是模型的问题，原样显示，不猜原因。
        if _NO_IMAGE_SUPPORT.search(message):
            return f"该模型不能看图，请换一个支持图片输入的模型（原始报错：{raw}）"
        if _NO_TOOL_SUPPORT.search(message):
            return f"该模型不支持工具调用，请换一个（原始报错：{raw}）"
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

    from character_workflow.lib.gateway_text_wait import WAITING_LABEL
    agent = build_agent(session, on_gateway_wait=lambda: buffer.tool(WAITING_LABEL),
                        call_tag=call_tag_for(session))
    context = TurnContext(session.project_id, session.permission_mode,
                          set(session.created_node_ids), ModelScope.of(session),
                          session.session_id, session.model_alias or "", session.model or "",
                          buffer.notify)
    result = Runner.run_streamed(agent, history, context=context, max_turns=MAX_TURNS,
                                 hooks=usage_hooks(), run_config=_run_config(session.project_id))
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


def usage_hooks():
    """每次对话模型请求结束就记一行用量：中途失败、被停止的轮次，已经发生的请求也记得上。"""
    from agents import RunHooks

    class UsageHooks(RunHooks):
        async def on_llm_end(self, context, agent, response) -> None:
            await asyncio.to_thread(record_usage, context.context, response.usage)

    return UsageHooks()


def record_usage(turn: TurnContext, usage: Any) -> None:
    details = getattr(usage, "input_tokens_details", None)
    try:
        agent_usage.record_request(
            project_id=turn.project_id, session_id=turn.session_id,
            key=keys.find_by_alias(turn.model_alias), alias=turn.model_alias, model=turn.model,
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            cached_tokens=int(getattr(details, "cached_tokens", 0) or 0),
            cache_write_tokens=int(getattr(details, "cache_write_tokens", 0) or 0),
        )
    except Exception:  # noqa: BLE001 — 记账失败不能打断对话；日志里留原因
        logger.warning("canvas agent usage not recorded", exc_info=True)


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
    finally:
        # 成功、失败、被停止都查：已经发生的请求主机都结算了。
        start_host_settlement(session)

    items = dehydrate(_jsonable(result.to_input_list()), reverse)
    new_items = items[len(base):]
    pending = []
    calls = [interruption.raw_item for interruption in result.interruptions]
    batch_changes = [change for call in calls if call.name == "apply_changes"
                     for change in _arguments(call.arguments).get("changes") or []]
    for call in calls:
        arguments = _arguments(call.arguments)
        if call.name == "run_generation":
            summary = await asyncio.to_thread(generation_summary, project_id, arguments, batch_changes)
        elif call.name == "run_generations":
            summary = await asyncio.to_thread(generations_summary, project_id, arguments, batch_changes)
        else:
            summary = summarize_call(call.name, arguments)
        pending.append(CanvasAgentApproval(
            call_id=call.call_id, tool=call.name, arguments=call.arguments or "{}",
            summary=redact(summary)[:4000],
        ))
    usage = result.context_wrapper.usage
    notes: list[CanvasAgentMessageCreate] = []
    status = "awaiting_approval" if pending else "idle"
    error = None
    if not pending:
        items = _drop_trailing_empty_output(items, len(base))
        new_items = items[len(base):]
        if _ended_without_reply(items):
            # 模型正常结束但最后一次响应既没有文字也没有工具调用（各协议都会出现，SDK 照常结束）。
            # 这一轮执行过工具：只是少了总结，加一条面板提示；没执行过：算失败。都不自动重试。
            if _tools_ran_this_turn(items):
                notes = [CanvasAgentMessageCreate(role="system", turn_id=turn_id, text=NO_SUMMARY_NOTE)]
            else:
                status = "failed"
                error = _empty_reply_message(session, result)
                notes = [CanvasAgentMessageCreate(role="error", turn_id=turn_id, text=error)]

    def update(current: CanvasAgentSession, now: str) -> dict:
        return {
            **with_appended_messages(current, [*display_messages(new_items, turn_id), *notes], now),
            "history": items,
            "pending_approvals": pending,
            "status": status,
            "error": error,
            "created_node_ids": sorted(set(current.created_node_ids) | context.created_node_ids),
            "token_usage": {
                "input_tokens": current.token_usage.input_tokens + usage.input_tokens,
                "output_tokens": current.token_usage.output_tokens + usage.output_tokens,
            },
        }

    await asyncio.to_thread(mutate_canvas_agent_session, project_id, session_id, update)
    notify_session(notify, project_id, session_id)


NO_SUMMARY_NOTE = "模型没有补充说明"


def _drop_trailing_empty_output(items: list, start: int) -> list:
    """去掉这一轮末尾没有内容的模型输出（空的 assistant 消息、单独的 reasoning）：它们留在历史里，
    下一轮发给上游时会变成空内容消息（Anthropic 拒收）或没有后续条目的 reasoning（Responses 拒收）。"""
    end = len(items)
    while end > start:
        item = items[end - 1]
        if not isinstance(item, dict):
            break
        empty_message = (item.get("type") in (None, "message") and item.get("role") == "assistant"
                         and not _output_text(item).strip() and not _has_refusal(item))
        if not (empty_message or item.get("type") == "reasoning"):
            break
        end -= 1
    return items[:end]


def _has_refusal(item: dict) -> bool:
    return any(isinstance(part, dict) and part.get("type") == "refusal"
               for part in item.get("content") or [])


def _ended_without_reply(items: list) -> bool:
    """去掉末尾空输出后，最后一条不是有文字的 assistant 消息 = 这一轮模型最后什么都没说。"""
    if not items:
        return False
    last = items[-1]
    return not (isinstance(last, dict) and last.get("role") == "assistant"
                and (_output_text(last).strip() or _has_refusal(last)))


def _tools_ran_this_turn(items: list) -> bool:
    """最后一条用户消息之后有工具输出：包括确认后续跑时、确认那一步执行的工具。"""
    for item in reversed(items):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "function_call_output":
            return True
        if item.get("role") == "user":
            return False
    return False


def _empty_reply_message(session: CanvasAgentSession, result: Any) -> str:
    responses = getattr(result, "raw_responses", None) or []
    usage = getattr(responses[-1], "usage", None) if responses else None
    output = int(getattr(usage, "output_tokens", 0) or 0)
    details = getattr(usage, "output_tokens_details", None)
    reasoning = int(getattr(details, "reasoning_tokens", 0) or 0)
    tokens = f"输出 {output} token" + (f"，其中思考 {reasoning}" if reasoning else "")
    return f"模型没有返回内容，可以重试或换个模型（{session.model_alias} / {session.model} · {tokens}）"


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
            raise CanvasToolError("SESSION_BUSY", "上一轮还没结束", 409)
        if not current.model or not current.model_alias:
            raise CanvasToolError("INVALID_PARAMETERS", "请先选择对话模型", 422)
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


def resolve_approvals(project_id: str, session_id: str, decisions: dict[str, bool],
                      items: dict[str, list[int]] | None = None) -> CanvasAgentSession:
    """Execute approved calls, reject the rest, append their outputs, mark running.

    items：run_generations 调用里用户勾选执行的项（下标）；没给就是全部执行。

    先认领再执行：在会话锁里把 awaiting_approval 改成 running、清空待确认，之后才执行。执行过的调用
    不能再执行（任务已建、改动已提交），所以并发的第二个裁决拿到 409；执行中出现任何异常都变成
    那个调用的错误输出，会话照常 running 让模型继续。认领后进程退出的，mark_interrupted 补输出。"""
    items = items or {}
    claimed: dict = {}

    def claim(current: CanvasAgentSession, _now: str) -> dict:
        if current.status != "awaiting_approval":
            raise CanvasToolError("SESSION_BUSY", "没有待确认的操作", 409)
        if set(decisions) != {approval.call_id for approval in current.pending_approvals}:
            raise CanvasToolError("INVALID_PARAMETERS", "请对每个待确认操作都给出决定", 422)
        claimed["rejected"] = _rejected_items(current.pending_approvals, items)
        claimed["session"] = current
        return {"status": "running", "pending_approvals": []}

    mutate_canvas_agent_session(project_id, session_id, claim)
    session: CanvasAgentSession = claimed["session"]
    rejected_items: dict[str, frozenset[int]] = claimed["rejected"]
    outputs: list[dict] = []
    results: list[CanvasAgentMessageCreate] = []
    created: set[str] = set()
    for approval in session.pending_approvals:
        record = None
        if decisions[approval.call_id]:
            # 执行记录的估价取执行这一刻的（等待确认期间 draft 可能改过），不复用卡片上的数。
            rows = (generation_rows(project_id, _arguments(approval.arguments), [])
                    if approval.tool == "run_generations" else [])
            text, new_nodes = run_tool_safely(project_id, approval.tool,
                                              _arguments(approval.arguments),
                                              ModelScope.of(session),
                                              frozenset(session.created_node_ids) | created,
                                              rejected_items.get(approval.call_id, frozenset()))
            created.update(new_nodes)
            if is_tool_error(text):
                label = tool_error_label(text)
            else:
                label = "已执行"
                if approval.tool == "run_generations":
                    record = generations_record(rows, text)
        else:
            text, label = "用户拒绝了这个操作。", "已拒绝"
        outputs.append({"type": "function_call_output", "call_id": approval.call_id,
                        "output": text})
        results.append(CanvasAgentMessageCreate(role="tool", title=approval.tool, text=redact(
            record if record is not None else f"{label}\n{approval.summary}")))

    def update(current: CanvasAgentSession, now: str) -> dict:
        # 认领之后状态应仍是 running；万一已被别处改掉，也要把输出写回，不能留下没有输出的调用。
        answered = _answered_call_ids(current.history)
        return {**with_appended_messages(current, results, now),
                "history": [*current.history,
                            *(item for item in outputs if item["call_id"] not in answered)],
                "created_node_ids": sorted(set(current.created_node_ids) | created)}

    return mutate_canvas_agent_session(project_id, session_id, update)


def _rejected_items(approvals: list, items: dict[str, list[int]]) -> dict[str, frozenset[int]]:
    rejected: dict[str, frozenset[int]] = {}
    for approval in approvals:
        if approval.call_id not in items:
            continue
        total = len(_generation_items(_arguments(approval.arguments)))
        chosen = set(items[approval.call_id])
        if approval.tool != "run_generations" or not chosen or not chosen <= set(range(total)):
            raise CanvasToolError("INVALID_PARAMETERS", "逐项选择只适用于批量生成，且至少选一项", 422)
        rejected[approval.call_id] = frozenset(set(range(total)) - chosen)
    return rejected


def _answered_call_ids(history: list) -> set[str]:
    return {item.get("call_id") for item in history
            if isinstance(item, dict) and item.get("type") == "function_call_output"}


def mark_interrupted(project_id: str, session_id: str) -> CanvasAgentSession:
    """running with no live task (server restarted mid-turn) → interrupted.

    确认后执行到一半进程退出时，历史里有调用没有输出：补一条「已中断、可能已部分生效、不要重试」，
    否则下一轮请求会因为缺少工具输出被上游拒绝。"""
    def answer_dangling(current: CanvasAgentSession, _now: str) -> dict:
        answered = _answered_call_ids(current.history)
        dangling = [{"type": "function_call_output", "call_id": item["call_id"],
                     "output": INTERRUPTED_OUTPUT}
                    for item in current.history
                    if isinstance(item, dict) and item.get("type") == "function_call"
                    and item.get("call_id") not in answered]
        return {"history": [*current.history, *dangling]} if dangling else {}

    mutate_canvas_agent_session(project_id, session_id, answer_dangling)
    _finish_failed(project_id, session_id, f"turn-{int(time.time() * 1000)}", "interrupted",
                   "服务重启，这一轮已中断")
    return read_canvas_agent_session(project_id, session_id)
