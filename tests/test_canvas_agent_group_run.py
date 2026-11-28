import asyncio
import json
from types import SimpleNamespace

import pytest
from character_workflow.lib import canvas_agent_runtime as agent, canvas_group_runs as runs
from character_workflow.lib.canvas_projects import canvas_project_dir, create_canvas_project
from tests.test_canvas_group_plan import group_document


@pytest.mark.parametrize("mode", ["auto", "review"])
def test_group_quote_then_real_approval(mode, monkeypatch):
    pid = create_canvas_project("整体执行").project_id
    doc = group_document(pid, [("a", "b")], ["a", "b"])
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    monkeypatch.setattr(agent.cost, "_estimate", lambda *args: 7.25)
    monkeypatch.setattr(agent.ModelScope, "models", lambda self, kind: [
        {"alias": None, "model": "test-model"}])
    monkeypatch.setattr(runs, "_launch", lambda *_: None)
    tool = next(tool for tool in agent.build_tools() if tool.name == "run_group")
    ctx = SimpleNamespace(context=agent.TurnContext(pid, mode), tool_call_id="quote")
    args = {"group_id": "group"}
    assert not asyncio.run(tool.needs_approval(ctx, args, "quote"))
    quote = json.loads(asyncio.run(tool.on_invoke_tool(ctx, json.dumps(args))))
    assert quote["total_cny"] == 14.5 and quote["order"] == ["a", "b"]
    args["quote_id"] = quote["quote_id"]
    assert asyncio.run(tool.needs_approval(ctx, args, "execute"))
    assert not runs.list_runs(pid)
    workspace = agent.CanvasWorkspace(pid, "session-test")
    summary = workspace.summary("run_group", args, [])
    assert "¥14.50" in summary and summary.count("¥7.25") == 2
    session = SimpleNamespace(creation_mode="all", auto_models=True, created_node_ids=[])
    approval = SimpleNamespace(tool="run_group", arguments=json.dumps(args))
    response, _, _ = workspace.execute_approved(session, approval, set(), frozenset())
    assert json.loads(response)["submitted_estimate_cny"] == 14.5
    run, = runs.list_runs(pid)
    assert [(s["node_id"], s["count"]) for s in run["steps"]] == [("a", 1), ("b", 1)]


def test_stale_agent_quote_cannot_start(monkeypatch):
    pid = create_canvas_project("估价").project_id
    doc = group_document(pid)
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    plan, _ = agent.execute_tool(pid, "run_group", {"group_id": "group"})
    monkeypatch.setattr(agent.cost, "_estimate", lambda *args: 6)
    response, _ = agent.run_tool_safely(pid, "run_group", {"group_id": "group", "quote_id": plan["quote_id"]})
    assert runs.STALE in response
    assert not runs.list_runs(pid)


@pytest.mark.parametrize(("mode", "price", "approval"), [
    ("auto", 3, False), ("auto", 5, False), ("auto", 5.01, True), ("review", 0, True),
])
def test_group_approval_compares_total_with_confirmed_limit(monkeypatch, mode, price, approval):
    pid = create_canvas_project("估价阈值").project_id
    doc = group_document(pid, [("a", "b")], ["a", "b"])
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    monkeypatch.setattr(agent.cost, "_estimate", lambda *args: price)
    monkeypatch.setattr(agent.ModelScope, "models", lambda self, kind: [
        {"alias": None, "model": "test-model"}])
    monkeypatch.setattr(runs, "_launch", lambda *_: None)
    tool = next(t for t in agent.build_tools() if t.name == "run_group")
    ctx = SimpleNamespace(context=agent.TurnContext(pid, mode), tool_call_id="group")
    args = {"group_id": "group"}
    assert not asyncio.run(tool.needs_approval(ctx, args, "group"))
    quote = json.loads(asyncio.run(tool.on_invoke_tool(ctx, json.dumps(args))))
    assert not runs.list_runs(pid)
    args["quote_id"] = quote["quote_id"]
    assert asyncio.run(tool.needs_approval(ctx, args, "group")) is approval
    if not approval:
        result = json.loads(asyncio.run(tool.on_invoke_tool(ctx, json.dumps(args))))
        assert result["submitted_estimate_cny"] == 2 * price
        assert len(runs.list_runs(pid)) == 1


@pytest.fixture
def nine_yuan_calls(monkeypatch):
    pid = create_canvas_project("本轮累计估价").project_id
    doc = group_document(pid, drafts=["a", "b"])
    first = doc.nodes[-1]
    first.data.member_node_ids = ["a"]
    second = first.model_copy(deep=True, update={"id": "other"})
    second.data.member_node_ids = ["b"]
    doc.nodes.append(second)
    (canvas_project_dir(pid) / "canvas.json").write_text(doc.model_dump_json())
    monkeypatch.setattr(agent.cost, "_estimate", lambda *args: 9)
    turn = agent.TurnContext(pid, "auto")
    tools = {t.name: t for t in agent.build_tools()}
    return turn, tools


async def quoted_group(tool, turn, group_id):
    args = {"group_id": group_id}
    ctx = SimpleNamespace(context=turn, tool_call_id=f"quote-{group_id}")
    assert not await tool.needs_approval(ctx, args, ctx.tool_call_id)
    quote = json.loads(await tool.on_invoke_tool(ctx, json.dumps(args)))
    assert quote["total_cny"] == 9
    return {**args, "quote_id": quote["quote_id"]}


@pytest.mark.asyncio
async def test_group_confirms_after_single_node_submission(nine_yuan_calls, monkeypatch):
    turn, tools = nine_yuan_calls
    group = tools["run_group"]
    args = await quoted_group(group, turn, "group")
    single = tools["run_generation"]
    ctx = SimpleNamespace(context=turn, tool_call_id="single")
    node = {"surface_node_id": "b"}
    assert not await single.needs_approval(ctx, node, "single")
    # Stub the submission only. The SDK callback still records its accepted estimate.
    monkeypatch.setattr(agent, "run_tool_safely", lambda *_: ('{"run_id":"accepted"}', []))
    result = json.loads(await single.on_invoke_tool(ctx, json.dumps(node)))
    assert result["submitted_estimate_cny"] == 9
    ctx.tool_call_id = "group"
    assert await group.needs_approval(ctx, args, "group")


@pytest.mark.asyncio
async def test_parallel_groups_reserve_against_the_same_limit(nine_yuan_calls):
    turn, tools = nine_yuan_calls
    group = tools["run_group"]

    async def check(group_id):
        args = await quoted_group(group, turn, group_id)
        ctx = SimpleNamespace(context=turn, tool_call_id=group_id)
        return await group.needs_approval(ctx, args, group_id)

    decisions = await asyncio.gather(check("group"), check("other"))
    assert sorted(decisions) == [False, True]
    assert not runs.list_runs(turn.project_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("group_id", ["group", "missing"])
async def test_unverifiable_group_quote_requires_confirmation(nine_yuan_calls, group_id):
    turn, tools = nine_yuan_calls
    group = tools["run_group"]
    ctx = SimpleNamespace(context=turn, tool_call_id="execute")
    args = {"group_id": group_id, "quote_id": "expired"}
    assert await group.needs_approval(ctx, args, ctx.tool_call_id)
    valid = await quoted_group(group, turn, "group")
    assert not await group.needs_approval(ctx, valid, "valid")
