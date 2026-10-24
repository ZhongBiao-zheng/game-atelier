"""用量归一化与聚合。纯计算，不读取文件，也不改变任务状态。"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from urllib.parse import quote, urlencode

from .canvas_runs import canvas_numbering_prefix
from .schemas import Job


def local_time(value: str, now: datetime) -> datetime:
    return datetime.fromisoformat(value).astimezone(now.tzinfo)


def range_start(period: str, now: datetime) -> datetime | None:
    if period == "all":
        return None
    days = {"today": 1, "7d": 7, "30d": 30, "90d": 90}[period]
    return now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)


def job_location(job: Job, assignments: dict[str, str]) -> str | None:
    def q(value: str) -> str:
        return quote(value, safe="")
    if job.canvas_project_id:
        return f"/canvas/{q(job.canvas_project_id)}"
    if job.namespace == "studio":
        return "/studio"
    project = job.project_id or assignments.get(job.character_id)
    if job.namespace == "ui" and project:
        return f"/workshop/{q(project)}/ui/{q(job.ui_scheme_id)}/screens/{q(job.screen_id)}"
    if job.namespace == "video" and project:
        return f"/workshop/{q(project)}/video/{q(job.production_id)}"
    if job.character_id:
        base = f"{q(project)}/art" if project else "unassigned"
        return f"/workshop/{base}/characters/{q(job.character_id)}"
    return None


def user_prompt(job: Job) -> str:
    """画布冻结时补在开头的参考素材编号是内部模板，展示时只留画师自己写的内容。"""
    if job.canvas_run is None:
        return job.prompt
    return job.prompt.removeprefix(canvas_numbering_prefix(job.canvas_run.snapshot.inputs))


def mine_records(
    jobs: list[Job], canvas_names: dict[str, str], project_names: dict[str, str],
    assignments: dict[str, str],
) -> list[dict]:
    records = []
    for job in jobs:
        if job.kind not in {"image", "video"} or job.status in {"pending_confirm", "canceled"}:
            continue
        cost = job.params.actual_cost_cny
        if cost is None and job.status != "failed":
            cost = job.params.estimated_cost_cny
        project_id = job.project_id or assignments.get(job.character_id)
        if job.canvas_project_id:
            project_key = f"canvas:{job.canvas_project_id}"
            label = canvas_names.get(job.canvas_project_id, "未归档")
        elif project_id:
            project_key = f"workshop:{project_id}"
            label = project_names.get(project_id, "未归档")
        else:
            project_key, label = "unassigned", "未归档"
        records.append({
            "id": job.job_id, "cost_cny": cost or 0, "at": job.submitted_at,
            "kind": job.kind.value, "model": job.model, "label": label,
            "project": project_key, "source": "lan" if job.provider == "atelier" else "local",
            "failed": job.status == "failed", "prompt": user_prompt(job)[:120],
            "thumb_url": "/api/raw?" + urlencode({"job_id": job.job_id, "path": job.output_paths[0]})
            if job.output_paths else None,
            "href": job_location(job, assignments),
        })
    return records


def team_records(rows: list[dict], available_outputs: set[str]) -> list[dict]:
    return [{
        "id": row.get("task_id", ""), "cost_cny": row.get("charged_cny") or 0,
        "at": row["time"], "kind": row.get("kind", "image"),
        "model": row.get("model_id") or row.get("route_id") or "未知模型",
        "label": row.get("key_name", "未知成员"), "member": row.get("key_id", ""),
        "source": "lan", "failed": row.get("status") == "failed",
        "thumb_url": f"/api/gateway/tasks/{quote(row['task_id'], safe='')}/outputs/0"
        if row.get("task_id") in available_outputs else None, "href": None,
    } for row in rows]


def aggregate_usage(
    records: list[dict], *, scope: str, period: str, now: datetime,
    source: str = "all", member: str | None = None, members: list[dict] | None = None,
) -> dict:
    start = range_start(period, now)
    dated = [(row, local_time(row["at"], now)) for row in records]
    start = start or min((at for _, at in dated if at <= now), default=now).replace(
        hour=0, minute=0, second=0, microsecond=0)
    previous_start = start - (now - start)
    sources = sorted({row["source"] for row, at in dated if start <= at <= now})
    selected = [(row, at) for row, at in dated
                if (scope != "mine" or source == "all" or row["source"] == source)
                and (scope != "team" or not member or row.get("member") == member)]
    current = [(row, at) for row, at in selected if start <= at <= now]
    previous = sum(row["cost_cny"] for row, at in selected if previous_start <= at < start)
    bucket = "day" if period in {"today", "7d", "30d"} else "week"

    def bucket_start(at):
        day = at.replace(hour=0, minute=0, second=0, microsecond=0)
        return day if bucket == "day" else day - timedelta(days=day.weekday())

    trend = {}
    cursor = bucket_start(start)
    while cursor <= now:
        trend[cursor.date().isoformat()] = 0.0
        cursor += timedelta(days=1 if bucket == "day" else 7)
    kinds: dict[str, int] = defaultdict(int)
    rankings = []
    for row, at in current:
        trend[bucket_start(at).date().isoformat()] += row["cost_cny"]
        kind = "image" if row["kind"] in {"image_edit", "layer_split"} else row["kind"]
        kinds[kind] += 1
    for by in (["model", "project"] if scope == "mine" else ["member", "model"]):
        grouped = {}
        for row, _ in current:
            key = row[by]
            item = grouped.setdefault(key, {
                "key": key, "label": row["model"] if by == "model" else row["label"],
                "cost_cny": 0, "count": 0,
            })
            item["cost_cny"] += row["cost_cny"]
            item["count"] += 1
        rankings.append({"by": by, "rows": sorted(
            grouped.values(), key=lambda item: (-item["cost_cny"], item["key"]))[:5]})
    top = []
    for row, at in sorted(current, key=lambda pair: (-pair[0]["cost_cny"], pair[0]["id"]))[:10]:
        item = {key: value for key, value in row.items() if key not in {"project", "member", "failed"}}
        item["at"] = at.isoformat()
        top.append(item)
    return {
        "scope": scope, "range": period, "bucket": bucket,
        "totals": {
            "cost_cny": sum(row["cost_cny"] for row, _ in current),
            "previous_cost_cny": previous if period != "all" else None,
            "count": len(current), "by_kind": dict(kinds),
            "failed": sum(row["failed"] for row, _ in current),
            "active_members": len({row["member"] for row, _ in current}) if scope == "team" else None,
            "member_count": len(members or []) if scope == "team" else None,
        },
        "trend": [{"start": day, "cost_cny": cost} for day, cost in trend.items()],
        "rankings": rankings, "top": top, "sources": sources, "members": members or [],
    }
