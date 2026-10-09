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
        assert client.get(base).json()["permission_mode"] == "auto"  # 默认 Auto
        patched = client.patch(base, json={"model": "m", "model_alias": "chat",
                                           "permission_mode": "review"})
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
        # 待确认的调用只在裁决后出现一次，带上结果。
        assert [(m.role, m.title) for m in done.messages] == [
            ("user", None), ("tool", "run_generation"), ("assistant", None)]
        assert done.messages[1].text.startswith("已拒绝\n在节点 image-1")
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


def test_read_tools_never_wait_for_approval():
    # 回调对「参数无法解析」无效（Tuzi 的 Claude 给无参工具传空字符串），只读工具必须是常量 False。
    flags = {tool.name: tool.needs_approval for tool in runtime.build_tools()}
    assert all(flags[name] is False for name in runtime.READ_TOOLS)
    assert callable(flags["apply_changes"]) and callable(flags["run_generation"])


def test_apply_changes_schema_is_flat_and_bad_arguments_skip_approval():
    import json as _json
    text = _json.dumps(runtime._params_schema("apply_changes", {}))
    # 聚合商转给 Claude 时会丢 $defs：引用必须展开，否则模型看不到 op 字段自己编。
    assert "$ref" not in text and "$defs" not in text and '"op"' in text
    bad = {"changes": [{"action": "add_surface", "node_id": "x"}]}
    good = {"changes": [{"op": "add_surface", "kind": "image", "title": "t",
                         "position": {"x": 0, "y": 0}}]}
    assert runtime.arguments_valid("canvas-12345678", "apply_changes", bad) is False
    assert runtime.arguments_valid("canvas-12345678", "apply_changes", good) is True


def test_chat_models_are_enabled_text_models_that_can_use_tools(isolated_data_root, monkeypatch):
    from character_workflow.lib import canvas_agent_models as chat_models
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="hub", provider="custom", base_url="https://hub.invalid/v1",
        access_key="test-only-not-a-real-key", created_at="2026-10-08T00:00:00Z",
        models=[keys.ModelSpec(name="Claude", id="claude-x", modality="text"),
                keys.ModelSpec(name="出图", id="gpt-image-2", modality="image"),
                keys.ModelSpec(name="无工具", id="no-tools", modality="text"),
                keys.ModelSpec(name="未知", id="unknown", modality="text")],
    )]))
    monkeypatch.setattr(chat_models, "_cache", {})
    monkeypatch.setattr(chat_models, "_fetch", lambda key: {
        "claude-x": {"agent": True, "reasoning": True},
        "no-tools": {"agent": False, "reasoning": None},
        "doubao-lite-4k": {"agent": True, "reasoning": None},  # 上游有、用户没启用：不列
    })
    rows = chat_models.list_chat_models()["models"]
    assert [(row["model"], row["name"], row["reasoning"]) for row in rows] == [
        ("claude-x", "Claude", True), ("unknown", "未知", None)]


def _rows(kind: str) -> list[dict]:
    return {"image": [{"alias": "a", "model": "img-1"}, {"alias": "a", "model": "img-2"}],
            "video": [{"alias": "a", "model": "vid-1"}]}[kind]


def test_model_scope_follows_creation_mode_and_preference(monkeypatch):
    from character_workflow.lib import workshop_generation
    monkeypatch.setattr(workshop_generation, "model_rows", _rows)
    image_only = runtime.ModelScope("image", frozenset({("a", "img-2")}))
    assert [row["model"] for row in image_only.models("image")] == ["img-2"]
    assert image_only.models("video") == []
    # 关掉自动后只用勾选的：没勾视频模型就没有视频模型可用。
    mixed = runtime.ModelScope("all", frozenset({("a", "img-2")}))
    assert mixed.models("video") == []
    assert runtime.ModelScope("all", frozenset()).models("image") == []
    assert [row["model"] for row in runtime.ALL_MODELS.models("image")] == ["img-1", "img-2"]


def test_scope_of_session_keeps_selection_while_auto():
    session = SimpleNamespace(creation_mode="all", auto_models=True,
                              preferred_models=[SimpleNamespace(alias="a", model="img-2")])
    assert runtime.ModelScope.of(session).preferred is None
    session.auto_models = False
    assert runtime.ModelScope.of(session).preferred == frozenset({("a", "img-2")})


@pytest.mark.parametrize(("scope", "mode", "model", "error"), [
    (runtime.ModelScope("image"), "video", "vid-1", "不能生成视频"),
    (runtime.ModelScope("all", frozenset({("a", "img-2")})), "image", "img-1", "不在可用范围"),
    (runtime.ModelScope("all", frozenset({("a", "img-2")})), "image", "img-2", None),
    (runtime.ModelScope("all", frozenset()), "image", "img-1", "请用户先在模型偏好里选择"),
    (runtime.ModelScope("video"), "video", "vid-1", None),
])
def test_generation_is_gated_by_scope(monkeypatch, scope, mode, model, error):
    from character_workflow.lib import workshop_generation
    from character_workflow.lib.workshop import WorkshopError
    monkeypatch.setattr(workshop_generation, "model_rows", _rows)
    draft = SimpleNamespace(mode=mode, alias="a", model=model)
    document = SimpleNamespace(nodes=[SimpleNamespace(id="n", data=SimpleNamespace(
        generation_draft=draft))])
    monkeypatch.setattr(runtime, "read_canvas_document", lambda _project_id: document)
    if error is None:
        runtime._check_generation_allowed("p", "n", scope)
        return
    with pytest.raises(WorkshopError, match=error):
        runtime._check_generation_allowed("p", "n", scope)


def test_session_settings_store_creation_mode_and_preference(isolated_data_root):
    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as client:
        _project_id, _session_id, base = _session(client)
        patched = client.patch(base, json={"creation_mode": "image", "preferred_models": [
            {"alias": "a", "model": "img-2"}]})
        assert patched.status_code == 200, patched.json()
        assert patched.json()["creation_mode"] == "image"
        assert patched.json()["preferred_models"] == [{"alias": "a", "model": "img-2"}]
        assert client.patch(base, json={"preferred_models": []}).json()["preferred_models"] == []
        assert client.patch(base, json={"creation_mode": "3d"}).status_code == 422


def test_missing_draft_alias_is_filled_only_when_unique(monkeypatch):
    from character_workflow.lib import workshop_generation
    monkeypatch.setattr(workshop_generation, "model_rows", lambda kind: {
        "image": [{"alias": "Tuzi", "model": "seedream"}, {"alias": "A", "model": "gpt"},
                  {"alias": "B", "model": "gpt"}], "video": []}[kind])
    changes = [{"op": "set_draft", "node_id": "n", "mode": "image", "model": "seedream"},
               {"op": "set_draft", "node_id": "m", "mode": "image", "model": "gpt"},
               {"op": "add_text", "node_id": "t"}]
    filled = runtime._with_draft_aliases(changes, runtime.ALL_MODELS)
    assert filled[0]["alias"] == "Tuzi"
    assert "alias" not in filled[1]  # 两家都有：不猜，交给生成前的校验报错
    assert filled[2] == changes[2]
