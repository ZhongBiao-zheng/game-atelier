"""画布 Agent 看图：等生成结果、把图片放到模型眼前。

Chat Completions 的工具结果只收文本（SDK 默认丢掉图片），各家对「工具消息带图」支持不一。
所以工具结果里只写 `attach_images: [version_id]` 标记，每次调模型前由 call_model_input_filter
在那批工具结果后面插一条带缩略图的 user 消息。插入只影响这一次请求，不进会话历史；
只给最近 MAX_ATTACH_OUTPUTS 批、最多 MAX_ATTACH_IMAGES 张，旧结果靠文字描述，控制上下文成本。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import time
import uuid
from typing import Any, Callable

from character_workflow.lib import data_root

ATTACH_KEY = "attach_images"
# 插件工具返回的预览图（不是画布版本）存这里，attach_images 里写 PREVIEW_PREFIX + 文件名（ADR-0043）。
PREVIEW_PREFIX = "agent-image:"
# 只存工具结果里带回来的图（文件名由这里生成，不接受外部给的名字），24 小时后清理，
# 总量超过 MAX_PREVIEWS 张或 MAX_PREVIEW_TOTAL 字节时先删最旧的。会话历史里只留 agent-image: 引用，不落 data URL。
PREVIEW_TTL_S = 24 * 3600
MAX_PREVIEW_BYTES = 2 * 1024 * 1024
MAX_PREVIEWS = 200
MAX_PREVIEW_TOTAL = 64 * 1024 * 1024
_PREVIEW_TYPES = {"image/jpeg": "jpg", "image/png": "png"}
_PREVIEW_NAME = re.compile(r"^[0-9a-f]{32}\.(jpg|png)$")
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
            # 项目库与团队库各返回至多 12 张候选；同一批两边都搜时全给，模型才能放在一起比。
            libraries = {value.split(":", 1)[0] for value in pending if value.startswith(("asset:", "team:"))}
            limit = 12 * len(libraries) if libraries else MAX_ATTACH_IMAGES
            for version_id in list(dict.fromkeys(pending))[:limit]:
                url = data_url(version_id)
                if url:
                    content.append({"type": "input_text", "text": version_id})
                    content.append({"type": "input_image", "detail": "auto", "image_url": url})
            if len(content) > 1:
                result.append({"role": "user", "content": content})
            pending = []
    return result


def _previews_dir():
    return data_root.runtime_dir() / "agent-images"


def store_preview(preview: Any) -> str | None:
    """把 {mime_type, data_base64} 存成临时图片，返回可放进 attach_images 的引用；格式不对返回 None。"""
    if not isinstance(preview, dict) or preview.get("mime_type") not in _PREVIEW_TYPES:
        return None
    try:
        data = base64.b64decode(str(preview.get("data_base64", "")), validate=True)
    except (binascii.Error, ValueError):
        return None
    if not data or len(data) > MAX_PREVIEW_BYTES:
        return None
    directory = _previews_dir()
    directory.mkdir(parents=True, exist_ok=True)
    _prune_previews(directory, incoming=len(data))
    name = f"{uuid.uuid4().hex}.{_PREVIEW_TYPES[preview['mime_type']]}"
    (directory / name).write_bytes(data)
    return PREVIEW_PREFIX + name


def _prune_previews(directory, incoming: int) -> None:
    """删过期的；再按从旧到新删，直到加上这一张后不超过张数与总量上限。"""
    cutoff = time.time() - PREVIEW_TTL_S
    kept = []
    for path in directory.iterdir():
        try:
            stat = path.stat()
            if stat.st_mtime < cutoff or not _PREVIEW_NAME.fullmatch(path.name):
                path.unlink()
            else:
                kept.append((stat.st_mtime, stat.st_size, path))
        except OSError:
            continue
    kept.sort()
    total = sum(size for _, size, _ in kept) + incoming
    while kept and (len(kept) + 1 > MAX_PREVIEWS or total > MAX_PREVIEW_TOTAL):
        _, size, path = kept.pop(0)
        try:
            path.unlink()
        except OSError:
            pass
        total -= size


def preview_data_url(ref: str) -> str | None:
    """attach_images 里的预览引用 → data URL；过期、被清掉或名字不合规时为 None。"""
    name = ref.removeprefix(PREVIEW_PREFIX)
    if not _PREVIEW_NAME.fullmatch(name):
        return None
    try:
        data = (_previews_dir() / name).read_bytes()
    except OSError:
        return None
    mime = "image/png" if name.endswith(".png") else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
