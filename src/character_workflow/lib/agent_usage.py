"""画布内置 Agent 调对话模型的用量：每次模型请求一行，按本地月份追加到 `.runtime/agent-usage/YYYY-MM.jsonl`。

不记成 Job：每轮对话一个任务文件会让 /api/jobs 线性变慢（实测每个文件约 60µs），画布页在 Agent
每次改画布后都会补拉任务列表。独立文件旧版本不会读，也就不存在旧版读不出的问题。

cost_cny 为 None 表示未计价；经局域网网关（provider=atelier）的请求由主机结算，本机记 None。
cost_source：price_table（本机按同步价算）/ host（主机结算，本机没有金额）/ None（未计价）。
只记统计字段，不记提示词与对话内容。只追加不替换（不轮转），所以锁外读不会撞上 Windows 上
os.replace 的瞬时拒访；追加写在锁内、一条一行写完，读到半行就跳过并计数。
画布或会话删除后记录保留，用量页显示为「已删除的项目」「已删除的对话」。
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.file_lock import file_lock

GATEWAY_PROVIDER = "atelier"
logger = logging.getLogger(__name__)


def usage_dir() -> Path:
    return data_root.runtime_dir() / "agent-usage"


def usage_file(month: str) -> Path:
    return usage_dir() / f"{month}.jsonl"


def request_cost(key: Any, model_id: str, input_tokens: int, output_tokens: int,
                 cached_tokens: int) -> float | None:
    """一次请求的金额。按请求算而不是按整轮算：TokenDance 按本次 prompt 长度分档。"""
    from character_workflow.lib.generation_pricing import estimate_text_cost_cny

    if key is None or key.provider == GATEWAY_PROVIDER:
        return None
    return estimate_text_cost_cny(model_id, input_tokens, output_tokens, key=key,
                                  cached_tokens=cached_tokens)


def record_request(*, project_id: str, session_id: str, key: Any, alias: str, model: str,
                   input_tokens: int, output_tokens: int, cached_tokens: int,
                   at: datetime | None = None) -> dict:
    moment = (at or datetime.now(timezone.utc)).astimezone()
    provider = getattr(key, "provider", None)
    cost = request_cost(key, model, input_tokens, output_tokens, cached_tokens)
    row = {
        "time": moment.isoformat(), "project_id": project_id, "session_id": session_id,
        "alias": alias, "model": model, "provider": provider,
        "source": "lan" if provider == GATEWAY_PROVIDER else "local",
        "input_tokens": input_tokens, "output_tokens": output_tokens,
        "cached_tokens": cached_tokens,
        "cost_cny": cost,
        "cost_source": "host" if provider == GATEWAY_PROVIDER
        else "price_table" if cost is not None else None,
    }
    path = usage_file(moment.strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def _read(month: str) -> tuple[list[dict], int]:
    """逐行读：(可用的行, 跳过的行数)。截断、乱码、不是对象或没有时间的行跳过。"""
    path = usage_file(month)
    if not path.is_file():
        return [], 0
    rows, skipped = [], 0
    for raw in path.read_bytes().splitlines():
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except ValueError:
            row = None
        if isinstance(row, dict) and isinstance(row.get("time"), str):
            rows.append(row)
        else:
            skipped += 1
    return rows, skipped


def _months() -> list[str]:
    folder = usage_dir()
    return sorted(path.stem for path in folder.glob("*.jsonl")) if folder.is_dir() else []


def read_rows(start: datetime | None = None) -> list[dict]:
    """start 之后（含）的行；start 为 None 读全部。"""
    first = start.astimezone().strftime("%Y-%m") if start else ""
    rows, skipped = [], 0
    for month in _months():
        if month < first:
            continue
        month_rows, month_skipped = _read(month)
        skipped += month_skipped
        for row in month_rows:
            try:
                at = datetime.fromisoformat(row["time"])
            except ValueError:
                skipped += 1
                continue
            if start is None or at >= start:
                rows.append(row)
    if skipped:
        logger.warning("agent usage: skipped %d unreadable line(s)", skipped)
    return rows


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def session_totals(project_id: str, session_id: str, since: datetime) -> dict:
    """一个会话的累计用量。cost_cny 只合计有价格的请求；unpriced 是没有价格的请求数。"""
    rows = [row for row in read_rows(since)
            if row.get("project_id") == project_id and row.get("session_id") == session_id]
    priced = [row["cost_cny"] for row in rows if isinstance(row.get("cost_cny"), (int, float))]
    sources = {row.get("source") for row in rows}
    return {
        "requests": len(rows),
        "input_tokens": sum(_number(row.get("input_tokens")) for row in rows),
        "output_tokens": sum(_number(row.get("output_tokens")) for row in rows),
        "cost_cny": round(sum(priced), 6) if priced else None,
        "unpriced": len(rows) - len(priced),
        "source": "lan" if sources == {"lan"} else "local" if sources <= {"local"} else "mixed",
    }


def usage_records(rows: list[dict], session_titles: dict[tuple[str, str], str],
                  canvas_names: dict[str, str], now: datetime) -> list[dict]:
    """用量页「我的」记录：同一会话、同一天、同一模型的请求合成一条，避免一轮几十次请求刷满任务表。"""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for row in rows:
        try:
            day = datetime.fromisoformat(row["time"]).astimezone(now.tzinfo).date().isoformat()
        except ValueError:
            continue
        groups[(row.get("project_id"), row.get("session_id"), day,
                row.get("alias"), row.get("model"))].append(row)
    records = []
    for (project_id, session_id, day, alias, model), items in groups.items():
        costs = [item.get("cost_cny") for item in items]
        cost = (round(sum(costs), 6)
                if all(isinstance(value, (int, float)) for value in costs) else None)
        title = session_titles.get((project_id, session_id), "已删除的对话")
        label = canvas_names.get(project_id, "已删除的项目")
        records.append({
            "id": f"agent:{project_id}:{session_id}:{day}:{alias}:{model}",
            "cost_cny": cost, "at": max(item["time"] for item in items), "alias": alias,
            "status": "done", "duration_s": None, "project_label": label, "member_label": None,
            "kind": "text", "model": model or "", "label": label, "project": f"canvas:{project_id}",
            "source": "lan" if items[0].get("source") == "lan" else "local",
            "failed": False, "prompt": f"Agent 对话：{title}"[:120], "thumb_url": None,
            "href": f"/canvas/{project_id}" if project_id else None,
        })
    return records
