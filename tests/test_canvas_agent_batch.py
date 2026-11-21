"""画布 Agent 批量生成（run_generations）：逐项提交与结果、合计估价确认、确认卡逐项拒绝。"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_agent_cost as cost
from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib import keys
from character_workflow.lib.canvas_agent_schema import ApplyChangesInput
from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session
from character_workflow.lib.canvas_projects import read_canvas_document
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient

IMAGE_KEY = keys.KeySpec(alias="img", provider="openai", access_key="test-only-not-a-real-key",
                         modalities=["image"], created_at="2026-11-20T00:00:00Z",
                         models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2",
                                                modality="image")])
CHAT_KEY = keys.KeySpec(alias="chat", provider="tokendance", base_url="https://chat.invalid/v1",
                        access_key="test-only-not-a-real-key", created_at="2026-11-20T00:00:00Z")


@pytest.fixture
def fake_estimate(monkeypatch):
    prices = {"seedream": 6.0, "cheap": 0.2}
    monkeypatch.setattr(cost, "_estimate", lambda _kind, _alias, model, params:
                        None if model not in prices else round(prices[model] * params.get("n", 1), 6))
    return prices


@pytest.fixture
def scheduled(monkeypatch):
    jobs: list[str] = []
    monkeypatch.setattr(runtime, "_schedule_canvas_job", jobs.append)
    return jobs


@pytest.fixture
def client(isolated_data_root):
    keys.write_keys_db(keys.KeysDB(keys=[IMAGE_KEY, CHAT_KEY]))
    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as test_client:
        yield test_client


def _project(client) -> str:
    return client.post("/api/canvas/projects", json={"name": "帕伯里"}).json()["project_id"]


def _surfaces(project_id: str, models: dict[str, str]) -> None:
    """每个 node_id 建一个图片节点并写好 draft；标题依次为 角色1、角色2…"""
    changes = []
    for index, (node_id, model) in enumerate(models.items()):
        changes += [{"op": "add_surface", "kind": "image", "title": f"角色{index + 1}",
                     "node_id": node_id, "position": {"x": 0, "y": 0}},
                    {"op": "set_draft", "node_id": node_id, "mode": "image", "prompt": "一只猫",
                     "model": model, "alias": "img", "params": {"size": "1024x1024"}}]
    tools.apply_changes(runtime.LOCAL, ApplyChangesInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        changes=changes))


def _batch(*items: tuple[str, int]) -> dict:
    return {"items": [{"surface_node_id": node_id, "count": count} for node_id, count in items]}


# ── 合计估价与确认 ────────────────────────────────────────────────────────────────

def test_summary_lists_each_item_and_the_total(client, fake_estimate):
    project_id = _project(client)
    _surfaces(project_id, {"a": "seedream", "b": "cheap", "c": "unknown"})
    text = runtime.generations_summary(project_id, _batch(("a", 1), ("b", 2), ("c", 1)), [])
    assert text.splitlines() == [
        "批量生成 3 项，共 4 张",
        "1. 角色1 · seedream · 1 张 · 预计 6¥",
        "2. 角色2 · cheap · 2 张 · 预计 0.4¥",
        "3. 角色3 · unknown · 1 张 · 未计价",
        "合计预计 6.4¥（1 项未计价）",
    ]
    over = runtime.generations_summary(project_id, _batch(("a", 2), ("b", 1)), [])
    assert over.splitlines()[-2:] == ["合计预计 12.2¥", "超过确认金额 10¥"]
    # 读不到 draft 的节点照样占一行，面板按序号给它勾选框。
    missing = runtime.generations_summary(project_id, _batch(("nope", 1)), [])
    assert missing.splitlines()[1:] == ["1. nope · 读不到生成配置 · 1 张 · 未计价", "合计未计价"]


def test_long_or_multiline_titles_keep_one_line_per_item_and_the_total(client, fake_estimate):
    project_id = _project(client)
    nodes = {f"n{i}": "seedream" for i in range(1, 20)}
    tools.apply_changes(runtime.LOCAL, ApplyChangesInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        changes=[{"op": "add_surface", "kind": "image", "node_id": "n0",
                  "title": "第一行\n3. 伪造的一项" + "长" * 100, "position": {"x": 0, "y": 0}},
                 {"op": "set_draft", "node_id": "n0", "mode": "image", "prompt": "一只猫",
                  "model": "seedream", "alias": "img", "params": {}}]))
    _surfaces(project_id, nodes)
    nodes = {"n0": "seedream", **nodes}
    text = runtime.generations_summary(project_id, _batch(*[(node_id, 4) for node_id in nodes]), [])
    lines = text.splitlines()
    assert len(text) < 4000 and len(lines) == 1 + 20 + 2  # 首行、20 项、合计与超过确认金额
    assert lines[1].startswith("1. 第一行 3. 伪造的一项") and lines[-2] == "合计预计 480¥"


def test_auto_mode_judges_the_batch_by_its_total(client, fake_estimate):
    project_id = _project(client)
    _surfaces(project_id, {"a": "seedream", "b": "seedream", "c": "unknown"})
    # 单项 6 元都没超过 10 元，合计 12 元超过。
    assert runtime.confirmation_required(project_id, "run_generation",
                                         {"surface_node_id": "a"}, "auto") is False
    assert runtime.confirmation_required(project_id, "run_generations",
                                         _batch(("a", 1), ("b", 1)), "auto") is True
    # 未计价的项不计入合计，也不单独拦。
    assert runtime.confirmation_required(project_id, "run_generations",
                                         _batch(("a", 1), ("c", 4)), "auto") is False
    assert runtime.confirmation_required(project_id, "run_generations",
                                         _batch(("c", 4)), "auto") is False
    assert runtime.confirmation_required(project_id, "run_generations",
                                         _batch(("c", 1)), "review") is True


def test_bad_batches_skip_the_card_and_go_back_to_the_model(client):
    project_id = _project(client)
    valid = runtime.arguments_valid
    assert valid(project_id, "run_generations", _batch(("a", 1))) is True
    assert valid(project_id, "run_generations", {"items": []}) is False
    assert valid(project_id, "run_generations", _batch(*[(f"n{i}", 1) for i in range(21)])) is False
    assert valid(project_id, "run_generations", _batch(("a", 5))) is False
    assert valid(project_id, "run_generations", {"items": ["a"]}) is False
    assert valid(project_id, "run_generations", {}) is False


# ── 执行 ──────────────────────────────────────────────────────────────────────────

def test_items_run_one_by_one_and_partial_success_is_kept(client, scheduled):
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2", "b": "gpt-image-2"})
    text, created = runtime.run_tool_safely(project_id, "run_generations",
                                            _batch(("a", 2), ("missing", 1), ("b", 1)))
    result = json.loads(text)
    assert [(row["index"], row["surface_node_id"], row["status"]) for row in result["items"]] == [
        (0, "a", "submitted"), (1, "missing", "failed"), (2, "b", "submitted")]
    assert result["items"][1]["error"] == "INVALID_TARGET：找不到这个生成节点"
    assert (result["submitted"], result["rejected"], result["failed"]) == (2, 0, 1)
    assert "部分成功不回滚" in result["note"] and "不要自动重试" in result["note"]
    # 失败的那一项不影响前后两项：两个任务都已调度，结果节点都在画布上。
    assert len(scheduled) == 2
    submitted = [row for row in result["items"] if row["status"] == "submitted"]
    assert all(row["run_id"] for row in submitted)
    assert sorted(created) == sorted(row["result_node_id"] for row in submitted)
    assert set(created) <= {node.id for node in read_canvas_document(project_id).nodes}


def test_rejected_items_are_reported_apart_from_failed_ones(client, scheduled):
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2", "b": "gpt-image-2"})
    text, _created = runtime.run_tool_safely(project_id, "run_generations",
                                             _batch(("a", 1), ("b", 1), ("missing", 1)),
                                             rejected=frozenset({1}))
    rows = json.loads(text)["items"]
    assert [row["status"] for row in rows] == ["submitted", "rejected", "failed"]
    assert rows[1]["reason"] == "用户在确认卡上拒绝了这一项" and "error" not in rows[1]
    assert len(scheduled) == 1


def test_unexpected_error_on_one_item_keeps_the_submitted_run_ids(client, scheduled, monkeypatch):
    """第 2 项抛 OSError：第 1 项的 run_id 照样回给模型，第 3 项照常提交（不让异常丢掉已计费的结果）。"""
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2", "b": "gpt-image-2", "c": "gpt-image-2"})
    real_run = tools.run

    def flaky_run(principal, payload):
        if payload.surface_node_id == "b":
            raise OSError("磁盘写入失败")
        return real_run(principal, payload)

    monkeypatch.setattr(tools, "run", flaky_run)
    text, created = runtime.run_tool_safely(project_id, "run_generations",
                                            _batch(("a", 1), ("b", 1), ("c", 1)))
    rows = json.loads(text)["items"]
    assert [row["status"] for row in rows] == ["submitted", "failed", "submitted"]
    assert rows[0]["run_id"] and rows[2]["run_id"]
    assert rows[1]["error"].startswith("未预期错误（OSError）") and "不要重试" in rows[1]["error"]
    assert len(scheduled) == 2 and len(created) == 2


def test_same_node_twice_sends_the_whole_batch_back(client, scheduled):
    """同一节点出现两次时两次都会落进同一个结果节点并发写入：整批退回，让模型改用 count。"""
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2", "b": "gpt-image-2"})
    batch = _batch(("a", 1), ("b", 1), ("a", 2))
    assert runtime.arguments_valid(project_id, "run_generations", batch) is False
    text, created = runtime.run_tool_safely(project_id, "run_generations", batch)
    assert text.startswith("错误（INVALID_PARAMETERS）") and "节点 a 出现了多次" in text
    assert created == [] and scheduled == []


def test_creation_mode_blocks_an_item_without_stopping_the_others(client, scheduled):
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2"})
    video_only = runtime.ModelScope(creation_mode="video")
    text, _created = runtime.run_tool_safely(project_id, "run_generations",
                                             _batch(("a", 1)), video_only)
    row = json.loads(text)["items"][0]
    assert row["status"] == "failed" and "当前创作模式不能生成图片" in row["error"]
    assert scheduled == []


# ── 确认卡逐项拒绝（接口）────────────────────────────────────────────────────────

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


def test_card_rejects_single_items_and_the_model_sees_which(client, fake_estimate, scheduled,
                                                            monkeypatch):
    calls: list[list[dict]] = []
    arguments = json.dumps(_batch(("a", 1), ("b", 2), ("c", 1)))

    async def fake_run_model(session, history, buffer):
        calls.append(history)
        context = runtime.TurnContext(session.project_id, session.permission_mode)
        if len(calls) == 1:
            raws = [SimpleNamespace(call_id="g1", name="run_generations", arguments=arguments),
                    SimpleNamespace(call_id="m1", name="apply_changes", arguments=json.dumps(
                        {"changes": [{"op": "move", "node_id": "a",
                                      "position": {"x": 5, "y": 5}}]}))]
            items = [*history, *({"type": "function_call", "call_id": r.call_id, "name": r.name,
                                  "arguments": r.arguments} for r in raws)]
            return FakeResult(items, [SimpleNamespace(raw_item=r) for r in raws]), context
        reply = {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "已提交两项"}]}
        return FakeResult([*history, reply]), context

    monkeypatch.setattr(runtime, "run_model", fake_run_model)
    project_id = _project(client)
    _surfaces(project_id, {"a": "gpt-image-2", "b": "seedream", "c": "gpt-image-2"})
    session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                             json={}).json()["session_id"]
    base = f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"
    client.patch(base, json={"model": "glm-5", "model_alias": "chat", "permission_mode": "review"})
    assert client.post(f"{base}/messages", json={"text": "三个角色各出一张"}).status_code == 202
    paused = _wait_status(project_id, session_id, {"awaiting_approval", "failed"})
    assert paused.status == "awaiting_approval", paused.error
    card = next(a for a in paused.pending_approvals if a.tool == "run_generations")
    assert card.summary.splitlines()[2] == "2. 角色2 · seedream · 2 张 · 预计 12¥"

    # 逐项选择只给批量生成、至少一项、下标在范围内。
    bad_sets = [
        [{"call_id": "g1", "approve": True}, {"call_id": "m1", "approve": True, "items": [0]}],
        [{"call_id": "g1", "approve": True, "items": [3]}, {"call_id": "m1", "approve": True}],
        [{"call_id": "g1", "approve": True, "items": []}, {"call_id": "m1", "approve": True}],
    ]
    for decisions in bad_sets:
        assert client.post(f"{base}/approvals", json={"decisions": decisions}).status_code == 422
    assert read_canvas_agent_session(project_id, session_id).status == "awaiting_approval"

    decided = client.post(f"{base}/approvals", json={"decisions": [
        {"call_id": "g1", "approve": True, "items": [0, 2]},
        {"call_id": "m1", "approve": False}]})
    assert decided.status_code == 202, decided.json()
    done = _wait_status(project_id, session_id, {"idle", "failed"})
    assert done.status == "idle", done.error
    outputs = {item["call_id"]: item["output"] for item in calls[1]
               if item.get("type") == "function_call_output"}
    batch = json.loads(outputs["g1"])
    assert [row["status"] for row in batch["items"]] == ["submitted", "rejected", "submitted"]
    assert outputs["m1"] == "用户拒绝了这个操作。"
    assert len(scheduled) == 2
    panel = next(m.text for m in done.messages if m.title == "run_generations")
    assert panel.splitlines() == [
        "已提交 2 项，已拒绝 1 项",
        "1. 角色1 · gpt-image-2 · 1 张 · 未计价 — 已提交",
        "2. 角色2 · seedream · 2 张 · 预计 12¥ — 已拒绝",
        "3. 角色3 · gpt-image-2 · 1 张 · 未计价 — 已提交",
        "已提交项合计未计价",
    ]


# ── 一起等多个 run（wait_for_runs）────────────────────────────────────────────────

def test_attachments_are_all_or_first_of_each_run():
    from character_workflow.lib import canvas_agent_vision as vision

    assert vision.pick_attachments({"r1": ["a", "b"], "r2": ["c"]}) == (["a", "b", "c"], [])
    assert vision.pick_attachments({"r1": ["a", "b"], "r2": ["c", "d"], "r3": ["e"]}) == (
        ["a", "c", "e"], [])
    runs = {f"r{i}": [f"v{i}a", f"v{i}b"] for i in range(1, 7)}
    assert vision.pick_attachments(runs) == (["v1a", "v2a", "v3a", "v4a"], ["r5", "r6"])
    assert vision.pick_attachments({"r1": [], "r2": []}) == ([], [])


async def test_runs_are_waited_together_and_lookup_errors_stop_early(monkeypatch):
    from character_workflow.lib import canvas_agent_vision as vision

    monkeypatch.setattr(vision, "POLL_SECONDS", 0)
    polls = {"slow": 0, "missing": 0}

    def slow():
        polls["slow"] += 1
        return {"status": "done" if polls["slow"] >= 3 else "running"}

    def missing():
        polls["missing"] += 1
        return {"lookup_error": "INVALID_TARGET：找不到这次生成"}

    views = await vision.wait_for_runs({"slow": slow, "missing": missing,
                                        "fast": lambda: {"status": "failed", "error": "x"}})
    assert views["slow"]["status"] == "done" and polls == {"slow": 3, "missing": 1}
    monkeypatch.setattr(vision, "WAIT_SECONDS", 0)
    stuck = await vision.wait_for_runs({"r": lambda: {"status": "running"}})
    assert "wait_for_runs" in stuck["r"]["note"]


def _fake_views(monkeypatch, views: dict[str, dict]) -> dict[str, bool]:
    """返回每个跑完的 run 是否被允许做联系表。"""
    sheets: dict[str, bool] = {}

    def lookup(_project_id, run_id):
        return views[run_id]

    def checks(_project_id, run_id, view, sheet=True):
        sheets[run_id] = sheet
        return {**view, "checked": True}

    monkeypatch.setattr(runtime, "_lookup_run", lookup)
    monkeypatch.setattr(tools, "image_versions", lambda _pid, ids: [v for v in ids if v.startswith("img")])
    monkeypatch.setattr(runtime, "_with_run_checks", checks)
    return sheets


def _done(*version_ids: str) -> dict:
    return {"status": "done", "error": None, "candidates": [
        {"index": i, "status": "succeeded", "version_id": vid, "error": None}
        for i, vid in enumerate(version_ids)]}


async def test_wait_for_runs_reports_each_run_and_caps_attachments(monkeypatch):
    from character_workflow.lib import canvas_agent_vision as vision

    monkeypatch.setattr(vision, "POLL_SECONDS", 0)
    quota = "中转额度已用完：今日 ¥0.5（已用 ¥0.32），11-21 00:00 重置"
    views = {f"run-{i}": _done(f"img-{i}a", f"img-{i}b") for i in range(1, 6)}
    views["run-x"] = {"status": "failed", "error": quota, "candidates": [
        {"index": 0, "status": "failed", "version_id": None, "error": quota}]}
    views["run-?"] = {"run_id": "run-?", "lookup_error": "INVALID_TARGET：找不到这次生成"}
    sheets = _fake_views(monkeypatch, views)
    tool = {t.name: t for t in runtime.build_tools()}["wait_for_runs"]
    assert tool.needs_approval is False  # 只读，不弹确认
    ctx = SimpleNamespace(context=runtime.TurnContext("canvas-aaaaaaaa", "review"))
    text = await tool.on_invoke_tool(ctx, json.dumps({"run_ids": [*views, "run-1"]}))
    result = json.loads(text)
    assert [run["run_id"] for run in result["runs"]] == list(views)  # 去重、按给的顺序
    by_id = {run["run_id"]: run for run in result["runs"]}
    # 额度用完这类失败把原因原样给模型（内置 Agent 用本机身份，看得到 job.error）。
    assert by_id["run-x"]["error"] == quota and by_id["run-x"]["checked"]
    assert by_id["run-?"]["lookup_error"].startswith("INVALID_TARGET")
    assert result["counts"] == {"done": 5, "failed": 1, "lookup_error": 1}
    assert result[vision.ATTACH_KEY] == ["img-1a", "img-2a", "img-3a", "img-4a"]
    assert "run-5" in result["note"] and "read_media" in result["note"]
    # 视频联系表只给附得上图的前 4 个 run 做，第 5 个起不再解码视频。
    assert [run_id for run_id, allowed in sheets.items() if allowed] == [
        "run-1", "run-2", "run-3", "run-4"]


async def test_wait_for_runs_attaches_everything_when_few_and_rejects_bad_input(monkeypatch):
    from character_workflow.lib import canvas_agent_vision as vision

    monkeypatch.setattr(vision, "POLL_SECONDS", 0)
    _fake_views(monkeypatch, {"a": _done("img-a1", "img-a2"), "b": _done("img-b1", "vid-b2")})
    result = json.loads(await runtime._wait_for_runs("canvas-aaaaaaaa", ["a", "b"]))
    assert result[vision.ATTACH_KEY] == ["img-a1", "img-a2", "img-b1"] and "note" not in result
    assert (await runtime._wait_for_runs("canvas-aaaaaaaa", [])).startswith("错误（INVALID_PARAMETERS）")
    too_many = [f"r{i}" for i in range(21)]
    assert (await runtime._wait_for_runs("canvas-aaaaaaaa", too_many)).startswith("错误")


# ── 确认卡的逐项接口与执行记录 ───────────────────────────────────────────────────

def _paused_batch(client, monkeypatch, batch: dict, extra_calls: list | None = None):
    """会话停在待确认：一个 run_generations（call_id g1）加可选的其他调用。返回 (project_id, base, calls)。"""
    calls: list[list[dict]] = []

    async def fake_run_model(session, history, buffer):
        calls.append(history)
        context = runtime.TurnContext(session.project_id, session.permission_mode)
        if len(calls) == 1:
            raws = [*(extra_calls or []),
                    SimpleNamespace(call_id="g1", name="run_generations", arguments=json.dumps(batch))]
            items = [*history, *({"type": "function_call", "call_id": r.call_id, "name": r.name,
                                  "arguments": r.arguments} for r in raws)]
            return FakeResult(items, [SimpleNamespace(raw_item=r) for r in raws]), context
        reply = {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "好"}]}
        return FakeResult([*history, reply]), context

    monkeypatch.setattr(runtime, "run_model", fake_run_model)
    project_id = _project(client)
    session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                             json={}).json()["session_id"]
    base = f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"
    client.patch(base, json={"model": "glm-5", "model_alias": "chat", "permission_mode": "review"})
    return project_id, session_id, base, calls


def test_card_items_are_computed_now_and_include_drafts_from_the_same_batch(client, fake_estimate,
                                                                           monkeypatch):
    draft_c = SimpleNamespace(call_id="m1", name="apply_changes", arguments=json.dumps({"changes": [
        {"op": "set_draft", "node_id": "c", "mode": "image", "prompt": "x", "model": "cheap",
         "alias": "img", "params": {}}]}))
    project_id, session_id, base, _calls = _paused_batch(
        client, monkeypatch, _batch(("a", 1), ("c", 3)), [draft_c])
    _surfaces(project_id, {"a": "seedream", "c": "unknown"})
    assert client.post(f"{base}/messages", json={"text": "出图"}).status_code == 202
    _wait_status(project_id, session_id, {"awaiting_approval", "failed"})

    response = client.get(f"{base}/approvals/g1/items")
    assert response.status_code == 200, response.text
    assert response.json() == {"confirm_above_cny": 10.0, "items": [
        {"index": 0, "node_id": "a", "title": "角色1", "model": "seedream", "count": 1, "estimate_cny": 6.0},
        # 同一批待确认的 set_draft 计入估价（画布上的 draft 还是 unknown）。
        {"index": 1, "node_id": "c", "title": "角色2", "model": "cheap", "count": 3, "estimate_cny": 0.6},
    ]}
    # 现算：等待期间 a 的 draft 改了，卡片拿到的是新估价。
    _set_model(project_id, "a", "cheap")
    assert client.get(f"{base}/approvals/g1/items").json()["items"][0]["estimate_cny"] == 0.2
    # 不是批量的调用、不存在的调用都是 404。
    assert client.get(f"{base}/approvals/m1/items").status_code == 404
    assert client.get(f"{base}/approvals/nope/items").status_code == 404


def test_card_items_are_gone_once_decided_and_closed_to_agent_connections(client, isolated_data_root,
                                                                         fake_estimate, scheduled,
                                                                         monkeypatch):
    from character_workflow.lib import data_root
    from character_workflow.lib.private_json import read_private_json

    project_id, session_id, base, _calls = _paused_batch(client, monkeypatch, _batch(("a", 1)))
    _surfaces(project_id, {"a": "seedream"})
    client.post(f"{base}/messages", json={"text": "出图"})
    _wait_status(project_id, session_id, {"awaiting_approval", "failed"})

    store = client.app.state.connection_store
    store.enable_agent("http://127.0.0.1")
    credential = read_private_json(data_root.agent_credential_file())
    anonymous = LocalTestClient.__mro__[1](client.app, base_url="http://127.0.0.1")
    token = anonymous.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": store.instance_id}).json()["session_token"]
    denied = anonymous.get(f"{base}/approvals/g1/items", headers={"Authorization": f"Bearer {token}"})
    assert denied.status_code == 403

    client.post(f"{base}/approvals", json={"decisions": [{"call_id": "g1", "approve": False}]})
    _wait_status(project_id, session_id, {"idle", "failed"})
    assert client.get(f"{base}/approvals/g1/items").status_code == 404  # 会话已不在待确认


def test_record_marks_each_item_and_totals_at_execution_time(client, fake_estimate, scheduled,
                                                             monkeypatch):
    project_id, session_id, base, _calls = _paused_batch(
        client, monkeypatch, _batch(("a", 1), ("b", 2), ("missing", 1)))
    _surfaces(project_id, {"a": "gpt-image-2", "b": "gpt-image-2"})
    client.post(f"{base}/messages", json={"text": "出图"})
    paused = _wait_status(project_id, session_id, {"awaiting_approval", "failed"})
    card = next(a for a in paused.pending_approvals if a.tool == "run_generations")
    assert "未计价" in card.summary.splitlines()[1]
    # 卡片生成之后估价变了（价格表更新）：执行记录用执行那一刻的估价。
    monkeypatch.setattr(cost, "_estimate", lambda _kind, _alias, model, params: 1.5 * params.get("n", 1))
    decided = client.post(f"{base}/approvals", json={"decisions": [
        {"call_id": "g1", "approve": True, "items": [0, 2]}]})
    assert decided.status_code == 202
    done = _wait_status(project_id, session_id, {"idle", "failed"})
    record = next(m.text for m in done.messages if m.title == "run_generations").splitlines()
    assert record[0] == "已提交 1 项，已拒绝 1 项，失败 1 项"
    assert record[1] == "1. 角色1 · gpt-image-2 · 1 张 · 预计 1.5¥ — 已提交"
    assert record[2] == "2. 角色2 · gpt-image-2 · 2 张 · 预计 3¥ — 已拒绝"
    assert record[3] == "3. missing · 读不到生成配置 · 1 张 · 未计价 — 失败：INVALID_TARGET：找不到这个生成节点"
    assert record[4] == "已提交项合计预计 1.5¥"


def _set_model(project_id: str, node_id: str, model: str) -> None:
    tools.apply_changes(runtime.LOCAL, ApplyChangesInput(
        project_id=project_id, expected_revision=read_canvas_document(project_id).revision,
        changes=[{"op": "set_draft", "node_id": node_id, "mode": "image", "prompt": "一只猫",
                  "model": model, "alias": "img", "params": {}}]))
