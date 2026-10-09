"""画布 Agent 看图：等生成结果、把图片放到模型眼前。

Chat Completions 的工具结果只收文本（SDK 默认丢掉图片），各家对「工具消息带图」支持不一。
所以工具结果里只写 `attach_images: [version_id]` 标记，每次调模型前由 call_model_input_filter
在那批工具结果后面插一条带缩略图的 user 消息。插入只影响这一次请求，不进会话历史；
只给最近 MAX_ATTACH_OUTPUTS 批、最多 MAX_ATTACH_IMAGES 张，旧结果靠文字描述，控制上下文成本。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable

ATTACH_KEY = "attach_images"
MAX_ATTACH_OUTPUTS = 2
MAX_ATTACH_IMAGES = 4
WAIT_SECONDS = 240
POLL_SECONDS = 3
TERMINAL_STATUSES = frozenset({"done", "partial", "failed", "canceled"})


def succeeded_version_ids(run_view: dict) -> list[str]:
    return [candidate["version_id"] for candidate in run_view.get("candidates") or []
            if candidate.get("version_id") and candidate.get("status") == "succeeded"]


async def wait_for_run(get_run: Callable[[], dict], is_image: Callable[[str], bool]) -> dict:
    """Poll a run until it reaches a terminal status or WAIT_SECONDS pass."""
    deadline = time.monotonic() + WAIT_SECONDS
    view = await asyncio.to_thread(get_run)
    while view.get("status") not in TERMINAL_STATUSES and time.monotonic() < deadline:
        await asyncio.sleep(POLL_SECONDS)
        view = await asyncio.to_thread(get_run)
    if view.get("status") not in TERMINAL_STATUSES:
        view = {**view, "note": "还在生成，稍后可再次调用 wait_for_run"}
    images = [vid for vid in succeeded_version_ids(view) if is_image(vid)][:MAX_ATTACH_IMAGES]
    return {**view, ATTACH_KEY: images} if images else view


def attached_ids(item: Any) -> list[str]:
    if not isinstance(item, dict) or item.get("type") != "function_call_output":
        return []
    output = item.get("output")
    if not isinstance(output, str) or ATTACH_KEY not in output:
        return []
    try:
        value = json.loads(output)
    except json.JSONDecodeError:
        return []
    ids = value.get(ATTACH_KEY) if isinstance(value, dict) else None
    return [str(v) for v in ids] if isinstance(ids, list) else []


def with_attached_images(items: list[Any], data_url: Callable[[str], str | None]) -> list[Any]:
    """Insert a user image message after each of the latest tool-output blocks carrying
    attach_images. data_url maps a version id to a thumbnail data URL, or None if gone."""
    marked = [index for index, item in enumerate(items) if attached_ids(item)]
    chosen = set(marked[-MAX_ATTACH_OUTPUTS:])
    if not chosen:
        return items
    result: list[Any] = []
    pending: list[str] = []
    for index, item in enumerate(items):
        result.append(item)
        if index in chosen:
            pending.extend(attached_ids(item))
        following = items[index + 1] if index + 1 < len(items) else None
        block_ends = not (isinstance(following, dict)
                          and following.get("type") == "function_call_output")
        if pending and block_ends:
            content: list[dict] = [{"type": "input_text", "text": "上面工具结果里的图片："}]
            for version_id in pending[:MAX_ATTACH_IMAGES]:
                url = data_url(version_id)
                if url:
                    content.append({"type": "input_text", "text": version_id})
                    content.append({"type": "input_image", "detail": "auto", "image_url": url})
            if len(content) > 1:
                result.append({"role": "user", "content": content})
            pending = []
    return result
