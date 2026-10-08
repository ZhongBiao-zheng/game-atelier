"""画布内置 Agent：权限分类、对话模型筛选、一轮对话停在待确认再续跑（模型用假实现）。"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib import canvas_agent_tools as tools, keys
from character_workflow.lib.canvas_agent_models import is_chat_model
from character_workflow.lib.canvas_agent_runtime import needs_confirmation
from character_workflow.lib.canvas_agent_schema import ImportMediaInput
from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient


@pytest.mark.parametrize(("tool", "arguments", "mode", "created", "expected"), [
    ("get_canvas", {}, "review", set(), False),
    ("read_media", {"version_id": "v"}, "auto", set(), False),
    ("run_generation", {"surface_node_id": "n"}, "review", set(), True),
    ("run_generation", {"surface_node_id": "n"}, "auto", set(), False),
    ("apply_changes", {"changes": [{"op": "add_surface"}, {"op": "connect"}]}, "review", set(), True),
    ("apply_changes", {"changes": [{"op": "add_surface"}, {"op": "connect"}]}, "auto", set(), False),
    # Auto 下改本会话新建的节点仍算新增；改用户原有节点、断线一律确认。
    ("apply_changes", {"changes": [{"op": "set_draft", "node_id": "mine"}]}, "auto", {"mine"}, False),
    ("apply_changes", {"changes": [{"op": "set_draft", "node_id": "theirs"}]}, "auto", {"mine"}, True),
    ("apply_changes", {"changes": [{"op": "remove_node", "node_id": "theirs"}]}, "auto", set(), True),
    ("apply_changes", {"changes": [{"op": "disconnect", "connection_id": "e"}]}, "auto", set(), True),
    # 混合批次：一项需要确认，整批确认。
    ("apply_changes", {"changes": [{"op": "add_text"}, {"op": "move", "node_id": "x"}]}, "auto",
     set(), True),
])
def test_permission_matrix(tool, arguments, mode, created, expected):
    assert needs_confirmation(tool, arguments, mode, created) is expected


@pytest.mark.parametrize(("item", "expected"), [
    ({"id": "anthropic/claude-haiku-5.5", "architecture": {"output_modalities": ["text"]},
      "supported_parameters": ["tools", "reasoning"]}, True),
    ({"id": "anthropic/claude-haiku-5.5:batch", "architecture": {"output_modalities": ["text"]},
      "supported_parameters": ["tools"]}, False),
    ({"id": "some/model", "architecture": {"output_modalities": ["text"]},
      "supported_parameters": []}, False),
    ({"id": "google/gemini-3-pro-image", "architecture": {"output_modalities": ["image", "text"]},
      "supported_parameters": ["tools"]}, False),
    ({"id": "glm-5", "supported_protocols": ["openai:chat-completions"]}, True),
    ({"id": "seedance-2.0", "supported_protocols": ["seedance"]}, False),
    ({"id": "claude-sonnet-5-5", "supported_endpoint_types": ["anthropic", "openai"]}, True),
    ({"id": "gpt-image-2", "supported_endpoint_types": ["image-generation"]}, False),
    ({"id": "nano-banana-pro", "supported_endpoint_types": ["openai"]}, False),
    ({"id": "deepseek-chat"}, True),
])
def test_chat_model_filter(item, expected):
    assert is_chat_model(item) is expected


class FakeResult:
    def __init__(self, items: list[dict], interruptions: list | None = None) -> None:
        self._items = items
        self.interruptions = interruptions or []
        self.context_wrapper = SimpleNamespace(usage=SimpleNamespace(input_tokens=10,
                                                                     output_tokens=5))

    def to_input_list(self) -> list[dict]:
        return self._items


def _wait_status(project_id: str, session_id: str, statuses: set[str]):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        session = read_canvas_agent_session(project_id, session_id)
        if session.status in statuses:
            return session
        time.sleep(0.05)
    raise AssertionError(f"session stuck in {session.status}")


@pytest.fixture
def chat_key(isolated_data_root):
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="chat", provider="custom", base_url="https://chat.invalid/v1",
        access_key="test-only-not-a-real-key", created_at="2026-10-08T00:00:00Z",
    )]))


def _session(client: LocalTestClient) -> tuple[str, str, str]:
    project_id = client.post("/api/canvas/projects", json={"name": "Agent"}).json()["project_id"]
    session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                             json={}).json()["session_id"]
    return project_id, session_id, f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"


def test_turn_pauses_for_approval_then_continues_after_reject(isolated_data_root, chat_key,
                                                              monkeypatch):
    calls: list[list[dict]] = []

    async def fake_run_model(session, history, buffer):
        calls.append(history)
        buffer.add("好的")
        buffer.flush()
        context = runtime.TurnContext(session.project_id, session.permission_mode)
        if len(calls) == 1:
            call = {"type": "function_call", "call_id": "call-1", "name": "run_generation",
                    "arguments": json.dumps({"surface_node_id": "image-1"})}
            raw = SimpleNamespace(call_id="call-1", name="run_generation",
                                  arguments=call["arguments"])
            return FakeResult([*history, call], [SimpleNamespace(raw_item=raw)]), context
        reply = {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "那先不生成，你想怎么改？"}]}
        return FakeResult([*history, reply]), context

    monkeypatch.setattr(runtime, "run_model", fake_run_model)
    image_path = isolated_data_root / "ref.png"
    Image.new("RGB", (8, 8), "red").save(image_path)

    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as client:
        project_id, session_id, base = _session(client)
        imported = tools.import_media(runtime.LOCAL, ImportMediaInput(
            project_id=project_id, expected_revision=0, path=str(image_path), title="参考"))

        refused = client.post(f"{base}/messages", json={"text": "出图"})
        assert refused.status_code == 422  # 还没选对话模型
        patched = client.patch(base, json={"model": "m", "model_alias": "chat"})
        assert patched.status_code == 200 and patched.json()["permission_mode"] == "review"

        sent = client.post(f"{base}/messages",
                           json={"text": "按参考出一张图", "node_ids": [imported["node_id"]]})
        assert sent.status_code == 202, sent.json()
        paused = _wait_status(project_id, session_id, {"awaiting_approval", "failed"})
        assert paused.status == "awaiting_approval", paused.error
        assert [a.call_id for a in paused.pending_approvals] == ["call-1"]
        assert paused.title == "按参考出一张图"

        # 发给模型的是缩略图 data URL，落盘的历史只有 atelier-media 引用。
        sent_image = calls[0][0]["content"][-1]["image_url"]
        assert sent_image.startswith("data:image/jpeg;base64,")
        stored = json.dumps(paused.history)
        assert f"atelier-media://{imported['version_id']}" in stored and "data:" not in stored

        assert client.post(f"{base}/messages", json={"text": "再来"}).status_code == 409
        partial = client.post(f"{base}/approvals", json={"decisions": [
            {"call_id": "other", "approve": True}]})
        assert partial.status_code == 422

        rejected = client.post(f"{base}/approvals", json={"decisions": [
            {"call_id": "call-1", "approve": False}]})
        assert rejected.status_code == 202, rejected.json()
        done = _wait_status(project_id, session_id, {"idle", "failed"})
        assert done.status == "idle", done.error
        assert calls[1][-1] == {"type": "function_call_output", "call_id": "call-1",
                                "output": "用户拒绝了这个操作。"}
        assert [(m.role, m.title) for m in done.messages] == [
            ("user", None), ("tool", "run_generation"), ("tool", "run_generation"),
            ("assistant", None)]
        assert done.messages[0].references[0].node_id == imported["node_id"]
        assert done.messages[-1].text == "那先不生成，你想怎么改？"
        assert done.token_usage.input_tokens == 20


def test_model_failure_lands_in_session_as_error(isolated_data_root, chat_key, monkeypatch):
    async def broken(session, history, buffer):
        raise RuntimeError("boom")

    monkeypatch.setattr(runtime, "run_model", broken)
    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as client:
        project_id, session_id, base = _session(client)
        client.patch(base, json={"model": "m", "model_alias": "chat"})
        assert client.post(f"{base}/messages", json={"text": "你好"}).status_code == 202
        failed = _wait_status(project_id, session_id, {"failed"})
        assert failed.messages[-1].role == "error"
        assert failed.error == "对话出错，详情见服务日志"
        # 失败后可以继续发下一条。
        assert client.post(f"{base}/messages", json={"text": "再试"}).status_code == 202


def test_assistant_text_with_local_path_is_redacted_not_rejected():
    items = [{"type": "message", "role": "assistant",
              "content": [{"type": "output_text", "text": "文件在 /Users/someone/secret.png 里"}]}]
    [message] = runtime.display_messages(items, "turn-1")
    assert "/Users/someone" not in message.text and "[已隐藏]" in message.text
