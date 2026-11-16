"""分镜插件的服务端模块（宿主插件，ADR-0039）：剧本分段、剧本解析、Agent 镜头摘要。

解析是计费调用：一次请求只调一次对话模型，失败不重试，成功失败都记一条 namespace=assist 的文本任务。
逐镜出图出视频不经过这里：前端按生成计划逐镜调用普通 Canvas Run。
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib.plugin_registry import PluginError

from . import parse, storyboard


class _Entity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["character", "scene", "prop"]
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=1000)


class _Plan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    script_node_ids: list[str] = Field(min_length=1, max_length=8)


class _Parse(_Plan):
    segment_index: int = Field(ge=0, le=200)
    segment_count: int = Field(ge=1, le=200)
    alias: str = Field(max_length=200)
    model_id: str = Field(max_length=200)
    entities: list[_Entity] = Field(default_factory=list, max_length=60)
    style_prefix: str = Field(default="", max_length=2000)


def _document(project_id: str):
    from character_workflow.lib.canvas_projects import read_canvas_document

    try:
        return read_canvas_document(project_id)
    except KeyError:
        raise PluginError("NOT_FOUND", "找不到这个画布项目（可能已被删除）", status=404) from None


def _error(error: parse.ParseError) -> PluginError:
    # 中文原因进 message；遮掉密钥的上游原文进 raw，界面放在可展开的详情里。
    return PluginError("STORYBOARD_PARSE_FAILED", str(error), status=error.status, raw=error.raw)


def register(api) -> None:
    @api.route("POST", "/models")
    def models(ctx, params: dict) -> dict:
        """剧本解析可用的对话模型；max_cost_cny 是解析一段的最高花费，无价格为 null。"""
        return {"models": parse.candidates()}

    @api.route("POST", "/plan")
    def plan(ctx, params: dict) -> dict:
        """不计费：按当前保存的剧本算出要分几段。"""
        body = _Plan.model_validate(params)
        try:
            return parse.plan(_document(ctx.project_id), body.script_node_ids)
        except parse.ParseError as error:
            raise _error(error) from None

    @api.route("POST", "/parse")
    def parse_segment(ctx, params: dict) -> dict:
        """计费调用：解析一段剧本，只返回镜头草稿，不写画布。"""
        body = _Parse.model_validate(params)
        try:
            return parse.parse_segment(
                project_id=ctx.project_id, document=_document(ctx.project_id),
                script_node_ids=body.script_node_ids, segment_index=body.segment_index,
                segment_count=body.segment_count, alias=body.alias, model_id=body.model_id,
                entities=[entity.model_dump() for entity in body.entities],
                style_prefix=body.style_prefix)
        except parse.ParseError as error:
            raise _error(error) from None

    @api.agent_view(storyboard.STORYBOARD_NODE_TYPE)
    def agent_view(document, node) -> dict:
        return storyboard.agent_view(document, node)
