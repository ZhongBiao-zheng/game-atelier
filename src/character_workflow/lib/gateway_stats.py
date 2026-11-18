"""团队主机运行汇总（只读）：网关任务量、失败率、排队 / 执行耗时，主机启停与在线时长。

    uv run python -m character_workflow.lib.gateway_stats --days 7
    uv run python -m character_workflow.lib.gateway_stats --since 2026-11-01 --until 2026-11-18 --json

数据目录按常规规则解析（GAME_ATELIER_DATA_ROOT 优先）。日期按本机时区，--until 当天整天计入。
只读 `.runtime/gateway/usage/*.jsonl` 与 `.runtime/host-lifecycle*.jsonl`，不写任何文件。
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from character_workflow.lib import gateway_tasks, host_lifecycle


def _percentile(values: list[float], fraction: float) -> float | None:
    """最近秩法：排序后取第 ceil(p·n) 个。"""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def _spread(values: list[float]) -> dict[str, Any]:
    return {"samples": len(values), "median_s": _percentile(values, 0.5),
            "p95_s": _percentile(values, 0.95)}


def _numbers(rows: list[dict], field: str) -> list[float]:
    return [float(row[field]) for row in rows
            if isinstance(row.get(field), int | float) and not isinstance(row.get(field), bool)]


def _time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else None


def _tasks(start: datetime, end: datetime) -> dict[str, Any]:
    rows = gateway_tasks.read_usage_range(start, end)
    statuses = Counter(str(row.get("status")) for row in rows)
    failed = [row for row in rows if row.get("status") == "failed"]
    finished = len(rows) - statuses.get("canceled", 0)
    by_kind = Counter(str(row.get("error_kind") or "unknown") for row in failed)
    queued = [row for row in rows if row.get("kind") != "text"]  # 文本调用受理即执行，没有排队
    return {
        "count": len(rows),
        "by_status": dict(statuses),
        # 分母不含主动取消的任务。
        "failure_rate": round(len(failed) / finished, 4) if finished else None,
        "failures_by_error_kind": {
            kind: {"count": count, "rate": round(count / finished, 4)}
            for kind, count in by_kind.most_common()
        },
        # 已发给上游却失败、又没有实付金额：上游是否收费确认不了（第三批计费的对账口径）。
        "failed_sent_without_actual_cost": sum(
            1 for row in failed if row.get("sent_to_upstream") is True and row.get("actual_cost_cny") is None),
        "queue": _spread(_numbers(queued, "queue_s")),
        "duration": _spread(_numbers(rows, "duration_s")),
        "rows_without_timing": sum(1 for row in rows if "finished_at" not in row),
    }


def _alive_at() -> datetime | None:
    alive = host_lifecycle.last_alive()
    return alive.astimezone() if alive is not None else None


def _sessions(events: list[dict], now: datetime) -> list[dict[str, Any]]:
    """把事件流配成会话：start 到其后第一条 stop；被下一条 start 截断的按心跳时间截止。"""
    sessions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for event in events:
        at = _time(event.get("time"))
        if at is None:
            continue
        if event["event"] == "start":
            if current is not None:
                end = _time(event.get("previous_last_alive_at")) or current["start"]
                sessions.append({**current, "end": max(end, current["start"]), "ended": "abnormal"})
            current = {"start": at}
        elif current is not None:
            sessions.append({**current, "end": at, "ended": event.get("reason", "normal")})
            current = None
    if current is not None:
        alive = _alive_at()
        fresh = alive is not None and now - alive < timedelta(seconds=2 * host_lifecycle.HEARTBEAT_SECONDS)
        # 心跳还新 = 仍在运行；心跳停了又没有记录 = 进程已不在，按最后心跳截止。
        end = now if fresh else max(alive or current["start"], current["start"])
        sessions.append({**current, "end": end, "ended": "running" if fresh else "unknown"})
    return sessions


def _host(start: datetime, end: datetime, now: datetime) -> dict[str, Any]:
    events = host_lifecycle.read_events()
    starts = [event for event in events if event["event"] == "start"
              and (at := _time(event["time"])) is not None and start <= at <= end]
    sessions = _sessions(events, now)
    online = sum(
        max(0.0, (min(session["end"], end) - max(session["start"], start)).total_seconds())
        for session in sessions
    )
    return {
        "starts": len(starts),
        "abnormal_ends": sum(1 for event in starts if event.get("previous") == "abnormal"),
        "update_restarts": sum(1 for session in sessions if session["ended"] == "update"
                               and start <= session["end"] <= end),
        "service_mode_starts": sum(1 for event in starts if event.get("service_mode")),
        "online_hours": round(online / 3600, 2),
        "range_hours": round((end - start).total_seconds() / 3600, 2),
    }


def summarize(start: datetime, end: datetime, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now().astimezone()
    return {"since": start.isoformat(), "until": end.isoformat(),
            "tasks": _tasks(start, end), "host": _host(start, end, now)}


def _format(summary: dict[str, Any]) -> str:
    tasks, host = summary["tasks"], summary["host"]

    def seconds(value):
        return "—" if value is None else f"{value:.1f}s"

    statuses = ", ".join(f"{key} {value}" for key, value in sorted(tasks["by_status"].items()))
    lines = [
        f"范围 {summary['since']} — {summary['until']}",
        f"任务 {tasks['count']}（{statuses or '无'}）",
        "失败率 " + ("—" if tasks["failure_rate"] is None else f"{tasks['failure_rate']:.1%}"),
    ]
    lines += [f"  {kind} {item['count']}（{item['rate']:.1%}）"
              for kind, item in tasks["failures_by_error_kind"].items()]
    for label, key in (("排队", "queue"), ("执行", "duration")):
        spread = tasks[key]
        lines.append(f"{label} 中位数 {seconds(spread['median_s'])} · P95 {seconds(spread['p95_s'])}"
                     f"（样本 {spread['samples']}）")
    lines.append(f"已发出但失败且无实付 {tasks['failed_sent_without_actual_cost']} 条")
    if tasks["rows_without_timing"]:
        lines.append(f"无耗时字段的旧记录 {tasks['rows_without_timing']} 条")
    lines += [
        f"主机启动 {host['starts']} 次（服务模式 {host['service_mode_starts']}），异常结束 "
        f"{host['abnormal_ends']} 次，更新重启 {host['update_restarts']} 次",
        f"在线 {host['online_hours']} / {host['range_hours']} 小时",
    ]
    return "\n".join(lines)


def _day(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").astimezone()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="团队主机运行汇总（只读）")
    parser.add_argument("--since", help="起始日期 YYYY-MM-DD（本机时区，含当天）")
    parser.add_argument("--until", help="结束日期 YYYY-MM-DD（含当天），默认到现在")
    parser.add_argument("--days", type=int, default=7, help="没给 --since 时向前统计的天数，默认 7")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)
    now = datetime.now().astimezone()
    end = now
    if args.until:
        end = min(_day(args.until) + timedelta(days=1) - timedelta(microseconds=1), now)
    start = _day(args.since) if args.since else end - timedelta(days=args.days)
    if start > end:
        parser.error("--since 晚于 --until")
    summary = summarize(start, end, now)
    print(json.dumps(summary, ensure_ascii=False, indent=2) if args.json else _format(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
