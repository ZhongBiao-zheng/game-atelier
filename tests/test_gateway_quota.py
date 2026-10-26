"""P1: calendar windows, atomic money admission, permissions and private views."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import threading
import time
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from character_workflow.lib import (
    callers, gateway_access, gateway_keys, gateway_quota, gateway_tasks, keys, model_routes,
)
from viewer_server.gateway_app import create_gateway_app
from tests.test_gateway import _dispatch, _seed_keys, _submit

TZ = ZoneInfo("Asia/Taipei")
NOW = datetime(2026, 11, 1, 12, tzinfo=TZ)  # Sunday, week begins in October.


@pytest.fixture(autouse=True)
def isolated_state(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    monkeypatch.setattr(gateway_tasks, "_now", lambda: NOW)
    monkeypatch.setattr(gateway_quota, "_local_now", lambda: NOW)
    yield
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()


@pytest.fixture
def owner():
    _seed_keys()
    return gateway_keys.create_key("小王", [
        {"period": "day", "cap_cny": 1}, {"period": "week", "cap_cny": 2},
        {"period": "month", "cap_cny": 3},
    ])[0]


def submit(owner, nonce="one", **kwargs):
    return gateway_tasks.submit(owner, idempotency_key=nonce, model="gpt-image-2",
                                prompt="private prompt", n=1, size=None, params={},
                                files={}, **kwargs)


def client_for(owner):
    record, token = gateway_keys.create_key(
        "http", owner.limits, owner.allowed_models, owner.allowed_aliases,
    )
    return TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"}), record


def write_usage(at, key_id, charged):
    path = gateway_tasks.usage_file(at.strftime("%Y-%m"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps({"time": at.isoformat(), "key_id": key_id,
                                 "charged_cny": charged}) + "\n")


@pytest.mark.parametrize("period,start,end", [
    ("day", "2026-11-01T00:00:00+08:00", "2026-11-02T00:00:00+08:00"),
    ("week", "2026-10-26T00:00:00+08:00", "2026-11-02T00:00:00+08:00"),
    ("month", "2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"),
])
def test_calendar_windows(period, start, end):
    assert gateway_quota.window_start(period, NOW).isoformat() == start
    assert gateway_quota.window_end(period, NOW).isoformat() == end


@pytest.mark.parametrize("now,period,end", [
    ("2026-11-02T00:00:00+08:00", "week", "2026-11-09T00:00:00+08:00"),
    ("2026-12-01T00:00:00+08:00", "month", "2027-01-01T00:00:00+08:00"),
    ("2028-02-29T23:59:59+08:00", "month", "2028-03-01T00:00:00+08:00"),
])
def test_reset_boundaries(now, period, end):
    assert gateway_quota.window_end(period, datetime.fromisoformat(now)).isoformat() == end


def test_windows_include_boundary_and_cross_month_week(owner):
    write_usage(datetime(2026, 10, 26, tzinfo=TZ) - timedelta(microseconds=1), owner.id, 100)
    write_usage(datetime(2026, 10, 26, tzinfo=TZ), owner.id, .2)
    write_usage(datetime(2026, 10, 31, 23, 59, tzinfo=TZ), owner.id, .3)
    write_usage(datetime(2026, 11, 1, tzinfo=TZ), owner.id, .4)
    write_usage(NOW, "other", 100)
    write_usage(NOW + timedelta(seconds=1), owner.id, 100)
    assert [r["used_cny"] for r in gateway_quota.usage_summary(owner)] == [.4, .9, .4]
    assert gateway_quota.month_summary(owner) == {"month_charged_cny": .4, "month_calls": 1}


def test_reservation_in_every_window_includes_text_and_survives_midnight(owner):
    task = submit(owner)
    gateway_quota._inflight["text-1"] = (owner.id, .2)
    gateway_quota._inflight["other"] = ("other", 50)
    rows = gateway_quota.usage_summary(owner, NOW + timedelta(days=1))
    assert [r["reserved_cny"] for r in rows] == [.28, .28, .28]
    assert task.estimated_cny == task.reserved_cny == .08
    gateway_tasks.cancel(owner.id, task.task_id)
    assert gateway_quota.usage_summary(owner)[0]["reserved_cny"] == .2


@pytest.mark.parametrize("status,actual,expected", [
    ("done", None, .08), ("failed", None, 0), ("canceled", None, 0),
    ("done", .05, .05), ("failed", .04, .04), ("canceled", .03, .03),
])
def test_settlement_and_release(owner, status, actual, expected):
    task = submit(owner)
    done = gateway_tasks._finish(task, status=status, actual_cost_cny=actual)
    assert done.charged_cny == expected
    row = gateway_quota.usage_summary(owner)[0]
    assert (row["used_cny"], row["reserved_cny"]) == (expected, 0)
    gateway_tasks._finish(task, status=status, actual_cost_cny=actual)
    assert gateway_quota.month_summary(owner)["month_calls"] == 1


def test_usage_fields_and_member_trail(owner, monkeypatch):
    from character_workflow.lib.callers.openai_image import OpenAIImageError

    calls = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(calls, {"A": OpenAIImageError("api 401")}))
    done = gateway_tasks.run_task(submit(owner))
    [row] = gateway_tasks.read_usage("2026-11")
    assert row["member_trail"] == ["A", "B"]
    assert row["kind"] == "image" and row["charged_cny"] == .08
    assert row["estimated_cny"] == .08
    assert row["input_tokens"] is row["output_tokens"] is row["duration"] is None
    assert "prompt" not in row and done.status == "done"


def test_restart_releases_pending_and_running(owner):
    submit(owner)
    second = submit(owner, "two")
    gateway_tasks._update(second.task_id, status="running")
    gateway_tasks.recover_after_restart()
    assert gateway_quota.usage_summary(owner)[0]["reserved_cny"] == 0
    assert gateway_quota.month_summary(owner)["month_charged_cny"] == 0


def test_unknown_price_reserves_and_charges_zero(owner):
    keys.patch_key("A", {"base_url": "https://unpriced.example"})
    task = submit(owner)
    assert task.estimated_cny is None and task.reserved_cny == 0
    assert gateway_tasks._finish(task, status="done").charged_cny == 0


def test_parallel_admission_only_accepts_one(owner, monkeypatch):
    owner = gateway_keys.update_key(owner.id, limits=[{"period": "day", "cap_cny": .08}])
    barrier = threading.Barrier(2)
    original = gateway_tasks._save

    def slow_save(task):
        time.sleep(.03)  # Widen the admit -> reserve gap; the shared lock must protect it.
        return original(task)

    monkeypatch.setattr(gateway_tasks, "_save", slow_save)

    def run(nonce):
        barrier.wait(timeout=2)
        try:
            submit(owner, nonce)
            return 202
        except gateway_tasks.GatewayRequestError as error:
            return error.status

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(run, ["first", "second"])) == [202, 429]
    assert len(gateway_tasks._all_tasks()) == 1


def test_settlement_has_no_admission_gap(owner, monkeypatch):
    owner = gateway_keys.update_key(owner.id, limits=[{"period": "day", "cap_cny": .08}])
    task = submit(owner)
    entered, release = threading.Event(), threading.Event()
    original = gateway_tasks._append_usage

    def pause_usage(task):
        entered.set()
        assert release.wait(timeout=3)
        original(task)

    monkeypatch.setattr(gateway_tasks, "_append_usage", pause_usage)
    with ThreadPoolExecutor(2) as pool:
        settlement = pool.submit(gateway_tasks._finish, task, status="done")
        assert entered.wait(timeout=3)
        incoming = pool.submit(submit, owner, "second")
        try:
            assert not incoming.done()
        finally:
            release.set()
        settlement.result(timeout=3)
        with pytest.raises(gateway_tasks.GatewayRequestError) as exc:
            incoming.result(timeout=3)
        assert exc.value.status == 429


def test_retry_after_uses_latest_reset_not_limit_order(owner):
    owner = gateway_keys.update_key(owner.id, limits=[
        {"period": "month", "cap_cny": .01}, {"period": "week", "cap_cny": .01},
        {"period": "day", "cap_cny": .01},
    ])
    client, _ = client_for(owner)
    response = _submit(client)
    assert response.status_code == 429
    assert response.json()["detail"] == "中转额度已用完：本月 ¥0.01（已用 ¥0），12-01 00:00 重置"
    assert int(response.headers["retry-after"]) == int(
        (datetime(2026, 12, 1, tzinfo=TZ) - NOW).total_seconds())
    assert not gateway_tasks._all_tasks()


@pytest.mark.parametrize("patterns,route,allowed", [
    (None, "anything", True), ([], "gpt-image-2", False),
    (["gpt-image-2"], "gpt-image-2", True), (["gpt-image-2"], "GPT-image-2", False),
    (["seedance:*"], "seedance:model", True), (["seedance:*"], "other:model", False),
    (["gpt*2"], "gpt-image-2", False), (["gpt?image-2"], "gpt-image-2", False),
])
def test_model_permissions(owner, patterns, route, allowed):
    owner = gateway_keys.update_key(owner.id, allowed_models=patterns)
    assert gateway_access.model_allowed(owner, route) is allowed


def test_permission_checked_before_parameter_validation(owner):
    owner = gateway_keys.update_key(owner.id, allowed_models=[])
    client, _ = client_for(owner)
    assert _submit(client, params={"mask_image": "/etc/passwd"}).status_code == 403
    assert _submit(client, model="unknown", params={"mask_image": "/etc/passwd"}).status_code == 404


def test_alias_exclusion_applies_to_cooldown_fallback_and_estimate(owner):
    owner = gateway_keys.update_key(owner.id, allowed_aliases=["B"])
    keys.patch_key("B", {"base_url": "https://api.tu-zi.com", "billing_group": "绘画"})
    model_routes.cool_down("image", "B", "auth")
    assert gateway_tasks._pick_member("gpt-image-2", [], owner)[0].alias == "B"
    assert submit(owner).estimated_cny is None
    owner = gateway_keys.update_key(owner.id, allowed_aliases=[])
    client, _ = client_for(owner)
    response = _submit(client)
    assert response.status_code == 403 and "能用的供应商都不提供" in response.json()["detail"]
    assert gateway_tasks._pick_member("gpt-image-2", [], owner) is None


def test_execution_skips_forbidden_alias_and_newly_revoked_permissions(owner, monkeypatch):
    owner = gateway_keys.update_key(owner.id, allowed_aliases=["B"])
    calls = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(calls))
    task = submit(owner)
    assert gateway_tasks.run_task(task).member_alias == "B"
    assert [call["alias"] for call in calls] == ["B"]
    task = submit(owner, "two")
    gateway_keys.update_key(owner.id, allowed_models=[])
    assert gateway_tasks.run_task(task).status == "failed"
    assert len(calls) == 1


def test_models_all_modalities_filtered_and_me_private(owner):
    for modality in ["video", "audio", "text"]:
        keys.add_key(keys.KeySpec(alias=modality, provider="custom", access_key="upstream-secret",
                                 created_at="test", models=[keys.ModelSpec(
                                     id=modality, name=modality, modality=modality,
                                     protocol="seedance" if modality == "video" else None)]))
    client, me = client_for(owner)
    models = client.get("/gateway/v1/models").json()["models"]
    assert {m["modality"] for m in models} == {"image", "video", "audio", "text"}
    assert next(m for m in models if m["modality"] == "video")["members"][0]["protocol"] == "seedance"
    gateway_keys.update_key(me.id, allowed_models=["seedance:*", "gpt-image-2"],
                            allowed_aliases=["B", "video"])
    models = client.get("/gateway/v1/models").json()["models"]
    assert [m["alias"] for m in models[0]["members"]] == ["B"]
    assert len(models) == 2
    write_usage(NOW, owner.id, 100)
    write_usage(NOW, me.id, .2)
    view = client.get("/gateway/v1/me").json()
    assert view["month_charged_cny"] == .2 and view["month_calls"] == 1
    assert view["name"] == "http"
    assert set(view) == {"id", "role", "name", "limits", "month_charged_cny", "month_calls"}
    for secret in ["token_sha256", "upstream-secret", "access_key", "base_url"]:
        assert secret not in json.dumps(view)
    assert TestClient(create_gateway_app()).get("/gateway/v1/me").status_code == 401


def test_key_update_unset_vs_none_and_old_field_discard(owner):
    owner = gateway_keys.update_key(owner.id, allowed_aliases=["A"], allowed_models=["gpt-image-2"])
    renamed = gateway_keys.update_key(owner.id, name="new")
    assert renamed.allowed_aliases == ["A"] and renamed.allowed_models == ["gpt-image-2"]
    assert gateway_keys.update_key(owner.id, allowed_aliases=None).allowed_aliases is None
    payload = json.loads(gateway_keys.gateway_file().read_text())
    payload["keys"][0]["daily_image_limit"] = 1
    gateway_keys.gateway_file().write_text(json.dumps(payload))
    assert gateway_keys.read_config().keys[0].limits == owner.limits
    gateway_keys.update_key(owner.id, name="clean")
    assert "daily_image_limit" not in gateway_keys.gateway_file().read_text()


@pytest.mark.parametrize("limits", [
    [{"period": "day", "cap_cny": 1}, {"period": "day", "cap_cny": 2}],
    [{"period": "hour", "cap_cny": 1}], [{"period": "day", "cap_cny": 0}],
    [{"period": "day", "cap_cny": -1}], [{"period": "day", "cap_cny": 1_000_001}],
    [{"period": "day", "cap_cny": float("nan")}],
    [{"period": "day", "cap_cny": 1, "extra": 1}],
])
def test_key_limit_validation(limits):
    with pytest.raises(ValidationError):
        gateway_keys.create_key("invalid", limits)


def test_management_patch_options_and_no_secrets(owner):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app
    from viewer_server.connection_capabilities import local_capability

    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    options = client.get("/api/gateway/options").json()
    assert [a["alias"] for a in options["aliases"]] == ["A", "B"]
    assert options["models"][0]["id"] == "gpt-image-2"
    assert local_capability("GET", "/api/gateway/options") == "manage"
    url = f"/api/gateway/keys/{owner.id}"
    for payload in [{"name": None}, {"limits": None}, {"unknown": True}, {"name": "  "},
                    {"limits": [{"period": "day", "cap_cny": 1}] * 2}]:
        assert client.patch(url, json=payload).status_code == 422
    assert client.patch(url, json={"allowed_models": []}).json()["allowed_models"] == []
    result = client.patch(url, json={"name": "renamed"}).json()
    assert result["allowed_models"] == []
    assert client.patch(url, json={"allowed_models": None}).json()["allowed_models"] is None
    task = submit(gateway_keys.read_config().keys[0])
    gateway_tasks._finish(task, status="done")
    result = client.get("/api/gateway").json()["keys"][0]
    assert result["month_charged_cny"] == .08
    assert result["last_used_at"] is not None
    assert "token_sha256" not in result


def test_upstream_secret_and_local_path_are_redacted(owner, monkeypatch):
    from character_workflow.lib.callers.openai_image import OpenAIImageError

    monkeypatch.setattr(callers, "dispatch", _dispatch([], {
        "A": OpenAIImageError("error test-only path=/private/user/file.png"),
    }))
    done = gateway_tasks.run_task(submit(owner))
    assert "test-only" not in done.error and "/private/user" not in done.error


def test_actual_cost_on_failure_is_settled(owner, monkeypatch):
    def fail(*, on_cost_usd, **kwargs):
        on_cost_usd(.01)
        raise RuntimeError("failed after charge")

    monkeypatch.setattr(callers, "dispatch", fail)
    done = gateway_tasks.run_task(submit(owner))
    assert done.status == "failed" and done.charged_cny == .07


def test_dst_calendar_window():
    now = datetime(2026, 11, 1, 1, tzinfo=ZoneInfo("America/New_York"))
    start = gateway_quota.window_start("day", now)
    end = gateway_quota.window_end("day", now)
    assert (end.astimezone(timezone.utc) - start.astimezone(timezone.utc)).total_seconds() == 25 * 3600


def test_actual_cost_without_valid_output_is_settled(owner, monkeypatch):
    def empty(*, on_cost_usd, **kwargs):
        on_cost_usd(.01)
        return []

    monkeypatch.setattr(callers, "dispatch", empty)
    done = gateway_tasks.run_task(submit(owner))
    assert done.status == "failed" and done.charged_cny == .07


@pytest.mark.parametrize("second_cost,expected", [(None, .07), (.02, .21)])
def test_failover_preserves_all_reported_costs(owner, monkeypatch, second_cost, expected):
    from character_workflow.lib.callers.openai_image import OpenAIImageError

    def dispatch(*, alias, on_cost_usd, **kwargs):
        if alias == "A":
            on_cost_usd(.01)
            raise OpenAIImageError("openai api 401")
        if second_cost is not None:
            on_cost_usd(second_cost)
        return _dispatch([])(alias=alias, **kwargs)

    monkeypatch.setattr(callers, "dispatch", dispatch)
    done = gateway_tasks.run_task(submit(owner))
    assert done.status == "done" and done.charged_cny == expected


def test_idempotency_does_not_reserve_twice(owner):
    first = submit(owner)
    assert submit(owner).task_id == first.task_id
    assert gateway_quota.usage_summary(owner)[0]["reserved_cny"] == .08


def test_v1_gateway_is_rejected(monkeypatch):
    from unittest.mock import MagicMock
    from character_workflow.lib.callers import atelier_gateway

    session = MagicMock()
    session.__enter__.return_value = session
    session.get.return_value.status_code = 200
    session.get.return_value.json.side_effect = [{"ok": True, "version": "old"}, {"protocol": 1}]
    monkeypatch.setattr(atelier_gateway, "_session", lambda: session)
    with pytest.raises(atelier_gateway.GatewayError, match="网关版本不一致"):
        atelier_gateway.check_gateway("http://127.0.0.1:5180", "test")
    assert session.get.call_count == 2
