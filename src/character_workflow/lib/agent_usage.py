"""画布内置 Agent 调对话模型的用量：每次模型请求一行，按本地月份追加到 `.runtime/agent-usage/YYYY-MM.jsonl`。

不记成 Job：每轮对话一个任务文件会让 /api/jobs 线性变慢（实测每个文件约 60µs），画布页在 Agent
每次改画布后都会补拉任务列表。独立文件旧版本不会读，也就不存在旧版读不出的问题。

cost_cny 为 None 表示未计价；经局域网网关（provider=atelier）的请求由主机结算，本机记 None。
cost_source：price_table（本机按同步价算）/ host（主机结算，本机没有金额）/ None（未计价）。
只记统计字段，不记提示词与对话内容。只追加不替换（不轮转），所以锁外读不会撞上 Windows 上
os.replace 的瞬时拒访；追加写在锁内、一条一行写完，读到半行就跳过并计数。
画布或会话删除后记录保留，用量页显示为「已删除的项目」「已删除的对话」。

经网关的会话：每轮对话带关联标记（会话 id:会话 revision），轮次结束后向主机 `/gateway/v1/me?call_tag=`
查回主机的结算额，写成一行 kind=host_settlement、cost_source=host 的结算行；金额只取主机的结算，
成员端不自己算。查不到（主机不可达、主机还没写完用量）就留在 pending-host.json 里，下一轮结束或下次
打开面板时补查；旧主机不认这个参数时放弃补查，界面保持「主机结算」。金额可以晚到，不能错。
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.file_lock import file_lock

GATEWAY_PROVIDER = "atelier"
HOST_SETTLEMENT = "host_settlement"
# 主机一直查不到这个标记的结算（例如请求根本没到主机）就放弃，不无限补查。
PENDING_MAX_AGE = timedelta(days=1)
logger = logging.getLogger(__name__)


def usage_dir() -> Path:
    return data_root.runtime_dir() / "agent-usage"


def usage_file(month: str) -> Path:
    return usage_dir() / f"{month}.jsonl"


def request_cost(key: Any, model_id: str, input_tokens: int, output_tokens: int,
                 cached_tokens: int, cache_write_tokens: int = 0) -> float | None:
    """一次请求的金额。按请求算而不是按整轮算：TokenDance 按本次 prompt 长度分档。"""
    from character_workflow.lib.generation_pricing import estimate_text_cost_cny

    if key is None or key.provider == GATEWAY_PROVIDER:
        return None
    return estimate_text_cost_cny(model_id, input_tokens, output_tokens, key=key,
                                  cached_tokens=cached_tokens, cache_write_tokens=cache_write_tokens)


def record_request(*, project_id: str | None, session_id: str, key: Any, alias: str, model: str,
                   input_tokens: int, output_tokens: int, cached_tokens: int,
                   cache_write_tokens: int = 0, at: datetime | None = None) -> dict:
    moment = (at or datetime.now(timezone.utc)).astimezone()
    provider = getattr(key, "provider", None)
    cost = request_cost(key, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens)
    row = {
        "time": moment.isoformat(), **({"workspace": "studio"} if project_id is None else {}), "project_id": project_id, "session_id": session_id,
        "alias": alias, "model": model, "provider": provider,
        "source": "lan" if provider == GATEWAY_PROVIDER else "local",
        "input_tokens": input_tokens, "output_tokens": output_tokens,
        "cached_tokens": cached_tokens, "cache_write_tokens": cache_write_tokens,
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


# ── 经网关会话的主机结算 ───────────────────────────────────────────────────────────

class HostUnsupported(Exception):
    """主机不认 call_tag（旧版本）：不再补查。"""


def _pending_file() -> Path:
    return usage_dir() / "pending-host.json"


def _read_pending() -> list[dict]:
    try:
        items = json.loads(_pending_file().read_text(encoding="utf-8")).get("items")
    except (OSError, ValueError, AttributeError):
        return []
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _write_pending(items: list[dict]) -> None:
    from character_workflow.lib.atomic_io import atomic_write_text

    usage_dir().mkdir(parents=True, exist_ok=True)
    atomic_write_text(_pending_file(), json.dumps({"items": items}, ensure_ascii=False) + "\n")


def add_pending(*, project_id: str | None, session_id: str, call_tag: str, alias: str, model: str) -> None:
    path = _pending_file()
    usage_dir().mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        items = [item for item in _read_pending() if item.get("call_tag") != call_tag]
        items.append({**({"workspace": "studio"} if project_id is None else {}), "project_id": project_id, "session_id": session_id, "call_tag": call_tag,
                      "alias": alias, "model": model,
                      "at": datetime.now(timezone.utc).astimezone().isoformat()})
        _write_pending(items)


def fetch_host_call_tag(alias: str, call_tag: str) -> dict | None:
    """主机上这个标记的 {requests, charged_cny}；主机不可达返回 None；旧主机抛 HostUnsupported。"""
    import requests

    from character_workflow.lib import keys
    from character_workflow.lib.callers import atelier_gateway

    key = keys.find_by_alias(alias)
    if key is None or key.provider != GATEWAY_PROVIDER or not key.base_url:
        raise HostUnsupported(alias)
    try:
        with atelier_gateway._session() as session:
            response = session.get(key.base_url.rstrip("/") + "/gateway/v1/me",
                                   params={"call_tag": call_tag},
                                   headers={"Authorization": f"Bearer {key.access_key}"}, timeout=(3, 5))
            response.raise_for_status()
            body = response.json()
    except (requests.RequestException, ValueError):
        return None
    found = body.get("call_tag") if isinstance(body, dict) else None
    if not isinstance(found, dict):
        raise HostUnsupported(alias)
    return found


def _settlement_row(item: dict, charged: float) -> dict:
    return {"time": datetime.now(timezone.utc).astimezone().isoformat(),
            **({"workspace": "studio"} if item.get("workspace") == "studio" else {}), "project_id": item["project_id"], "session_id": item["session_id"],
            "alias": item.get("alias"), "model": item.get("model"), "provider": GATEWAY_PROVIDER,
            "source": "lan", "kind": HOST_SETTLEMENT, "call_tag": item["call_tag"],
            "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0,
            "cost_cny": round(charged, 6), "cost_source": "host"}


def settle_pending(project_id: str | None = None, session_id: str | None = None,
                   fetch=fetch_host_call_tag) -> int:
    """补查待结算的标记（只查给定画布 / 会话的，不给则全部）。返回这次写入的结算行数。"""
    path = _pending_file()
    if not path.is_file():
        return 0
    now = datetime.now(timezone.utc)
    settled = 0
    with file_lock(path.with_suffix(".lock")):
        keep = []
        for item in _read_pending():
            wanted = ((project_id is None or item.get("project_id") == project_id)
                      and (session_id is None or item.get("session_id") == session_id))
            if not wanted or not item.get("call_tag"):
                keep.append(item)
                continue
            try:
                found = fetch(item.get("alias") or "", item["call_tag"])
            except HostUnsupported:
                continue  # 旧主机：放弃补查，界面保持「主机结算」
            if found is None or not found.get("requests"):
                # 主机不可达，或还没写完这轮的用量（流式中转在最后一个字节之后才结算）。
                try:
                    fresh = now - datetime.fromisoformat(item["at"]) < PENDING_MAX_AGE
                except (KeyError, TypeError, ValueError):
                    fresh = False
                if fresh:
                    keep.append(item)
                continue
            row = _settlement_row(item, float(found.get("charged_cny") or 0))
            target = usage_file(datetime.fromisoformat(row["time"]).strftime("%Y-%m"))
            with file_lock(target.with_suffix(".lock")):
                with target.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            settled += 1
        _write_pending(keep)
    return settled


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def session_totals(project_id: str | None, session_id: str, since: datetime) -> dict:
    """一个会话的累计用量。cost_cny 合计有价格的请求与主机结算行；unpriced 是没有价格的请求数
    （经网关的请求也算在这里：它们的金额只在主机结算行上）。"""
    found = [row for row in read_rows(since)
             if row.get("project_id") == project_id and row.get("session_id") == session_id]
    rows = [row for row in found if row.get("kind") != HOST_SETTLEMENT]
    priced = [row["cost_cny"] for row in found if isinstance(row.get("cost_cny"), (int, float))]
    sources = {row.get("source") for row in found}
    return {
        "requests": len(rows),
        "input_tokens": sum(_number(row.get("input_tokens")) for row in rows),
        "output_tokens": sum(_number(row.get("output_tokens")) for row in rows),
        "cost_cny": round(sum(priced), 6) if priced else None,
        "unpriced": sum(not isinstance(row.get("cost_cny"), (int, float)) for row in rows),
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
        settlements = [item["cost_cny"] for item in items if item.get("kind") == HOST_SETTLEMENT
                       and isinstance(item.get("cost_cny"), (int, float))]
        costs = [item.get("cost_cny") for item in items if item.get("kind") != HOST_SETTLEMENT]
        if settlements:  # 经网关：金额只取主机结算
            cost = round(sum(settlements), 6)
        else:
            cost = (round(sum(costs), 6)
                    if costs and all(isinstance(value, (int, float)) for value in costs) else None)
        title = session_titles.get((project_id, session_id), "已删除的对话")
        label = canvas_names.get(project_id, "已删除的项目") if project_id else "创作台"
        records.append({
            "id": f"agent:{project_id}:{session_id}:{day}:{alias}:{model}",
            "cost_cny": cost, "at": max(item["time"] for item in items), "alias": alias,
            "status": "done", "duration_s": None, "project_label": label, "member_label": None,
            "kind": "text", "model": model or "", "label": label, "project": f"canvas:{project_id}" if project_id else "studio",
            "source": "lan" if items[0].get("source") == "lan" else "local",
            "failed": False, "prompt": f"Agent 对话：{title}"[:120], "thumb_url": None,
            "href": f"/canvas/{project_id}" if project_id else f"/studio?session={session_id}",
        })
    return records
