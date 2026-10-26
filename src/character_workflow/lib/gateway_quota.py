"""Local calendar-window quotas. Admission and reservation share gateway_tasks._lock."""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import TypedDict

from character_workflow.lib.gateway_keys import GatewayKeyRecord, LimitPeriod


class LimitStatus(TypedDict):
    period: LimitPeriod
    cap_cny: float
    used_cny: float
    reserved_cny: float
    left_cny: float
    resets_at: str


# Text relays register/remove reservations under gateway_tasks._lock (P3).
_inflight: dict[str, tuple[str, float]] = {}


def _local_now() -> datetime:
    return datetime.now().astimezone()


def window_start(period: LimitPeriod, now: datetime) -> datetime:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "week":
        return start - timedelta(days=start.weekday())
    if period == "month":
        return start.replace(day=1)
    return start


def window_end(period: LimitPeriod, now: datetime) -> datetime:
    start = window_start(period, now)
    if period == "month":
        return start.replace(year=start.year + 1, month=1) if start.month == 12 else (
            start.replace(month=start.month + 1)
        )
    return start + timedelta(days=7 if period == "week" else 1)


def usage_summary(key: GatewayKeyRecord, now: datetime | None = None) -> list[LimitStatus]:
    from character_workflow.lib import gateway_tasks

    now = now or _local_now()
    with gateway_tasks._lock:
        reserved = round(sum(
            task.reserved_cny for task in gateway_tasks._all_tasks()
            if task.key_id == key.id and task.status in ("pending", "running")
        ) + sum(cny for key_id, cny in _inflight.values() if key_id == key.id), 6)
        result = []
        for limit in key.limits:
            end = window_end(limit.period, now)
            used = round(sum(
                row.get("charged_cny", 0) or 0
                for row in gateway_tasks.read_usage_range(window_start(limit.period, now), now)
                if row.get("key_id") == key.id
            ), 6)
            result.append(LimitStatus(
                period=limit.period, cap_cny=limit.cap_cny, used_cny=used,
                reserved_cny=reserved, left_cny=max(0, round(limit.cap_cny - used - reserved, 6)),
                resets_at=end.isoformat(),
            ))
        return result


def admit(key: GatewayKeyRecord, estimate_cny: float, now: datetime | None = None) -> None:
    """Caller holds gateway_tasks._lock through admission AND saving the reservation."""
    from character_workflow.lib.gateway_tasks import GatewayRequestError

    now = now or _local_now()
    exceeded = [row for row in usage_summary(key, now)
                if round(row["used_cny"] + row["reserved_cny"] + estimate_cny, 6) > row["cap_cny"]]
    if not exceeded:
        return
    limit = max(exceeded, key=lambda row: datetime.fromisoformat(row["resets_at"]))
    end = datetime.fromisoformat(limit["resets_at"])
    label = {"day": "今日", "week": "本周", "month": "本月"}[limit["period"]]
    amount = round(limit["used_cny"] + limit["reserved_cny"], 6)
    raise GatewayRequestError(
        429, f"中转额度已用完：{label} ¥{limit['cap_cny']:g}（已用 ¥{amount:g}），"
             f"{end:%m-%d %H:%M} 重置",
        retry_after=max(1, math.ceil(end.timestamp() - now.timestamp())),
    )


def month_summary(key: GatewayKeyRecord, now: datetime | None = None) -> dict:
    from character_workflow.lib import gateway_tasks

    now = now or _local_now()
    with gateway_tasks._lock:
        rows = [row for row in gateway_tasks.read_usage_range(window_start("month", now), now)
                if row.get("key_id") == key.id]
        return {
            "month_charged_cny": round(sum(row.get("charged_cny", 0) or 0 for row in rows), 6),
            "month_calls": len(rows),
        }


def me(key: GatewayKeyRecord, now: datetime | None = None) -> dict:
    from character_workflow.lib import gateway_tasks

    now = now or _local_now()
    with gateway_tasks._lock:
        return {"id": key.id, "role": key.role, "name": key.name, "limits": usage_summary(key, now), **month_summary(key, now)}
