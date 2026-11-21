"""第 7 批 7-B：网关密钥额度改成「一个金额 + 一个周期」（每天 / 每周 / 每月 / 不重置）。

周期按主机本机时区；每周从周一 00:00 起算（飙哥 2026-11-20 定）；不重置从 since 起累计。
旧数据的多条 limits 读入时转成一条（一条原样转，多条取周期最长并记日志），旧字段不保留。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks
from character_workflow.lib.gateway_keys import GatewayKeyRecord, GatewayQuota
from character_workflow.lib.gateway_tasks import GatewayRequestError
from viewer_server.gateway_app import create_gateway_app

TZ = ZoneInfo("Asia/Taipei")


def _record(**fields):
    return GatewayKeyRecord.model_validate({
        "id": "k1", "name": "小王", "token_sha256": "0" * 64, "created_at": "2026-11-01T00:00:00+00:00",
        **fields})


def _usage(at, key_id, charged):
    path = gateway_tasks.usage_file(at.strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps({"time": at.isoformat(), "key_id": key_id, "charged_cny": charged}) + "\n")


# ---------------------------------------------------------------- 旧数据


@pytest.mark.parametrize(("limits", "expected"), [
    ([], None),
    ([{"period": "day", "cap_cny": 5}], ("day", 5)),
    ([{"period": "week", "cap_cny": 20}], ("week", 20)),
    ([{"period": "day", "cap_cny": 5}, {"period": "month", "cap_cny": 100}], ("month", 100)),
    ([{"period": "week", "cap_cny": 20}, {"period": "day", "cap_cny": 5}], ("week", 20)),
])
def test_old_limits_convert_to_one_quota(limits, expected, caplog):
    with caplog.at_level(logging.WARNING, logger="character_workflow.lib.gateway_keys"):
        record = _record(limits=limits)
    if expected is None:
        assert record.quota is None
    else:
        assert (record.quota.period, record.quota.cap_cny) == expected and record.quota.since
    assert ("旧额度" in caplog.text) is (len(limits) > 1)
    assert "limits" not in record.model_dump()


def test_old_config_file_is_read_and_written_back_in_the_new_shape(isolated_data_root):
    record, _token = gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"][0].pop("quota", None)
    raw["keys"][0]["limits"] = [{"period": "day", "cap_cny": 5}, {"period": "month", "cap_cny": 50}]
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = gateway_keys.read_config().keys[0]
    assert (loaded.quota.period, loaded.quota.cap_cny) == ("month", 50)
    read_back = json.loads(path.read_text(encoding="utf-8"))["keys"][0]  # 读入本身就写回，不等下一次修改
    assert "limits" not in read_back and read_back["quota"]["period"] == "month"
    gateway_keys.update_key(record.id, name="小王2")
    saved = json.loads(path.read_text(encoding="utf-8"))["keys"][0]
    assert "limits" not in saved and saved["quota"]["period"] == "month"


# ---------------------------------------------------------------- 周期窗口（主机本机时区）


@pytest.mark.parametrize(("now", "period", "start", "end"), [
    # 周日 23:59 仍在本周（周一起算），周一 00:00 是新的一周。
    (datetime(2026, 11, 22, 23, 59, tzinfo=TZ), "week", "2026-11-16T00:00:00+08:00", "2026-11-23T00:00:00+08:00"),
    (datetime(2026, 11, 23, 0, 0, tzinfo=TZ), "week", "2026-11-23T00:00:00+08:00", "2026-11-30T00:00:00+08:00"),
    (datetime(2026, 11, 30, 23, 59, tzinfo=TZ), "month", "2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"),
    (datetime(2026, 12, 31, 12, 0, tzinfo=TZ), "month", "2026-12-01T00:00:00+08:00", "2027-01-01T00:00:00+08:00"),
    (datetime(2026, 11, 20, 0, 0, tzinfo=TZ), "day", "2026-11-20T00:00:00+08:00", "2026-11-21T00:00:00+08:00"),
])
def test_windows_follow_the_host_calendar_with_monday_weeks(now, period, start, end):
    assert gateway_quota.window_start(period, now).isoformat() == start
    assert gateway_quota.window_end(period, now).isoformat() == end


def test_no_reset_counts_everything_since_the_quota_was_set(isolated_data_root, monkeypatch):
    now = datetime(2026, 11, 20, 12, tzinfo=TZ)
    monkeypatch.setattr(gateway_quota, "_local_now", lambda: now)
    since = datetime(2026, 10, 15, 9, tzinfo=TZ)
    key = _record(quota={"cap_cny": 10, "period": "none", "since": since.isoformat()})
    _usage(since - timedelta(hours=1), "k1", 4)  # 设额度之前的不算
    _usage(since + timedelta(days=1), "k1", 3)   # 上个月的也算（不重置）
    _usage(now - timedelta(hours=1), "k1", 2)
    status = gateway_quota.quota_status(key, now)
    assert status["used_cny"] == 5 and status["left_cny"] == 5 and status["resets_at"] is None


# ---------------------------------------------------------------- since 的写法


def test_since_is_kept_when_only_the_amount_changes_and_reset_when_the_period_changes(isolated_data_root, monkeypatch):
    ticks = iter(f"2026-11-20T00:00:{second:02d}+00:00" for second in range(60))
    monkeypatch.setattr(gateway_keys, "_now", lambda: next(ticks))  # 每次取时间都不同，才能分清「沿用」与「重置」
    record, _token = gateway_keys.create_key("小王", {"cap_cny": 10, "period": "none"})
    first = record.quota.since
    assert first
    raised = gateway_keys.update_key(record.id, quota={"cap_cny": 20, "period": "none"})
    assert raised.quota.since == first and raised.quota.cap_cny == 20  # 加额：累计不清零
    switched = gateway_keys.update_key(record.id, quota={"cap_cny": 20, "period": "week"})
    assert switched.quota.period == "week" and switched.quota.since > first
    back = gateway_keys.update_key(record.id, quota={"cap_cny": 20, "period": "none"})
    assert back.quota.since > switched.quota.since  # 改回不重置：从现在重新累计
    assert gateway_keys.update_key(record.id, quota=None).quota is None


@pytest.mark.parametrize("bad", [
    {"cap_cny": 0, "period": "day"}, {"cap_cny": -1, "period": "day"},
    {"cap_cny": 1_000_001, "period": "day"}, {"cap_cny": 5, "period": "year"},
    {"cap_cny": float("nan"), "period": "day"}, {"cap_cny": 5, "period": "day", "extra": 1},
])
def test_invalid_quota_is_rejected(bad):
    with pytest.raises(ValueError):
        GatewayQuota.model_validate(bad)


# ---------------------------------------------------------------- 准入与 /me


def test_no_reset_quota_used_up_says_it_will_not_reset(isolated_data_root):
    now = datetime(2026, 11, 20, 12, tzinfo=TZ)
    key = _record(quota={"cap_cny": 1, "period": "none", "since": (now - timedelta(days=40)).isoformat()})
    _usage(now - timedelta(days=30), "k1", 1)
    with pytest.raises(GatewayRequestError) as error:
        gateway_quota.admit(key, 0, now)
    assert error.value.status == 429 and "不会自动重置" in str(error.value)


def test_day_only_quota_admits_until_today_is_spent(isolated_data_root):
    now = datetime(2026, 11, 20, 12, tzinfo=TZ)
    key = _record(quota={"cap_cny": 1, "period": "day", "since": now.isoformat()})
    _usage(now - timedelta(days=1), "k1", 5)  # 昨天花的不占今天
    gateway_quota.admit(key, 0.5, now)
    _usage(now - timedelta(hours=1), "k1", 1)
    with pytest.raises(GatewayRequestError) as error:
        gateway_quota.admit(key, 0, now)
    assert "今日" in str(error.value) and "11-21 00:00 重置" in str(error.value)


@pytest.mark.parametrize(("quota", "legacy"), [
    ({"cap_cny": 5, "period": "day"}, ["day"]),
    ({"cap_cny": 5, "period": "none"}, []),
    (None, []),
])
def test_me_carries_quota_and_the_old_limits_list_for_old_members(isolated_data_root, quota, legacy):
    record, token = gateway_keys.create_key("小王", quota)
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    body = client.get("/gateway/v1/me").json()
    assert (body["quota"] is None) is (quota is None)
    if quota:
        assert body["quota"]["period"] == quota["period"] and body["quota"]["cap_cny"] == 5
    assert [item["period"] for item in body["limits"]] == legacy
