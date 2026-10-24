"""本机用量与网关账本查询，授权由 LOCAL_MANAGEMENT 管理。"""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException

from character_workflow.lib import canvas_projects, gateway_keys, gateway_tasks, jobs, projects
from character_workflow.lib.schemas import UsageResponse
from character_workflow.lib.usage_stats import (
    aggregate_usage, mine_records, range_start, team_records,
)

usage_router = APIRouter(prefix="/api")


@usage_router.get("/usage", response_model=UsageResponse, response_model_exclude_unset=True)
def get_usage(
    scope: Literal["mine", "team"] = "mine",
    range: Literal["today", "7d", "30d", "90d", "all"] = "30d",
    source: Literal["all", "local", "lan"] = "all", member: str | None = None,
) -> dict:
    now = datetime.now().astimezone()
    members = []
    if scope == "mine":
        project_file = projects.read_projects()
        records = mine_records(
            jobs.list_jobs(),
            {project.project_id: project.name for project in canvas_projects.list_canvas_projects()},
            {project.id: project.name for project in project_file.projects}, project_file.assignments,
        )
    else:
        config = gateway_keys.read_config()
        if not config.enabled:
            raise HTTPException(404, "网关未开启")
        members = [{"id": key.id, "name": key.name} for key in config.keys if not key.revoked_at]
        start = range_start(range, now)
        if start is None:
            months = sorted(path.stem for path in gateway_tasks.usage_file("_").parent.glob("*.jsonl"))
            start = datetime.strptime(months[0], "%Y-%m").astimezone() if months else now
        else:
            start -= now - start
        rows = gateway_tasks.read_usage_range(start, now)
        available = set()
        # 只为最贵候选检查产物；聚合仍保留完整账本，不会读取 prompt。
        candidates = [row for row in rows if not member or row.get("key_id") == member]
        current_start = range_start(range, now)
        if current_start:
            candidates = [row for row in candidates
                          if datetime.fromisoformat(row["time"]) >= current_start]
        for row in sorted(candidates, key=lambda row: -(row.get("charged_cny") or 0))[:10]:
            try:
                if gateway_tasks.output_file(row["key_id"], row["task_id"], 0).is_file():
                    available.add(row["task_id"])
            except (gateway_tasks.GatewayRequestError, KeyError):
                pass
        records = team_records(rows, available)
    return aggregate_usage(
        records, scope=scope, period=range, now=now, source=source, member=member, members=members,
    )
