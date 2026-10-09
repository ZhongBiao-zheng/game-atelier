"""画布 Agent 看图：结果图插在对应工具结果之后、只给最近几批，等待在终态停下。"""
from __future__ import annotations

import json

from character_workflow.lib import canvas_agent_vision as vision


def _output(call_id: str, images: list[str] | None = None) -> dict:
    body = {"status": "done", **({vision.ATTACH_KEY: images} if images else {})}
    return {"type": "function_call_output", "call_id": call_id, "output": json.dumps(body)}


def test_images_follow_their_tool_output_block_and_only_latest_batches():
    items = [
        {"role": "user", "content": "出图"},
        _output("a", ["v1"]),
        {"type": "message", "role": "assistant", "content": []},
        _output("b", ["v2"]),
        _output("c"),  # 同一批工具结果：图片插在整批之后，不能插进 tool 消息中间
        {"type": "message", "role": "assistant", "content": []},
        _output("d", ["v3", "v4", "v5", "v6", "v7"]),
    ]
    result = vision.with_attached_images(items, lambda vid: f"data:image/jpeg;base64,{vid}")
    injected = [(index, item) for index, item in enumerate(result)
                if isinstance(item, dict) and item.get("role") == "user" and index > 0]
    # 最近两批（b、d）才附图；a 那批只剩文字。
    assert [index for index, _ in injected] == [5, 8]
    assert result[4]["call_id"] == "c"
    first_images = [part["image_url"] for part in injected[0][1]["content"]
                    if part["type"] == "input_image"]
    second_images = [part for part in injected[1][1]["content"] if part["type"] == "input_image"]
    assert first_images == ["data:image/jpeg;base64,v2"]
    assert len(second_images) == vision.MAX_ATTACH_IMAGES


def test_missing_media_and_plain_outputs_leave_input_unchanged():
    items = [{"role": "user", "content": "hi"}, _output("a")]
    assert vision.with_attached_images(items, lambda vid: None) is items
    gone = [_output("a", ["v1"])]
    assert vision.with_attached_images(gone, lambda vid: None) == gone


async def test_wait_for_run_stops_at_terminal_status(monkeypatch):
    monkeypatch.setattr(vision, "POLL_SECONDS", 0)
    views = iter([
        {"status": "pending", "candidates": []},
        {"status": "done", "candidates": [
            {"status": "succeeded", "version_id": "img"},
            {"status": "succeeded", "version_id": "vid"},
            {"status": "failed", "version_id": None},
        ]},
    ])
    result = await vision.wait_for_run(lambda: next(views), lambda vid: vid == "img")
    assert result["status"] == "done"
    assert result[vision.ATTACH_KEY] == ["img"]
