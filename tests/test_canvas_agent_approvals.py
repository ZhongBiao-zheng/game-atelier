"""确认路径：先认领再执行、执行中的未预期异常、认领后进程退出（批 4 后续二）。"""
from __future__ import annotations

import json
import logging
import threading
import time
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib.canvas_agent_sessions import (
    mutate_canvas_agent_session, read_canvas_agent_session,
)
from character_workflow.lib.canvas_tool_common import CanvasToolError

from tests.test_canvas_agent_batch import FakeResult, _project, _wait_status, client  # noqa: F401

SECRET_PATH = "/Users/someone/game-atelier/.config/keys.json"


def _paused(client, monkeypatch, raws: list[SimpleNamespace]):  # noqa: F811
    """会话停在待确认，待确认的就是 raws；续跑时模型直接回一句话。返回 (project_id, session_id, base)。"""
    calls: list[list[dict]] = []

    async def fake_run_model(session, history, buffer):
        calls.append(history)
        context = runtime.TurnContext(session.project_id, session.permission_mode)
        if len(calls) == 1:
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
    assert client.post(f"{base}/messages", json={"text": "改一下"}).status_code == 202
    paused = _wait_status(project_id, session_id, {"awaiting_approval", "failed"})
    assert paused.status == "awaiting_approval", paused.error
    return project_id, session_id, base


def _move(call_id: str, node_id: str = "a") -> SimpleNamespace:
    return SimpleNamespace(call_id=call_id, name="apply_changes", arguments=json.dumps({"changes": [
        {"op": "move", "node_id": node_id, "position": {"x": 1, "y": 1}}]}))


def _outputs(history: list) -> dict[str, str]:
    return {item["call_id"]: item["output"] for item in history
            if isinstance(item, dict) and item.get("type") == "function_call_output"}


def test_two_concurrent_decisions_execute_once(client, monkeypatch):  # noqa: F811
    project_id, session_id, base = _paused(client, monkeypatch, [_move("m1")])
    executed: list[str] = []

    def slow_execute(_project_id, tool, *_args):
        executed.append(tool)
        time.sleep(0.3)
        return {"ok": True}, []

    monkeypatch.setattr(runtime, "execute_tool", slow_execute)
    errors: list[CanvasToolError] = []

    def decide():
        try:
            runtime.resolve_approvals(project_id, session_id, {"m1": True})
        except CanvasToolError as error:
            errors.append(error)

    threads = [threading.Thread(target=decide) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert executed == ["apply_changes"]
    assert [(error.code, error.status) for error in errors] == [("SESSION_BUSY", 409)]
    # 接口上再裁决一次同样是 409，不会把已执行的调用再执行一遍。
    again = client.post(f"{base}/approvals", json={"decisions": [{"call_id": "m1", "approve": True}]})
    assert again.status_code == 409 and executed == ["apply_changes"]


def test_unexpected_error_in_one_call_keeps_the_others_running(client, monkeypatch, caplog):  # noqa: F811
    project_id, session_id, _base = _paused(client, monkeypatch, [_move("m1"), _move("m2", "b")])
    executed: list[str] = []

    def execute(_project_id, tool, arguments, *_args):
        node = arguments["changes"][0]["node_id"]
        executed.append(node)
        if node == "a":
            raise OSError(f"写入失败：{SECRET_PATH}")
        return {"ok": True}, []

    monkeypatch.setattr(runtime, "execute_tool", execute)
    with caplog.at_level(logging.ERROR, logger=runtime.logger.name):
        session = runtime.resolve_approvals(project_id, session_id, {"m1": True, "m2": True})
    assert executed == ["a", "b"]  # 第一个出错，第二个照常执行
    assert session.status == "running" and session.pending_approvals == []
    outputs = _outputs(session.history)
    assert set(outputs) == {"m1", "m2"}  # 每个调用都有输出
    assert outputs["m1"].startswith("错误（UNEXPECTED）：执行时出现未预期错误（OSError）")
    assert "不要重试" in outputs["m1"] and SECRET_PATH not in outputs["m1"]
    assert json.loads(outputs["m2"]) == {"ok": True}
    panel = [m.text for m in session.messages if m.role == "tool"]
    assert panel[0].startswith("执行出错，可能已部分生效，请查看画布")
    assert SECRET_PATH not in "".join(panel)
    # 完整堆栈留在日志里。
    record = next(r for r in caplog.records if "failed unexpectedly" in r.getMessage())
    assert record.exc_info is not None and record.exc_info[0] is OSError


def test_auto_path_turns_an_unexpected_error_into_a_tool_error(isolated_data_root, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError(f"调度失败 {SECRET_PATH}")

    monkeypatch.setattr(runtime, "execute_tool", boom)
    text, created = runtime.run_tool_safely("canvas-aaaaaaaa", "run_generation", {"surface_node_id": "a"})
    assert text.startswith("错误（UNEXPECTED）：执行时出现未预期错误（RuntimeError）")
    assert SECRET_PATH not in text and created == []
    assert runtime.tool_error_label(text) == runtime.UNEXPECTED_LABEL


def test_process_exit_after_claim_answers_dangling_calls_on_restart(client, monkeypatch):  # noqa: F811
    project_id, session_id, base = _paused(client, monkeypatch, [_move("m1"), _move("m2", "b")])
    # 认领之后、写回输出之前进程退出：会话停在 running，待确认已清空，历史里两个调用没有输出。
    mutate_canvas_agent_session(project_id, session_id,
                                lambda _current, _now: {"status": "running", "pending_approvals": []})
    reopened = client.get(base)  # 重启后打开面板：没有对应任务 → 标成中断
    assert reopened.status_code == 200
    session = read_canvas_agent_session(project_id, session_id)
    assert session.status == "interrupted" and session.pending_approvals == []
    outputs = _outputs(session.history)
    assert set(outputs) == {"m1", "m2"}
    assert all("已中断" in text and "可能已经部分生效" in text and "不要重试" in text
               for text in outputs.values())
    # 可以继续对话：新消息排在补上的输出之后。
    assert client.post(f"{base}/messages", json={"text": "现在怎样了"}).status_code == 202


def test_refreshing_the_panel_while_decisions_run_does_not_interrupt(client, monkeypatch):  # noqa: F811
    project_id, session_id, base = _paused(client, monkeypatch, [_move("m1")])
    started = threading.Event()

    def slow_execute(*_args):
        started.set()
        time.sleep(0.5)
        return {"ok": True}, []

    monkeypatch.setattr(runtime, "execute_tool", slow_execute)
    results: list[int] = []
    thread = threading.Thread(target=lambda: results.append(client.post(
        f"{base}/approvals", json={"decisions": [{"call_id": "m1", "approve": True}]}).status_code))
    thread.start()
    assert started.wait(5)
    assert client.get(base).json()["status"] == "running"  # 不是 interrupted
    thread.join()
    assert results == [202]
    done = _wait_status(project_id, session_id, {"idle", "failed", "interrupted"})
    assert done.status == "idle"
    assert "已中断" not in json.dumps(done.history, ensure_ascii=False)


@pytest.mark.parametrize("decisions", [
    [{"call_id": "m1", "approve": True, "items": [0]}],  # 逐项选择只给批量生成
    [{"call_id": "other", "approve": True}],
])
def test_bad_decisions_leave_the_card_in_place(client, monkeypatch, decisions):  # noqa: F811
    project_id, session_id, base = _paused(client, monkeypatch, [_move("m1")])
    assert client.post(f"{base}/approvals", json={"decisions": decisions}).status_code == 422
    session = read_canvas_agent_session(project_id, session_id)
    assert session.status == "awaiting_approval" and [a.call_id for a in session.pending_approvals] == ["m1"]
