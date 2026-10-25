"""本机用量与网关账本查询，授权由 LOCAL_MANAGEMENT 管理。"""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from character_workflow.lib import canvas_projects, gateway_keys, gateway_tasks, jobs
from character_workflow.lib.schemas import JobParams, UsageResponse, UsageTasksResponse
from character_workflow.lib.usage_stats import (
    aggregate_usage, mine_records, range_start, team_records, usage_tasks,
)

usage_router = APIRouter(prefix="/api")


class PricingEstimateRequest(BaseModel):
    alias: str
    model: str
    kind: Literal["image", "video"]
    params: JobParams = Field(default_factory=JobParams)


@usage_router.post("/pricing/estimate")
def pricing_estimate(body: PricingEstimateRequest) -> dict:
    from character_workflow.lib.generation_pricing import estimate_submission
    from character_workflow.lib.keys import find_by_alias

    key = find_by_alias(body.alias)
    if key is None:
        raise HTTPException(404, "渠道不存在")
    return {"estimated_cost_cny": estimate_submission(
        key, body.model, body.kind, body.params.model_dump(exclude_none=True),
    )}


@usage_router.get("/pricing/tokendance")
def tokendance_pricing() -> dict:
    """TokenDance 价格快照（服务启动时同步），前端估价与服务端冻结共用这一份。"""
    from character_workflow.lib.tokendance_prices import load_snapshot

    return load_snapshot()


@usage_router.get("/usage/key-last-used")
def key_last_used() -> dict[str, str]:
    """供应商列表的「最近使用」：alias → 最近一次提交时间。"""
    return jobs.last_used_by_alias()


def _usage_records(scope: str, period: str, now: datetime) -> tuple[list[dict], list[dict]]:
    members = []
    if scope == "mine":
        records = mine_records(
            jobs.list_jobs(),
            {project.project_id: project.name for project in canvas_projects.list_canvas_projects()},
        )
    else:
        config = gateway_keys.read_config()
        if not config.enabled:
            raise HTTPException(404, "网关未开启")
        members = [{"id": key.id, "name": key.name} for key in config.keys if not key.revoked_at]
        start = range_start(period, now)
        if start is None:
            months = sorted(path.stem for path in gateway_tasks.usage_file("_").parent.glob("*.jsonl"))
            start = datetime.strptime(months[0], "%Y-%m").astimezone() if months else now
        else:
            start -= now - start
        rows = gateway_tasks.read_usage_range(start, now)
        records = team_records(rows, set())
    return records, members


@usage_router.get("/usage", response_model=UsageResponse, response_model_exclude_unset=True)
def get_usage(
    scope: Literal["mine", "team"] = "mine",
    range: Literal["today", "7d", "30d", "90d", "all"] = "30d",
    source: Literal["all", "local", "lan"] = "all", member: str | None = None,
) -> dict:
    now = datetime.now().astimezone()
    records, members = _usage_records(scope, range, now)
    return aggregate_usage(
        records, scope=scope, period=range, now=now, source=source, member=member, members=members,
    )


@usage_router.get("/usage/tasks", response_model=UsageTasksResponse, response_model_exclude_unset=True)
def get_usage_tasks(
    scope: Literal["mine", "team"] = "mine",
    range: Literal["today", "7d", "30d", "90d", "all"] = "30d",
    source: Literal["all", "local", "lan"] = "all", member: str | None = None,
    status: Literal["all", "done", "failed", "unpriced"] = "all",
    offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    now = datetime.now().astimezone()
    records, _ = _usage_records(scope, range, now)
    return usage_tasks(records, scope=scope, period=range, now=now, source=source,
                       member=member, status=status, offset=offset, limit=limit)
