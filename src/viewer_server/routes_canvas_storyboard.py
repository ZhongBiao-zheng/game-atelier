"""分镜节点的剧本解析（ADR-0038）。解析是计费调用：一次请求只调一次对话模型，失败不重试。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api/canvas")


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
        raise HTTPException(404, "找不到这个画布项目（可能已被删除）") from None


def _http_error(error) -> HTTPException:
    if error.raw is None:
        return HTTPException(error.status, str(error))
    # 中文原因进 message；遮掉密钥的上游原文进 raw，界面放在可展开的详情里。
    return HTTPException(error.status, {"message": str(error), "code": "STORYBOARD_PARSE_FAILED",
                                        "raw": error.raw})


@router.get("/storyboard/models")
def storyboard_models() -> dict:
    """剧本解析可用的对话模型；max_cost_cny 是解析一段的最高花费，无价格为 null。"""
    from character_workflow.lib import canvas_storyboard_parse

    return {"models": canvas_storyboard_parse.candidates()}


@router.post("/projects/{project_id}/storyboard/plan")
def storyboard_plan(project_id: str, body: _Plan) -> dict:
    """不计费：按当前保存的剧本算出要分几段。"""
    from character_workflow.lib import canvas_storyboard_parse

    try:
        return canvas_storyboard_parse.plan(_document(project_id), body.script_node_ids)
    except canvas_storyboard_parse.ParseError as error:
        raise _http_error(error) from None


@router.post("/projects/{project_id}/storyboard/parse")
def storyboard_parse(project_id: str, body: _Parse) -> dict:
    """计费调用：解析一段剧本，只返回镜头草稿，不写画布。"""
    from character_workflow.lib import canvas_storyboard_parse

    try:
        return canvas_storyboard_parse.parse_segment(
            project_id=project_id, document=_document(project_id),
            script_node_ids=body.script_node_ids, segment_index=body.segment_index,
            segment_count=body.segment_count, alias=body.alias, model_id=body.model_id,
            entities=[entity.model_dump() for entity in body.entities],
            style_prefix=body.style_prefix)
    except canvas_storyboard_parse.ParseError as error:
        raise _http_error(error) from None
