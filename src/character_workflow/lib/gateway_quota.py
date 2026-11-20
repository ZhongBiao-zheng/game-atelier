"""Local calendar-window quotas. Admission and reservation share gateway_tasks._lock."""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import TypedDict

from character_workflow.lib.gateway_keys import GatewayKeyRecord, QuotaPeriod


class QuotaStatus(TypedDict):
    period: QuotaPeriod
    cap_cny: float
    used_cny: float
    reserved_cny: float
    left_cny: float
    resets_at: str | None  # 不重置（none）时为 None


# Text relays register/remove reservations under gateway_tasks._lock (P3).
_inflight: dict[str, tuple[str, float]] = {}
_PERIOD_LABELS = {"day": "今日", "week": "本周", "month": "本月", "none": "累计"}


def _local_now() -> datetime:
    return datetime.now().astimezone()


def window_start(period: QuotaPeriod, now: datetime, since: str | None = None) -> datetime:
    """额度窗口起点（主机本机时区）：自然日 / 周一 00:00 / 自然月 1 日；不重置从 since 起。"""
    if period == "none":
        return datetime.fromisoformat(since).astimezone(now.tzinfo) if since else datetime.min.replace(
            tzinfo=now.tzinfo)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "week":
        return start - timedelta(days=start.weekday())
    if period == "month":
        return start.replace(day=1)
    return start


def window_end(period: QuotaPeriod, now: datetime) -> datetime | None:
    if period == "none":
        return None
    start = window_start(period, now)
    if period == "month":
        return start.replace(year=start.year + 1, month=1) if start.month == 12 else (
            start.replace(month=start.month + 1)
        )
    return start + timedelta(days=7 if period == "week" else 1)


def quota_status(key: GatewayKeyRecord, now: datetime | None = None) -> QuotaStatus | None:
    """这把密钥的额度现状；没设额度时 None。已用按用量行（结算额）算，预占含执行中的任务与文本调用。"""
    from character_workflow.lib import gateway_tasks

    if key.quota is None:
        return None
    now = now or _local_now()
    quota = key.quota
    with gateway_tasks._lock:
        reserved = round(sum(
            task.reserved_cny for task in gateway_tasks._all_tasks()
            if task.key_id == key.id and task.status in ("pending", "running")
        ) + sum(cny for key_id, cny in _inflight.values() if key_id == key.id), 6)
        start = window_start(quota.period, now, quota.since)
        used = round(sum(
            gateway_tasks.charged(row)
            for row in gateway_tasks.read_usage_range(max(start, now - timedelta(days=3660)), now)
            if row.get("key_id") == key.id
        ), 6)
        end = window_end(quota.period, now)
        return QuotaStatus(
            period=quota.period, cap_cny=quota.cap_cny, used_cny=used, reserved_cny=reserved,
            left_cny=max(0, round(quota.cap_cny - used - reserved, 6)),
            resets_at=end.isoformat() if end else None,
        )


def legacy_limits(status: QuotaStatus | None) -> list[dict]:
    """给旧成员看的 `limits` 列表（第 7 批前的形状）：日 / 周 / 月时一条；不重置时为空（旧版不认识）。

    兼容层，下次改 PROTOCOL_VERSION 时删（ADR-0025「额度与范围的形状（第 7 批）」）。"""
    return [] if status is None or status["period"] == "none" else [dict(status)]


def admit(key: GatewayKeyRecord, estimate_cny: float, now: datetime | None = None) -> None:
    """Caller holds gateway_tasks._lock through admission AND saving the reservation."""
    from character_workflow.lib.gateway_tasks import GatewayRequestError

    now = now or _local_now()
    status = quota_status(key, now)
    if status is None:
        return
    spent = round(status["used_cny"] + status["reserved_cny"], 6)
    # 用光（已用 + 预占 ≥ 上限）就一律拒绝，包括估价为 0 的未计价渠道与文本（飙哥 2026-11-18 定）。
    if spent < status["cap_cny"] and round(spent + estimate_cny, 6) <= status["cap_cny"]:
        return
    label = _PERIOD_LABELS[status["period"]]
    if status["resets_at"] is None:
        raise GatewayRequestError(
            429, f"中转额度已用完：{label} ¥{status['cap_cny']:g}（已用 ¥{spent:g}），不会自动重置，请联系主机管理员")
    end = datetime.fromisoformat(status["resets_at"])
    raise GatewayRequestError(
        429, f"中转额度已用完：{label} ¥{status['cap_cny']:g}（已用 ¥{spent:g}），"
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
            "month_charged_cny": round(sum(gateway_tasks.charged(row) for row in rows), 6),
            "month_calls": len(rows),
        }


CALL_TAG_LOOKBACK = timedelta(days=40)


def call_tag_summary(key: GatewayKeyRecord, call_tag: str, now: datetime) -> dict:
    """这把密钥名下带这个关联标记的文本调用：次数与结算额。别的密钥的行一律不算。"""
    from character_workflow.lib import gateway_tasks

    rows = [row for row in gateway_tasks.read_usage_range(now - CALL_TAG_LOOKBACK, now)
            if row.get("key_id") == key.id and row.get("call_tag") == call_tag]
    return {"requests": len(rows),
            "charged_cny": round(sum(gateway_tasks.charged(row) for row in rows), 6)}


def me(key: GatewayKeyRecord, now: datetime | None = None, call_tag: str | None = None) -> dict:
    from character_workflow.lib import gateway_tasks

    now = now or _local_now()
    with gateway_tasks._lock:
        status = quota_status(key, now)
        # quota 是第 7 批的形状。limits 是兼容层：第 7 批前的成员只认 limits 列表（成员端 /me 代理要求它是
        # list，否则不显示额度），主机与成员版本不一致时靠它照常看额度；判定都在主机，与它无关。
        # 移除条件：下次改 atelier_gateway.PROTOCOL_VERSION 时一起删（届时旧成员本来就连不上）。见 ADR-0025。
        result = {"id": key.id, "role": key.role, "name": key.name, "quota": status,
                  "limits": legacy_limits(status), **month_summary(key, now)}
        if call_tag is not None:
            result["call_tag"] = call_tag_summary(key, call_tag, now)
        return result
