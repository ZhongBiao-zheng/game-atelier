"""PS 联动给 Agent 的能力（第 2 批，ADR-0043）：读文档、预览、执行任意脚本；脚本开关与执行日志。

- 执行脚本只给 Agent（清单里 agent_only），浏览器经插件路由调不到。
- 开关「允许 Agent 在 Photoshop 里执行脚本」默认关；关着时 execute 从工具列表里藏起，直接调用也拒绝。
- 每次执行都记一行日志（全文、调用方、结果摘要），1 MiB 轮转留一份。
"""
from __future__ import annotations

import base64
import io
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry

from . import bridge

MAX_CODE_CHARS = 3600  # 确认卡摘要上限 4000 字，留出说明行，确认卡能显示脚本全文
EXECUTE_TIMEOUT_S = 120
LOG_MAX_BYTES = 1024 * 1024
LOG_SHOWN = 20
PREVIEW_MAX_BYTES = 600 * 1024  # base64 后仍在 MCP 适配器的 1 MiB 响应上限内
SCRIPTS_DISABLED = "在「设置 → 插件 → PS 联动」里打开「允许 Agent 执行脚本」后才能用"

_log_lock = threading.Lock()


def settings_file() -> Path:
    return data_root.config_dir() / "ps-bridge.json"


def scripts_allowed() -> bool:
    try:
        raw = json.loads(read_text_with_retry(settings_file()))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and raw.get("allow_scripts") is True


def set_scripts_allowed(allowed: bool) -> None:
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, {"allow_scripts": allowed})


def log_file() -> Path:
    return data_root.runtime_dir() / "ps-bridge" / "execute-log.jsonl"


def _rotated() -> Path:
    return log_file().with_name("execute-log.1.jsonl")


def _append_log(entry: dict) -> None:
    path = log_file()
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _log_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size + len(line.encode("utf-8")) > LOG_MAX_BYTES:
            path.replace(_rotated())
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)


def _lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def recent_log(limit: int = LOG_SHOWN) -> list[dict]:
    """最近的执行记录，新的在前（当前文件不够时接着读轮转留下的那一份）。"""
    entries: list[dict] = []
    for path in (log_file(), _rotated()):
        for line in reversed(_lines(path)):
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
            if len(entries) >= limit:
                return entries
    return entries


def inspect() -> dict:
    receipt, request = bridge.run("inspect", {})
    bridge.finish(request)
    return {key: receipt.get(key) for key in (
        "version", "documents", "active_document", "active_document_id", "layers", "layers_truncated")}


def _jpeg(png: bytes) -> tuple[bytes, int, int]:
    """预览 PNG → JPEG，压到 600 KB 以下（给模型看，不是交付物）。"""
    from PIL import Image
    with Image.open(io.BytesIO(png)) as image:
        rgb = image.convert("RGB")
    quality = 85
    while True:
        buffer = io.BytesIO()
        rgb.save(buffer, "JPEG", quality=quality)
        data = buffer.getvalue()
        if len(data) <= PREVIEW_MAX_BYTES or quality <= 40:
            return data, rgb.width, rgb.height
        quality -= 15


def preview(document_id: int) -> dict:
    receipt, request = bridge.run("preview", {"document_id": document_id},
                                  prepare=lambda request: {"out_png": str(request.path("preview.png"))})
    try:
        png = bridge.read_png(request, "preview.png")
    finally:
        bridge.finish(request)
    data, width, height = _jpeg(png)
    return {"document": receipt.get("document"), "width": width, "height": height,
            "preview": {"mime_type": "image/jpeg", "data_base64": base64.b64encode(data).decode("ascii")}}


def execute(code: str, document_id: int, caller: str, project_id: str | None) -> dict:
    if not scripts_allowed():
        raise bridge.PsError("PS_SCRIPTS_DISABLED", SCRIPTS_DISABLED, 403)
    started = time.monotonic()
    entry = {"at": datetime.now(timezone.utc).isoformat(), "caller": caller or "Agent",
             "project_id": project_id, "document_id": document_id, "code": code}

    def elapsed() -> int:
        return round((time.monotonic() - started) * 1000)

    try:
        receipt, request = bridge.run("execute", {"code": code, "document_id": document_id},
                                      timeout_s=EXECUTE_TIMEOUT_S)
    except bridge.PsError as error:
        _append_log({**entry, "ok": False, "error": error.message, "duration_ms": elapsed()})
        raise
    bridge.finish(request)
    _append_log({**entry, "ok": True, "error": None, "duration_ms": elapsed()})
    return {"value": receipt.get("value"), **{key: receipt.get(key) for key in (
        "documents", "active_document", "active_document_id", "layers", "layers_truncated")}}
