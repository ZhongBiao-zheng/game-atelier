from copy import deepcopy
import json

import pytest

from character_workflow.lib import agent_context as context


def history_with_models(n):
    history = []
    models = [{"alias": "local", "model": f"model-{i}", "description": "参数说明" * 16}
              for i in range(12)]
    for turn in range(n):
        ref = f"upload:image-{turn}"
        call_id = f"call-{turn}"
        history.extend([
            {"role": "user", "content": [{"type": "input_text", "text": f"参考 {turn}"},
                                         {"type": "input_image", "detail": "auto",
                                          "image_url": context.MEDIA_SCHEME + ref}]},
            {"type": "function_call", "call_id": call_id, "name": "list_models", "arguments": "{}"},
            {"type": "function_call_output", "call_id": call_id,
             "output": json.dumps({"models": models}, ensure_ascii=False)},
        ])
    return history


def test_ten_turns_resolve_only_the_last_two_user_attachments():
    history = history_with_models(10)
    original = deepcopy(history)
    resolved = []

    def resolve(ref):
        resolved.append(ref)
        return "data:image/png;base64,AAAA"

    result = context.hydrate_user_images(history, resolve, "missing")
    for turn, item in enumerate(result[::3]):
        part = item["content"][-1]
        if turn < 8:
            assert part == {"type": "input_text", "text":
                            f"[早期参考图已省略：media_ref=upload:image-{turn}，需要时调用 read_media]"}
        else:
            assert part == {"type": "input_image", "detail": "auto", "image_url": "data:image/png;base64,AAAA"}
    assert resolved == ["upload:image-8", "upload:image-9"]
    assert len(result) == len(original) and history == original


@pytest.mark.parametrize("missing", ["（引用的素材已不可用）", "（引用的图片已不在画布上）"])
def test_text_only_users_count_and_unavailable_recent_media_uses_workspace_message(missing):
    history = history_with_models(2) + [{"role": "user", "content": "继续"}]
    result = context.hydrate_user_images(history, lambda _: None, missing)
    assert "media_ref=upload:image-0" in result[0]["content"][-1]["text"]
    assert result[3]["content"][-1] == {"type": "input_text", "text": missing}


def test_tool_boundary_advances_in_batches_and_keeps_stable_request_prefix():
    previous = []
    for n, boundary in enumerate((0, 0, 0, 0, 4, 4, 4, 4, 8, 8), start=2):
        history = history_with_models(n)
        original = deepcopy(history)
        hydrated = context.hydrate_user_images(history, lambda _: "data:image/png;base64,AAAA", "missing")
        filtered = context.fold_tool_outputs(hydrated)
        assert len(filtered) == len(history)
        for turn in range(n):
            call, output = filtered[3 * turn + 1:3 * turn + 3]
            assert call == original[3 * turn + 1]
            assert call["call_id"] == output["call_id"] == f"call-{turn}"
            if turn < boundary:
                assert output["output"] == "[已折叠早期模型列表（共 12 个），需要选型时重新调用 list_models]"
            else:
                assert output == original[3 * turn + 2]
        if n not in (2, 6, 10):
            assert filtered[:3 * boundary] == previous[:3 * boundary]
        assert history == original
        previous = filtered


@pytest.mark.parametrize(("name", "data", "expected"), [
    ("get_canvas", {"nodes": [[], []], "omitted_nodes": 3}, "[已折叠早期画布快照（共 5 个节点），以最新 get_canvas 为准]"),
    ("load_skill", {"skills": [{"name": "a"}, {"name": "b"}]}, "[已加载技能 a、b，需要细则时重新读取]"),
    ("read_skill_file", {"name": "a"}, "[已加载技能 a，需要细则时重新读取]"),
    ("search_library", {"assets": [{"asset_id": "a", "title": "猫", "width": 50}]},
     [{"media_ref": "asset:a", "title": "猫"}]),
    ("search_team", {"assets": [{"asset_id": "team:x/1", "title": "猫"}]},
     [{"media_ref": "team:x/1", "title": "猫"}]),
    ("wait_for_run", {"runs": {"job-1": {"status": "done", "outputs": [
        {"media_ref": "output:job-1:0", "kind": "image", "checks": []}]}}},
     [{"job_id": "job-1", "status": "done", "outputs": [{"media_ref": "output:job-1:0"}]}]),
    ("wait_for_runs", {"runs": [{"run_id": "r1", "job_id": "j", "status": "partial", "candidates": [
        {"status": "succeeded", "version_id": "v1", "checks": []},
        {"status": "failed", "error": "超时"}]}]}, [
        {"run_id": "r1", "job_id": "j", "status": "partial", "candidates": [
            {"status": "succeeded", "media_ref": "v1"}, {"status": "failed", "error": "超时"}]}]),
    ("wait_for_runs", {"runs": {"job-2": {"lookup_error": "已删除"}}},
     [{"job_id": "job-2", "lookup_error": "已删除"}]),
    ("get_run", {"job_id": "j", "status": "failed", "error": "超时"},
     {"job_id": "j", "status": "failed", "error": "超时"}),
])
def test_structured_tool_summaries(name, data, expected):
    history = history_with_models(6)
    history[1]["name"] = name
    history[2]["output"] = json.dumps({**data, "detail": "细节" * 450}, ensure_ascii=False)
    output = context.fold_tool_outputs(history)[2]["output"]
    assert (output if isinstance(expected, str) else json.loads(output)) == expected


@pytest.mark.parametrize(("name", "output"), [
    ("other", "字" * 800), ("other", "字" * 801), ("list_models", '{"models":' + " " * 800),
    ("load_skill", json.dumps({"skills": [{"error": "x" * 900}]})),
    ("read_skill_file", json.dumps({"path": "guide.md", "content": "x" * 900})),
    ("search_library", json.dumps({"assets": [None], "padding": "x" * 900})),
])
def test_unrecognized_output_falls_back_and_threshold_is_strict(name, output):
    history = history_with_models(6)
    history[1]["name"] = name
    history[2]["output"] = output
    expected = output if len(output) == 800 else f"{output[:300]}…（原文 {len(output)} 字符，已折叠）"
    assert context.fold_tool_outputs(history)[2]["output"] == expected


@pytest.mark.asyncio
async def test_tool_image_window_uses_original_markers_even_after_output_folding():
    from types import SimpleNamespace
    from character_workflow.lib import canvas_agent_runtime as runtime

    history = history_with_models(6)
    for turn in range(3):
        history[turn * 3 + 2]["output"] = json.dumps({"attach_images": [f"v{turn}"], "detail": "x" * 900})
    workspace = SimpleNamespace(media=lambda ref: f"data:image/png;base64,{ref}", missing_image="missing")
    data = SimpleNamespace(model_data=SimpleNamespace(input=history, instructions="instructions"))
    result = await runtime._run_config(workspace).call_model_input_filter(data)
    assert result.instructions == "instructions"
    tool_images = [item["content"][-1]["image_url"] for item in result.input
                   if item.get("role") == "user" and item["content"][0].get("text") == "上面工具结果里的图片："]
    assert tool_images == ["data:image/png;base64,v1", "data:image/png;base64,v2"]
