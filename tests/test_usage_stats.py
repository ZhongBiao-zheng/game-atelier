import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from character_workflow.lib import gateway_keys, gateway_tasks
from character_workflow.lib.canvas_runs import canvas_numbering_prefix
from character_workflow.lib.schemas import Job, JobParams
from character_workflow.lib.usage_stats import aggregate_usage, job_location, mine_records, team_records
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app

NOW = datetime.fromisoformat("2026-10-24T12:00:00+08:00")


def job(**changes):
    data = dict(job_id="j1", character_id="hero", prompt="画" * 140,
                submitted_at=NOW.isoformat(), model="gpt", params=JobParams(),
                output_paths=[], status="done", error=None)
    data.update(changes)
    return Job(**data)


def mine(items):
    return mine_records(items, {"c1": "画布"}, {"p1": "工坊"}, {"hero": "p1"})


def stats(rows, **kwargs):
    return aggregate_usage(rows, scope="mine", period="30d", now=NOW, **kwargs)


@pytest.mark.parametrize("status,actual,estimated,expected", [
    ("done", 2, 9, 2), ("done", 0, 9, 0), ("done", None, 9, 9),
    ("failed", None, 9, 0), ("failed", 2, 9, 2), ("done", None, None, 0),
])
def test_cost_rules(status, actual, estimated, expected):
    result = stats(mine([job(status=status, params=JobParams(
        actual_cost_cny=actual, estimated_cost_cny=estimated))]))
    assert result["totals"]["cost_cny"] == expected
    assert result["totals"]["count"] == 1
    assert result["totals"]["failed"] == int(status == "failed")
    assert len(result["top"][0]["prompt"]) == 120


def test_canvas_numbering_prefix_is_not_shown():
    inputs = [SimpleNamespace(source="connection", kind="image"), SimpleNamespace(source="connection", kind="text")]
    prompt = canvas_numbering_prefix(inputs) + "雨夜集市"
    canvas = job(prompt=prompt).model_copy(update={
        "canvas_run": SimpleNamespace(snapshot=SimpleNamespace(inputs=inputs))})
    assert prompt.startswith("参考素材编号")
    assert mine([canvas])[0]["prompt"] == "雨夜集市"


def test_unsubmitted_canceled_and_text_are_excluded():
    assert mine([job(status="pending_confirm"), job(status="canceled"), job(kind="text")]) == []


def test_sources_filter_preserves_available_sources():
    rows = mine([job(provider="atelier"), job(job_id="j2", provider="openai")])
    result = stats(rows, source="local")
    assert result["sources"] == ["lan", "local"]
    assert result["totals"]["count"] == 1
    assert result["top"][0]["id"] == "j2"


def test_project_labels_and_distinct_ids():
    # model_copy isolates attribution from namespace validation, which has its own schema tests.
    rows = mine([job().model_copy(update={"canvas_project_id": "c1"}),
                 job(project_id="p1"), job(), job(character_id="other")])
    assert [row["label"] for row in rows] == ["画布", "工坊", "工坊", "未归档"]
    assert stats(rows)["rankings"][1]["rows"][0]["count"] == 1  # tie sorted by key


@pytest.mark.parametrize("period,bucket,first,length", [
    ("today", "day", "2026-10-24", 1), ("7d", "day", "2026-10-18", 7),
    ("30d", "day", "2026-09-25", 30), ("90d", "week", "2026-07-27", 13),
])
def test_empty_buckets_cross_month(period, bucket, first, length):
    result = aggregate_usage([], scope="mine", period=period, now=NOW)
    assert result["bucket"] == bucket
    assert result["trend"][0] == {"start": first, "cost_cny": 0}
    assert len(result["trend"]) == length


def test_previous_same_length_and_all():
    rows = mine([job(params=JobParams(actual_cost_cny=3)), job(job_id="previous",
        submitted_at=(NOW - timedelta(days=30)).isoformat(), params=JobParams(actual_cost_cny=5))])
    assert stats(rows)["totals"]["previous_cost_cny"] == 5
    assert stats(rows)["totals"]["cost_cny"] == 3
    all_stats = aggregate_usage(rows, scope="mine", period="all", now=NOW)
    assert all_stats["totals"]["previous_cost_cny"] is None
    assert all_stats["totals"]["cost_cny"] == 8
    assert all_stats["trend"][0]["start"] == "2026-09-21"


def test_href_rules():
    base = job()
    assert job_location(base.model_copy(update={"canvas_project_id": "c1"}), {}) == "/canvas/c1"
    assert job_location(job(namespace="studio"), {}) == "/studio"
    assert job_location(base, {"hero": "p1"}) == "/workshop/p1/art/characters/hero"
    assert job_location(base, {}) == "/workshop/unassigned/characters/hero"
    assert job_location(job(character_id=""), {}) is None
    assert job_location(base.model_copy(update={"namespace": "ui", "project_id": "p1",
        "ui_scheme_id": "s1", "screen_id": "s2"}), {}) == "/workshop/p1/ui/s1/screens/s2"
    assert job_location(base.model_copy(update={"namespace": "video", "project_id": "p1",
        "production_id": "v1"}), {}) == "/workshop/p1/video/v1"


def test_team_filter_privacy_and_rankings():
    rows = team_records([dict(time=NOW.isoformat(), task_id=f"t{i}", key_id=str(i % 2),
        key_name=f"成员{i % 2}", charged_cny=i, kind="image", status="done", model_id="gpt",
        prompt="private") for i in range(12)], {"t11"})
    result = aggregate_usage(rows, scope="team", period="30d", now=NOW, member="1",
                             members=[{"id": "1", "name": "成员1"}])
    assert result["totals"]["count"] == 6
    assert result["totals"]["cost_cny"] == 36
    assert result["totals"]["active_members"] == 1
    assert result["totals"]["member_count"] == 1
    assert result["top"][0]["thumb_url"] == "/api/gateway/tasks/t11/outputs/0"
    assert all("prompt" not in item for item in result["top"])
    assert [rank["by"] for rank in result["rankings"]] == ["member", "model"]


def test_usage_api_local_access_and_team_disabled(monkeypatch):
    from viewer_server.connection_capabilities import LOCAL_MANAGEMENT, local_capability
    from fastapi.testclient import TestClient
    app = build_app()
    client = LocalTestClient(app=app, base_url="http://127.0.0.1")
    assert client.get("/api/usage?scope=team").status_code == 404
    assert client.get("/api/usage").json()["totals"]["count"] == 0
    assert client.get("/api/usage?range=bad").status_code == 422
    assert TestClient(app, base_url="http://127.0.0.1").get("/api/usage").status_code == 401
    assert "/api/usage" in LOCAL_MANAGEMENT
    assert local_capability("GET", "/api/usage") == "manage"
    gateway_keys.update_settings(enabled=True)
    key, _ = gateway_keys.create_key("同事", None)
    monkeypatch.setattr(gateway_tasks, "read_usage_range", lambda *_: [dict(
        time=(datetime.now().astimezone() - timedelta(seconds=1)).isoformat(), task_id="missing", key_id=key.id,
        key_name="同事", charged_cny=3, kind="text", status="done", model_id="gpt")])
    result = client.get(f"/api/usage?scope=team&member={key.id}").json()
    assert result["totals"]["cost_cny"] == 3
    assert "prompt" not in result["top"][0]
    assert result["members"] == [{"id": key.id, "name": "同事"}]


def test_key_last_used_takes_latest_per_alias():
    from character_workflow.lib import jobs
    jobs_dir = jobs._runtime_dir() / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    rows = {"a": ("hk", "2026-10-20T10:00:00+08:00"), "b": ("hk", "2026-10-22T09:00:00+08:00"),
            "c": ("tuzi", "2026-10-01T09:00:00+08:00"), "d": (None, "2026-10-23T09:00:00+08:00")}
    for name, (alias, at) in rows.items():
        (jobs_dir / f"{name}.json").write_text(json.dumps({"alias": alias, "submitted_at": at}))
    (jobs_dir / "broken.json").write_text("{")
    expected = {"hk": "2026-10-22T09:00:00+08:00", "tuzi": "2026-10-01T09:00:00+08:00"}
    assert jobs.last_used_by_alias() == expected
    client = LocalTestClient(app=build_app(), base_url="http://127.0.0.1")
    assert client.get("/api/usage/key-last-used").json() == expected


def test_agent_cannot_read_usage(tmp_path):
    from fastapi.testclient import TestClient
    from tests.test_local_connection_auth import bootstrap, create_grant, ORIGIN
    client = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    bootstrap(client)
    agent, *_ = create_grant(client)
    assert agent.get("/api/usage").status_code == 403
    assert agent.get("/api/usage/key-last-used").status_code == 403
