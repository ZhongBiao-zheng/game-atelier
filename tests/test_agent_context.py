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
