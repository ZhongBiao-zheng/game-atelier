"""画布 Agent 的花费：每次模型请求记一行用量、会话累计、用量页「我的」、出图估价与确认金额。"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from character_workflow.lib import agent_usage, keys
from character_workflow.lib import canvas_agent_cost as cost
from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient

PRICED = keys.KeySpec(alias="chat", provider="tokendance", base_url="https://chat.invalid/v1",
                      access_key="test-only-not-a-real-key", created_at="2026-11-19T00:00:00Z")
GATEWAY = keys.KeySpec(alias="team", provider="atelier", base_url="http://192.168.1.2:5180/v1",
                       access_key="test-only-not-a-real-key", created_at="2026-11-19T00:00:00Z")


@pytest.fixture
def priced_text(monkeypatch):
    """1 元 / 百万输入 token、2 元 / 百万输出 token；缓存 token 按 0 元。"""
    calls = []

    def fake(model_id, input_tokens, output_tokens, *, key=None, cached_tokens=0):
        calls.append((model_id, input_tokens, output_tokens, cached_tokens))
        if model_id == "unpriced-model":
            return None
        return ((input_tokens - cached_tokens) * 1 + output_tokens * 2) / 1_000_000

    monkeypatch.setattr("character_workflow.lib.generation_pricing.estimate_text_cost_cny", fake)
    return calls


def _record(key, model="m", tokens=(1_000_000, 500_000), cached=0, session="session-aaaaaaaa",
            project="canvas-aaaaaaaa", at=None):
    return agent_usage.record_request(project_id=project, session_id=session, key=key,
                                      alias=key.alias, model=model, input_tokens=tokens[0],
                                      output_tokens=tokens[1], cached_tokens=cached, at=at)


# ── 用量记录 ─────────────────────────────────────────────────────────────────────

def test_each_request_is_priced_on_its_own(isolated_data_root, priced_text):
    # 按请求算：TokenDance 按本次 prompt 长度分档，整轮合计后再算会落错档。
    _record(PRICED, tokens=(1_000_000, 500_000))
    _record(PRICED, tokens=(2_000_000, 0), cached=1_000_000)
    assert [call[1:] for call in priced_text] == [(1_000_000, 500_000, 0), (2_000_000, 0, 1_000_000)]
    totals = agent_usage.session_totals("canvas-aaaaaaaa", "session-aaaaaaaa",
                                        datetime.now(timezone.utc) - timedelta(hours=1))
    assert totals == {"requests": 2, "input_tokens": 3_000_000, "output_tokens": 500_000,
                      "cost_cny": 3.0, "unpriced": 0, "source": "local"}


def test_gateway_requests_are_settled_by_the_host(isolated_data_root, priced_text):
    row = _record(GATEWAY)
    assert row["cost_cny"] is None and row["source"] == "lan" and row["cost_source"] == "host"
    assert priced_text == []  # 本机不替主机算价
    totals = agent_usage.session_totals("canvas-aaaaaaaa", "session-aaaaaaaa",
                                        datetime.now(timezone.utc) - timedelta(hours=1))
    assert totals["cost_cny"] is None and totals["unpriced"] == 1 and totals["source"] == "lan"


def test_rows_hold_statistics_only(isolated_data_root, priced_text):
    priced = _record(PRICED)
    unpriced = _record(PRICED, model="unpriced-model")
    assert set(priced) == {"time", "project_id", "session_id", "alias", "model", "provider", "source",
                           "input_tokens", "output_tokens", "cached_tokens", "cost_cny", "cost_source"}
    assert (priced["cost_source"], unpriced["cost_source"]) == ("price_table", None)


def test_session_totals_skip_other_sessions_old_rows_and_broken_lines(isolated_data_root,
                                                                      priced_text, caplog):
    now = datetime.now(timezone.utc)
    _record(PRICED, at=now - timedelta(days=40))  # 会话创建前的同 id 行不算
    _record(PRICED, session="session-bbbbbbbb")
    _record(PRICED, model="unpriced-model")
    _record(PRICED)
    path = agent_usage.usage_file(now.astimezone().strftime("%Y-%m"))
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"time": "2026-11-19T00:0\n[1, 2]\n')
    totals = agent_usage.session_totals("canvas-aaaaaaaa", "session-aaaaaaaa",
                                        now - timedelta(hours=1))
    assert totals["requests"] == 2 and totals["cost_cny"] == 2.0 and totals["unpriced"] == 1
    assert "skipped 2 unreadable line(s)" in caplog.text  # 半行与非对象行都计数


def test_usage_hook_records_with_session_model_and_never_raises(isolated_data_root, priced_text,
                                                                monkeypatch):
    keys.write_keys_db(keys.KeysDB(keys=[PRICED]))
    turn = runtime.TurnContext("canvas-aaaaaaaa", "auto", session_id="session-aaaaaaaa",
                               model_alias="chat", model="glm-5")
    usage = SimpleNamespace(input_tokens=2000, output_tokens=100,
                            input_tokens_details=SimpleNamespace(cached_tokens=500))
    runtime.record_usage(turn, usage)
    [row] = agent_usage.read_rows()
    assert (row["alias"], row["model"], row["input_tokens"], row["cached_tokens"]) == \
        ("chat", "glm-5", 2000, 500)
    assert row["cost_cny"] == pytest.approx((1500 + 200) / 1_000_000)

    def broken(**_kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(agent_usage, "record_request", broken)
    runtime.record_usage(turn, usage)  # 记账失败不打断对话


def test_usage_hooks_record_every_model_response(isolated_data_root, priced_text):
    import asyncio

    keys.write_keys_db(keys.KeysDB(keys=[PRICED]))
    turn = runtime.TurnContext("canvas-aaaaaaaa", "auto", session_id="session-aaaaaaaa",
                               model_alias="chat", model="glm-5")
    hooks = runtime.usage_hooks()
    response = SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=1,
                                                     input_tokens_details=None))
    for _ in range(2):
        asyncio.run(hooks.on_llm_end(SimpleNamespace(context=turn), None, response))
    assert len(agent_usage.read_rows()) == 2


# ── 确认金额与估价 ────────────────────────────────────────────────────────────────

def test_confirm_amount_defaults_to_ten_and_survives_a_broken_file(isolated_data_root):
    assert cost.confirm_above_cny() == 10.0
    cost.write_confirm_above_cny(2.5)
    assert cost.confirm_above_cny() == 2.5
    cost.settings_file().write_text("{broken", encoding="utf-8")
    assert cost.confirm_above_cny() == 10.0
    with pytest.raises(ValueError):
        cost.write_confirm_above_cny(-1)


@pytest.mark.parametrize(("tool", "mode", "over", "expected"), [
    ("run_generation", "auto", True, True),
    ("run_generation", "auto", False, False),
    ("run_generation", "review", False, True),
    # Auto 下删除维持不确认（2026-11-19 飙哥定）。
    ("apply_changes", "auto", True, False),
    ("get_canvas", "review", True, False),
])
def test_confirmation_rules(monkeypatch, tool, mode, over, expected):
    monkeypatch.setattr(runtime, "generation_over_threshold", lambda *_args: over)
    remove = {"changes": [{"op": "remove_node", "node_id": "cat-1"}]}
    assert runtime.confirmation_required("canvas-aaaaaaaa", tool, remove, mode) is expected


@pytest.mark.parametrize(("estimate", "expected"), [
    (None, False),  # 未计价不拦
    (10.0, False),
    (10.01, True),
])
def test_cost_confirmation_threshold(isolated_data_root, estimate, expected):
    assert cost.needs_cost_confirmation(estimate) is expected


@pytest.fixture
def fake_estimate(monkeypatch):
    seen = []

    def fake(kind, alias, model, params):
        seen.append((kind, alias, model, params))
        return {"seedream": 12.5, "cheap": 0.2}.get(model)

    monkeypatch.setattr(cost, "_estimate", fake)
    return seen


def _image_node(project_id: str, model: str, alias: str | None = "img") -> None:
    from character_workflow.lib import canvas_agent_tools as tools
    from character_workflow.lib.canvas_agent_schema import ApplyChangesInput
    from character_workflow.lib.canvas_projects import read_canvas_document

    exists = any(node.id == "cat-1" for node in read_canvas_document(project_id).nodes)
    changes = [] if exists else [{"op": "add_surface", "kind": "image", "title": "猫",
                                  "node_id": "cat-1", "position": {"x": 0, "y": 0}}]
    tools.apply_changes(runtime.LOCAL, ApplyChangesInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        changes=[*changes, {"op": "set_draft", "node_id": "cat-1", "mode": "image",
                            "prompt": "一只猫", "model": model, "alias": alias,
                            "params": {"size": "1024x1024"}}]))


def _client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1",
                           app=build_app(dist_dir=isolated_data_root / "dist"))


def _project(client) -> str:
    return client.post("/api/canvas/projects", json={"name": "帕伯里"}).json()["project_id"]


def test_estimate_reads_the_draft_and_multiplies_by_count(isolated_data_root, fake_estimate):
    with _client(isolated_data_root) as client:
        project_id = _project(client)
        _image_node(project_id, "seedream")
        result = cost.generation_estimate(project_id, "cat-1", 3)
        assert result == {"model": "seedream", "alias": "img", "count": 3, "estimate_cny": 12.5}
        assert fake_estimate[-1] == ("image", "img", "seedream",
                                     {"size": "1024x1024", "size_mode": "custom", "n": 3})
        # 同一批里还没执行的 set_draft 优先于文档里的旧配置（审查模式下两者一起等确认）。
        pending = [{"op": "set_draft", "node_id": "cat-1", "mode": "image", "prompt": "x",
                    "model": "cheap", "alias": None, "params": {}}]
        assert cost.generation_estimate(project_id, "cat-1", 1, pending)["estimate_cny"] == 0.2
        assert fake_estimate[-1] == ("image", None, "cheap", {"n": 1})


def test_audio_and_missing_drafts_are_unpriced(isolated_data_root, fake_estimate):
    pending = [{"op": "set_draft", "node_id": "voice", "mode": "audio", "prompt": "你好",
                "model": "speech", "alias": "a", "params": {}}]
    assert cost.generation_estimate("canvas-aaaaaaaa", "voice", 1, pending)["estimate_cny"] is None
    assert fake_estimate == []


def test_auto_mode_confirms_generation_only_above_the_amount(isolated_data_root, fake_estimate):
    with _client(isolated_data_root) as client:
        project_id = _project(client)
        _image_node(project_id, "seedream")
        assert runtime.generation_over_threshold(project_id, {"surface_node_id": "cat-1"}) is True
        cost.write_confirm_above_cny(20)
        assert runtime.generation_over_threshold(project_id, {"surface_node_id": "cat-1"}) is False
        _image_node(project_id, "unknown")
        cost.write_confirm_above_cny(0)
        assert runtime.generation_over_threshold(project_id, {"surface_node_id": "cat-1"}) is False


def test_approval_callback_applies_the_amount_in_auto_mode(isolated_data_root, fake_estimate):
    import asyncio

    with _client(isolated_data_root) as client:
        project_id = _project(client)
        _image_node(project_id, "seedream")
        tools = {tool.name: tool for tool in runtime.build_tools()}
        ctx = SimpleNamespace(context=runtime.TurnContext(project_id, "auto"))
        generate = tools["run_generation"].needs_approval
        assert asyncio.run(generate(ctx, {"surface_node_id": "cat-1"}, "c1")) is True
        cost.write_confirm_above_cny(50)
        assert asyncio.run(generate(ctx, {"surface_node_id": "cat-1"}, "c1")) is False
        move = {"changes": [{"op": "move", "node_id": "cat-1", "position": {"x": 1, "y": 1}}]}
        assert asyncio.run(tools["apply_changes"].needs_approval(ctx, move, "c2")) is False


def test_generation_summary_shows_model_price_and_threshold(isolated_data_root, fake_estimate):
    pending = [{"op": "set_draft", "node_id": "cat-1", "mode": "image", "prompt": "x",
                "model": "seedream", "alias": "img", "params": {}}]
    text = runtime.generation_summary("canvas-aaaaaaaa", {"surface_node_id": "cat-1", "count": 2},
                                      pending)
    assert text.splitlines() == ["在节点 cat-1 上生成 2 个结果", "seedream · 预计 12.5¥",
                                 "超过确认金额 10¥"]
    pending[0]["model"] = "unknown"
    assert runtime.generation_summary("canvas-aaaaaaaa", {"surface_node_id": "cat-1"},
                                      pending).splitlines()[1] == "unknown · 未计价"


# ── 一轮对话与接口 ────────────────────────────────────────────────────────────────

class FakeResult:
    def __init__(self, items, interruptions=None):
        self._items, self.interruptions = items, interruptions or []
        self.context_wrapper = SimpleNamespace(usage=SimpleNamespace(input_tokens=1,
                                                                     output_tokens=1))

    def to_input_list(self):
        return self._items


def _wait_status(project_id, session_id, statuses):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        session = read_canvas_agent_session(project_id, session_id)
        if session.status in statuses:
            return session
        time.sleep(0.05)
    raise AssertionError(session.status)


def test_review_card_prices_generation_from_the_same_batch(isolated_data_root, fake_estimate,
                                                           monkeypatch):
    keys.write_keys_db(keys.KeysDB(keys=[PRICED]))
    changes = {"changes": [
        {"op": "add_surface", "kind": "image", "title": "猫", "node_id": "cat-1",
         "position": {"x": 0, "y": 0}},
        {"op": "set_draft", "node_id": "cat-1", "mode": "image", "prompt": "一只猫",
         "model": "seedream", "alias": "img", "params": {}}]}

    async def fake_run_model(session, history, buffer):
        context = runtime.TurnContext(session.project_id, session.permission_mode)
        raws = [SimpleNamespace(call_id="c1", name="apply_changes", arguments=json.dumps(changes)),
                SimpleNamespace(call_id="c2", name="run_generation",
                                arguments=json.dumps({"surface_node_id": "cat-1"}))]
        items = [*history, *({"type": "function_call", "call_id": r.call_id, "name": r.name,
                              "arguments": r.arguments} for r in raws)]
        return FakeResult(items, [SimpleNamespace(raw_item=r) for r in raws]), context

    monkeypatch.setattr(runtime, "run_model", fake_run_model)
    with _client(isolated_data_root) as client:
        project_id = _project(client)
        session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                                 json={}).json()["session_id"]
        base = f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"
        client.patch(base, json={"model": "glm-5", "model_alias": "chat",
                                 "permission_mode": "review"})
        assert client.post(f"{base}/messages", json={"text": "画猫"}).status_code == 202
        paused = _wait_status(project_id, session_id, {"awaiting_approval", "failed"})
    summary = next(a.summary for a in paused.pending_approvals if a.tool == "run_generation")
    assert "seedream · 预计 12.5¥" in summary


def test_settings_and_session_usage_routes(isolated_data_root, priced_text):
    with _client(isolated_data_root) as client:
        assert client.get("/api/canvas/agent/settings").json() == {"confirm_above_cny": 10.0}
        assert client.put("/api/canvas/agent/settings",
                          json={"confirm_above_cny": 3}).json() == {"confirm_above_cny": 3.0}
        assert client.put("/api/canvas/agent/settings",
                          json={"confirm_above_cny": -1}).status_code == 422
        project_id = _project(client)
        session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                                 json={}).json()["session_id"]
        _record(PRICED, project=project_id, session=session_id)
        base = f"/api/canvas/projects/{project_id}/agent/sessions"
        usage = client.get(f"{base}/{session_id}/usage").json()
        assert usage["cost_cny"] == 2.0 and usage["input_tokens"] == 1_000_000
        assert client.get(f"{base}/session-zzzzzzzz/usage").status_code == 404


def test_deleted_canvas_keeps_its_agent_spending(isolated_data_root, priced_text):
    with _client(isolated_data_root) as client:
        project_id = _project(client)
        _record(PRICED, project=project_id, session="session-gonegone")
        from character_workflow.lib.canvas_packages import delete_canvas_project
        from character_workflow.lib.canvas_projects import read_canvas_document

        delete_canvas_project(project_id, read_canvas_document(project_id).revision)
        [row] = [r for r in client.get("/api/usage/tasks", params={"scope": "mine"}).json()["rows"]
                 if r["kind"] == "text"]
    assert (row["cost_cny"], row["project_label"], row["prompt"]) == (
        2.0, "已删除的项目", "Agent 对话：已删除的对话")


def test_mine_usage_includes_agent_conversations(isolated_data_root, priced_text):
    with _client(isolated_data_root) as client:
        project_id = _project(client)
        session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                                 json={}).json()["session_id"]
        for _ in range(3):  # 一轮里的多次请求合成一条
            _record(PRICED, project=project_id, session=session_id)
        _record(PRICED, model="unpriced-model", project=project_id, session=session_id)
        rows = client.get("/api/usage/tasks", params={"scope": "mine"}).json()["rows"]
        totals = client.get("/api/usage", params={"scope": "mine"}).json()["totals"]
    agent = sorted((row for row in rows if row["kind"] == "text"), key=lambda r: r["model"])
    assert [(r["model"], r["cost_cny"], r["project_label"]) for r in agent] == [
        ("m", 6.0, "帕伯里"), ("unpriced-model", None, "帕伯里")]
    assert agent[0]["prompt"] == "Agent 对话：新对话" and agent[0]["href"] == f"/canvas/{project_id}"
    assert totals["cost_cny"] == 6.0 and totals["unpriced"] == 1 and totals["by_kind"] == {"text": 2}
