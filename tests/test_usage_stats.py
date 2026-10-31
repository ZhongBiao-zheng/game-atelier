import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from character_workflow.lib import gateway_keys, gateway_tasks
from character_workflow.lib.canvas_runs import canvas_numbering_prefix
from character_workflow.lib.schemas import Job, JobParams
from character_workflow.lib.usage_stats import aggregate_usage, job_location, mine_records, team_records, usage_tasks
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
    return mine_records(items, {"c1": "画布"})


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
    assert len(usage_tasks(mine([job()]), scope="mine", period="30d", now=NOW)["rows"][0]["prompt"]) == 120


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
    assert usage_tasks(rows, scope="mine", period="30d", now=NOW, source="local")["rows"][0]["id"] == "j2"


def test_project_labels_and_distinct_ids():
    rows = mine([job().model_copy(update={"canvas_project_id": "c1"}), job()])
    assert [row["label"] for row in rows] == ["画布", "未归档"]


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
    assert job_location(job().model_copy(update={"canvas_project_id": "c1"})) == "/canvas/c1"
    assert job_location(job(namespace="studio")) == "/studio"


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
    tasks = usage_tasks(rows, scope="team", period="30d", now=NOW, member="1")["rows"]
    assert next(item for item in tasks if item["id"] == "t11")["thumb_url"] == "/api/gateway/tasks/t11/outputs/0"
    assert all("prompt" not in item for item in tasks)
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
    tasks = client.get(f"/api/usage/tasks?scope=team&member={key.id}").json()
    assert "prompt" not in tasks["rows"][0]
    assert tasks["total"] == result["totals"]["count"]
    assert "top" not in result
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
    assert agent.get("/api/usage/tasks").status_code == 403


def test_task_status_filters_match_totals_and_keep_pending():
    records = mine([
        job(job_id="success", params=JobParams(actual_cost_cny=2), alias="Tuzi",
            completed_at=(NOW + timedelta(seconds=65)).isoformat()),
        job(job_id="free", params=JobParams(actual_cost_cny=0)),
        job(job_id="unknown"), job(job_id="pending", status="pending"),
        job(job_id="failed", status="failed", params=JobParams(estimated_cost_cny=9)),
        job(job_id="billed-failure", status="failed", params=JobParams(actual_cost_cny=3)),
    ])
    def query(**options):
        return usage_tasks(records, scope="mine", period="30d", now=NOW, **options)
    totals = stats(records)["totals"]
    assert query()["total"] == totals["count"] == 6
    assert query(status="done")["total"] == 3
    assert query(status="failed")["total"] == totals["failed"] == 2
    assert query(status="unpriced")["total"] == totals["unpriced"] == 2
    rows = {row["id"]: row for row in query()["rows"]}
    assert rows["success"]["duration_s"] == 65
    assert rows["success"]["alias"] == "Tuzi"
    assert rows["pending"]["status"] == "pending" and rows["pending"]["duration_s"] is None
    assert rows["failed"]["cost_cny"] == 0 and rows["billed-failure"]["cost_cny"] == 3
    assert rows["free"]["cost_cny"] == 0


def test_task_pagination_sorts_instants_then_id_and_filters_before_offset():
    records = mine([job(job_id="b"), job(job_id="a", submitted_at="2026-10-24T04:00:00+00:00"),
        job(job_id="older", submitted_at=(NOW-timedelta(seconds=1)).isoformat()),
        job(job_id="future", submitted_at=(NOW+timedelta(seconds=1)).isoformat()),
        job(job_id="remote", provider="atelier")])
    def query(**options):
        return usage_tasks(records, scope="mine", period="today", now=NOW, source="local", **options)
    first = query(limit=2)
    assert [row["id"] for row in first["rows"]] == ["a", "b"]
    assert first["total"] == 3 and first["next_offset"] == 2
    last = query(offset=2, limit=2)
    assert [row["id"] for row in last["rows"]] == ["older"] and last["next_offset"] is None
    assert query(offset=20)["rows"] == [] and query(offset=20)["total"] == 3
    assert first["total"] == aggregate_usage(records, scope="mine", period="today", now=NOW, source="local")["totals"]["count"]


@pytest.mark.parametrize("filters,expected", [
    ({"project": "canvas:c1"}, ["a", "b", "c"]),
    ({"project": "unassigned"}, ["e"]),
    ({"model": "exact"}, ["a", "b", "d", "e"]),
    ({"model": "ex"}, []),
    ({"alias": "Tuzi"}, ["a", "c", "d", "e"]),
    ({"kind": "image"}, ["a", "b", "c", "d"]),
    ({"kind": "video"}, ["e"]),
    ({"project": "canvas:c1", "model": "exact", "alias": "Tuzi", "kind": "image"}, ["a"]),
])
def test_task_field_filters_match_keys_and_kind_categories(filters, expected):
    records = mine([
        job(job_id=name, model=model, alias=alias, kind=kind).model_copy(
            update={"canvas_project_id": project})
        for name, project, model, alias, kind in [
            ("a", "c1", "exact", "Tuzi", "image"),
            ("b", "c1", "exact", "Other", "image"),
            ("c", "c1", "exact-long", "Tuzi", "image"),
            ("d", "c2", "exact", "Tuzi", "image"),
            ("e", None, "exact", "Tuzi", "video"),
        ]
    ])
    result = usage_tasks(records, scope="mine", period="30d", now=NOW, **filters)
    assert [row["id"] for row in result["rows"]] == expected
    assert all(row["member_key"] is None for row in result["rows"])
    assert {row["project_key"] for row in usage_tasks(
        records, scope="mine", period="30d", now=NOW)["rows"]} == {
            "canvas:c1", "canvas:c2", "unassigned"}
    assert stats(records)["totals"]["by_kind"] == {"image": 4, "video": 1}


def test_task_field_filter_pagination_and_status_intersect():
    records = mine([job(job_id=str(i), model="match" if i % 2 else "other",
                        status="failed" if i == 3 else "done") for i in range(8)])
    def query(**options):
        return usage_tasks(records, scope="mine", period="30d", now=NOW,
                           model="match", status="done", limit=2, **options)
    first = query()
    assert [row["id"] for row in first["rows"]] == ["1", "5"]
    assert first["total"] == 3 and first["next_offset"] == 2
    last = query(offset=2)
    assert [row["id"] for row in last["rows"]] == ["7"]
    assert last["total"] == 3 and last["next_offset"] is None


def test_task_filter_queries_reach_local_route(monkeypatch):
    from character_workflow.lib import jobs
    now = (datetime.now().astimezone() - timedelta(seconds=1)).isoformat()
    monkeypatch.setattr(jobs, "list_jobs", lambda: [
        job(job_id="yes", submitted_at=now, model="gpt", alias="Tuzi", kind="image")
            .model_copy(update={"canvas_project_id": "c1"}),
        job(job_id="no", submitted_at=now, model="gpt", alias="Other"),
    ])
    client = LocalTestClient(app=build_app(), base_url="http://127.0.0.1")
    result = client.get("/api/usage/tasks", params={
        "project": "canvas:c1", "model": "gpt", "alias": "Tuzi", "kind": "image",
    })
    assert result.status_code == 200
    assert result.json()["total"] == 1
    assert result.json()["rows"][0]["project_key"] == "canvas:c1"


def test_team_tasks_preserve_ledger_billing_canceled_and_unknown_elapsed():
    records = team_records([dict(time=NOW.isoformat(), task_id=str(i), key_id="m", key_name="成员",
        charged_cny=amount, kind=kind, status=status, duration=90) for i, (amount, kind, status) in enumerate([
            (0, "image", "done"), (4, "text", "done"), (0, "audio", "canceled"),
            (2, "image_edit", "failed"), (0, "layer_split", "done"),
        ])], set())
    result = usage_tasks(records, scope="team", period="all", now=NOW, member="m")
    totals = aggregate_usage(records, scope="team", period="all", now=NOW, member="m")["totals"]
    assert result["total"] == totals["count"] == 5
    assert sum(row["cost_cny"] for row in result["rows"]) == totals["cost_cny"] == 6
    assert totals["unpriced"] == 0
    assert all(row["duration_s"] is None and row["project_label"] is None
               and row["member_label"] == "成员" for row in result["rows"])
    assert all(row["project_key"] is None and row["member_key"] == "m" for row in result["rows"])
    assert result["rows"][2]["status"] == "canceled"
    assert usage_tasks(records, scope="team", period="all", now=NOW, status="done")["total"] == 3
    images = usage_tasks(records, scope="team", period="all", now=NOW, kind="image")
    assert images["total"] == totals["by_kind"]["image"] == 3
    assert {row["kind"] for row in images["rows"]} == {"image", "image_edit", "layer_split"}


def test_usage_tasks_api_pagination_validation_and_management(monkeypatch):
    from character_workflow.lib import jobs
    from viewer_server.connection_capabilities import local_capability
    now = datetime.now().astimezone() - timedelta(seconds=1)
    monkeypatch.setattr(jobs, "list_jobs", lambda: [job(job_id=f"task-{i:03}", submitted_at=now.isoformat()) for i in range(55)])
    client = LocalTestClient(app=build_app(), base_url="http://127.0.0.1")
    first = client.get("/api/usage/tasks").json()
    assert len(first["rows"]) == 50 and first["next_offset"] == 50 and first["total"] == 55
    last = client.get("/api/usage/tasks?offset=50").json()
    assert len(last["rows"]) == 5 and last["next_offset"] is None
    assert local_capability("GET", "/api/usage/tasks") == "manage"
    for query in ("offset=-1", "limit=0", "limit=201", "status=running", "range=bad", "source=bad"):
        assert client.get(f"/api/usage/tasks?{query}").status_code == 422
    assert client.get("/api/usage/tasks?scope=team").status_code == 404


def test_model_duration_medians_recent_samples_and_auto_members(monkeypatch):
    from character_workflow.lib import model_durations as durations
    from character_workflow.lib import jobs, model_routes

    durations._cache.clear()
    rows = [job(alias="first", model="gpt-image-2", submitted_at=NOW.isoformat(),
                completed_at=(NOW + timedelta(seconds=seconds)).isoformat())
            for seconds in [10, 20, 90]]
    rows += [job(alias="second", model="gpt-image-2", submitted_at=NOW.isoformat(),
                 completed_at=(NOW + timedelta(seconds=seconds)).isoformat())
             for seconds in [30, 40]]
    rows += [job(alias="failed", status="failed", completed_at=NOW.isoformat())] * 3
    rows += [job(alias="missing", completed_at=None)] * 3
    rows += [job(alias="canvas", completed_at=(NOW + timedelta(seconds=100)).isoformat())
             .model_copy(update={"namespace": "canvas", "runner_started_at":
                                 (NOW + timedelta(seconds=75)).isoformat()})] * 3
    rows += [job(alias="old", model="recent", completed_at=(NOW + timedelta(days=i)).isoformat(),
                 submitted_at=(NOW + timedelta(days=i, seconds=-(1 if i < 5 else 50))).isoformat())
             for i in range(55)]
    calls = []
    monkeypatch.setattr(jobs, "list_jobs", lambda: calls.append(1) or rows)
    monkeypatch.setattr(model_routes, "list_routes", lambda: [SimpleNamespace(
        id="gpt-image-2", members=[SimpleNamespace(alias=alias, model_id="gpt-image-2")
                                   for alias in ["first", "second"]])])
    with LocalTestClient(app=build_app(), base_url="http://127.0.0.1") as client:
        calls.clear()
        response = client.get("/api/models/durations")
        assert response.status_code == 200
        assert response.json() == {"first:gpt-image-2": 20, "@auto:gpt-image-2": 30,
                                   "canvas:gpt": 25, "old:recent": 50}
        assert client.get("/api/models/durations").json() == response.json()
    assert len(calls) == 1
    monkeypatch.setattr(durations, "monotonic", lambda: durations._cache["expires"] + 1)
    durations.model_durations()
    assert len(calls) == 2
    durations._cache.clear()
