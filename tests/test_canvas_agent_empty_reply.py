"""模型正常结束但没有内容（空结束）：走真实的 build_agent + openai-agents + 本机套接字假上游，三种对话接口各一条。

- A：这一轮没执行过工具就空结束 → 会话 failed，提示「模型没有返回内容，可以重试或换个模型（模型 · token）」；
  末尾的空输出不进历史，用户直接再发一条，下一次请求的消息序列在各协议都合法。
- B：这一轮执行过工具（含确认后续跑时确认的那一步）后空结束 → 照常 idle，面板加一条「模型没有补充说明」，
  不进发给模型的历史。
都不自动重试。
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import keys
from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient

# ── 本机假上游：按顺序回放脚本里的流式响应，记下每次请求体 ────────────────────────────


def _sse(events: list[tuple[str | None, dict | str]]) -> bytes:
    lines = []
    for name, data in events:
        if name:
            lines.append(f"event: {name}")
        lines.append(f"data: {data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def chat(text: str = "", tool: tuple[str, dict] | None = None, reasoning_tokens: int = 0) -> bytes:
    base = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "m"}
    delta: dict = {"role": "assistant", "content": text}
    finish = "stop"
    if tool:
        delta = {"role": "assistant", "content": None, "tool_calls": [{
            "index": 0, "id": "call_1", "type": "function",
            "function": {"name": tool[0], "arguments": json.dumps(tool[1], ensure_ascii=False)}}]}
        finish = "tool_calls"
    return _sse([
        (None, {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}),
        (None, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}),
        (None, {**base, "choices": [], "usage": {
            "prompt_tokens": 100, "completion_tokens": 7 + reasoning_tokens, "total_tokens": 107,
            "completion_tokens_details": {"reasoning_tokens": reasoning_tokens}}}),
        (None, "[DONE]"),
    ])


def responses(text: str = "", reasoning_tokens: int = 0) -> bytes:
    """reasoning 条目之后：text 为空就什么都不给（只有 reasoning 的空结束），否则给一条 message。"""
    output: list[dict] = [{"type": "reasoning", "id": "rs_1", "summary": []}]
    if text:
        output.append({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": text, "annotations": []}]})
    response = {"id": "resp_1", "object": "response", "created_at": 0, "model": "m",
                "status": "completed", "output": output, "parallel_tool_calls": True,
                "tool_choice": "auto", "tools": [],
                "usage": {"input_tokens": 100, "output_tokens": 5 + reasoning_tokens, "total_tokens": 105,
                          "input_tokens_details": {"cached_tokens": 0},
                          "output_tokens_details": {"reasoning_tokens": reasoning_tokens}}}
    events: list[tuple[str | None, dict | str]] = [
        ("response.created", {"type": "response.created", "sequence_number": 0,
                              "response": {**response, "status": "in_progress", "output": []}})]
    for index, item in enumerate(output):
        events.append(("response.output_item.added", {"type": "response.output_item.added",
                                                      "sequence_number": 1 + 2 * index,
                                                      "output_index": index, "item": item}))
        events.append(("response.output_item.done", {"type": "response.output_item.done",
                                                     "sequence_number": 2 + 2 * index,
                                                     "output_index": index, "item": item}))
    events.append(("response.completed", {"type": "response.completed", "sequence_number": 9,
                                          "response": response}))
    return _sse(events)


def anthropic(text: str = "") -> bytes:
    start = {"type": "message_start", "message": {
        "id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "m",
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 1}}}
    blocks: list[tuple[str | None, dict | str]] = []
    if text:
        blocks = [("content_block_start", {"type": "content_block_start", "index": 0,
                                           "content_block": {"type": "text", "text": ""}}),
                  ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                           "delta": {"type": "text_delta", "text": text}}),
                  ("content_block_stop", {"type": "content_block_stop", "index": 0})]
    return _sse([("message_start", start), *blocks,
                 ("message_delta", {"type": "message_delta",
                                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                    "usage": {"output_tokens": 3}}),
                 ("message_stop", {"type": "message_stop"})])


class Upstream:
    def __init__(self) -> None:
        self.script: deque[bytes] = deque()
        self.requests: list[tuple[str, dict]] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                upstream.requests.append((self.path, body))
                payload = upstream.script.popleft()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def upstream(isolated_data_root):
    server = Upstream()
    keys.write_keys_db(keys.KeysDB(keys=[
        keys.KeySpec(alias=alias, provider="custom", base_url=server.base, access_key="local-fake-not-a-key",
                     created_at="2026-11-20T00:00:00Z",
                     models=[keys.ModelSpec(id="m", name="m", modality="text", protocol=protocol)])
        for alias, protocol in (("chat", "openai-chat"), ("resp", "openai-responses"),
                                ("anth", "anthropic-messages"))]))
    yield server
    server.server.shutdown()


@pytest.fixture
def client(upstream, isolated_data_root):
    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as test_client:
        yield test_client


def _session(client, alias: str, mode: str = "auto") -> tuple[str, str, str]:
    project_id = client.post("/api/canvas/projects", json={"name": "空回复"}).json()["project_id"]
    session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                             json={}).json()["session_id"]
    base = f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"
    client.patch(base, json={"model": "m", "model_alias": alias, "permission_mode": mode})
    return project_id, session_id, base


def _say(client, base: str, project_id: str, session_id: str, text: str, statuses=("idle", "failed")):
    assert client.post(f"{base}/messages", json={"text": text}).status_code == 202
    return _wait(project_id, session_id, set(statuses))


def _wait(project_id, session_id, statuses):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        session = read_canvas_agent_session(project_id, session_id)
        if session.status in statuses:
            return session
        time.sleep(0.05)
    raise AssertionError(session.status)


def _no_empty_output(history: list) -> None:
    """历史里不留空的 assistant 消息，也不留没有后续条目的 reasoning。"""
    for index, item in enumerate(history):
        if item.get("type") == "reasoning":
            assert index + 1 < len(history) and history[index + 1].get("role") != "user"
        if item.get("role") == "assistant":
            assert runtime._output_text(item).strip()


# ── A：没执行工具就空结束 → failed；可以直接再发一条，下一次请求在各协议都合法 ─────────────

@pytest.mark.parametrize(("alias", "empty", "reply", "path"), [
    pytest.param("chat", chat("", reasoning_tokens=40), chat("好"), "/v1/chat/completions", id="chat-stop-empty"),
    pytest.param("resp", responses("", reasoning_tokens=40), responses("好"), "/v1/responses",
                 id="responses-reasoning-only"),
    pytest.param("anth", anthropic(""), anthropic("好"), "/v1/messages", id="anthropic-end-turn-empty"),
])
def test_empty_first_reply_fails_and_the_session_continues(client, upstream, alias, empty, reply, path):
    project_id, session_id, base = _session(client, alias)
    upstream.script.extend([empty, reply])
    failed = _say(client, base, project_id, session_id, "画一只猫")
    assert failed.status == "failed"
    expected_tokens = "输出 3 token" if alias == "anth" else "输出 47 token" if alias == "chat" else "输出 45 token"
    assert failed.error.startswith(f"模型没有返回内容，可以重试或换个模型（{alias} / m · {expected_tokens}")
    if alias != "anth":
        assert failed.error.endswith("，其中思考 40）")
    assert [(m.role, m.text[:8]) for m in failed.messages] == [("user", "画一只猫"), ("error", "模型没有返回内容")]
    _no_empty_output(failed.history)
    assert [item.get("role") for item in failed.history] == ["user"]  # 这一轮的条目保留，空输出去掉

    # 不用新建会话，直接再发一条。
    done = _say(client, base, project_id, session_id, "再试一次")
    assert done.status == "idle" and done.error is None and done.messages[-1].text == "好"
    assert len(upstream.requests) == 2  # 没有自动重试
    sent_path, sent = upstream.requests[1]
    assert sent_path == path
    if alias == "chat":
        roles = [message["role"] for message in sent["messages"]]
        assert roles[-2:] == ["user", "user"] and "assistant" not in roles
    elif alias == "resp":
        assert all(item.get("type") != "reasoning" for item in sent["input"])
        assert [item.get("role") for item in sent["input"]][-2:] == ["user", "user"]
    else:
        assert all(message["content"] for message in sent["messages"])  # Anthropic 拒收空内容
        assert {message["role"] for message in sent["messages"]} == {"user"}


# ── B：执行过工具后空结束 → idle + 一条面板提示，不进历史 ───────────────────────────────

def test_empty_reply_after_tools_is_a_quiet_note(client, upstream):
    project_id, session_id, base = _session(client, "chat")
    upstream.script.extend([chat(tool=("get_canvas", {})), chat(""), chat("好")])
    done = _say(client, base, project_id, session_id, "看看画布")
    assert done.status == "idle" and done.error is None
    notes = [m for m in done.messages if m.role == "system"]
    assert [m.text for m in notes] == [runtime.NO_SUMMARY_NOTE] and runtime.NO_SUMMARY_NOTE == "模型没有补充说明"
    assert runtime.NO_SUMMARY_NOTE not in json.dumps(done.history, ensure_ascii=False)
    assert done.history[-1]["type"] == "function_call_output"  # 末尾的空回复去掉了
    assert len(upstream.requests) == 2  # 没有自动重试

    # 下一轮：提示不发给模型，工具结果后面接用户消息是合法序列。
    again = _say(client, base, project_id, session_id, "然后呢")
    sent = upstream.requests[2][1]["messages"]
    assert runtime.NO_SUMMARY_NOTE not in json.dumps(sent, ensure_ascii=False)
    assert [m["role"] for m in sent][-2:] == ["tool", "user"]
    assert [m.text for m in again.messages if m.role == "system"] == [runtime.NO_SUMMARY_NOTE]  # 每轮最多一条


def test_empty_reply_after_an_approved_tool_counts_as_tools_ran(client, upstream):
    project_id, session_id, base = _session(client, "chat", mode="review")
    note = {"changes": [{"op": "add_text", "node_id": "n1", "title": "笔记", "text": "x",
                         "position": {"x": 0, "y": 0}}]}
    upstream.script.extend([chat(tool=("apply_changes", note)), chat("")])
    paused = _say(client, base, project_id, session_id, "记一笔", statuses=("awaiting_approval", "failed"))
    assert paused.status == "awaiting_approval", paused.error
    decided = client.post(f"{base}/approvals", json={"decisions": [
        {"call_id": paused.pending_approvals[0].call_id, "approve": True}]})
    assert decided.status_code == 202
    done = _wait(project_id, session_id, {"idle", "failed"})
    assert done.status == "idle" and done.error is None
    assert [m.text for m in done.messages if m.role == "system"] == [runtime.NO_SUMMARY_NOTE]


def test_replies_with_text_and_paused_turns_get_no_note(client, upstream):
    project_id, session_id, base = _session(client, "chat")
    upstream.script.extend([chat("你好")])
    done = _say(client, base, project_id, session_id, "你好")
    assert done.status == "idle" and [m.role for m in done.messages] == ["user", "assistant"]


# ── SDK 抛出的三类异常 ──────────────────────────────────────────────────────────────

def test_sdk_refusal_length_and_incomplete_errors_are_explained():
    from agents.exceptions import ModelBehaviorError, ModelRefusalError

    refused = runtime.friendly_error(ModelRefusalError("Response withheld by the provider's content filter."))
    assert refused == ("模型拒绝了这次请求（服务商内容审核），可以换个说法或换个模型"
                       "（原始报错：Response withheld by the provider's content filter.）")
    truncated = runtime.friendly_error(ModelBehaviorError(
        "Chat Completions response terminated with finish_reason='length' but produced no assistant text, "
        "tool call, or refusal."))
    assert truncated.startswith("模型的输出额度在给出内容前用完了，可以重试、关掉思考或换个模型（原始报错：")
    incomplete = runtime.friendly_error(ModelBehaviorError(
        "Responses stream ended with terminal event `response.incomplete`. status=incomplete; "
        "incomplete_details=IncompleteDetails(reason='max_output_tokens')."))
    assert incomplete.startswith("对话模型返回错误：Responses stream ended with terminal event `response.incomplete`")
    other = runtime.friendly_error(ModelBehaviorError("Tool not_a_tool not found in agent"))
    assert other == "对话出错，详情见服务日志"
