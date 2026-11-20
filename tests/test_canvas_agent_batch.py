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
    assert panel.startswith("已提交 2 项，已拒绝 1 项\n批量生成 3 项")
