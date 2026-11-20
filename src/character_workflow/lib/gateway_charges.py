"""成员端：同一把网关幂等键的主机扣费只记一次（第 6 批 6-2a，管理会话定的对称规则）。

成员停止一个已发上游的网关任务后，主机照常跑完并扣费（飙哥定 Q3-1=B）。这笔扣费可能被两条成员任务拿到：
原「已停止」那条（补发线程拿到主机终态时回写）、和「再次生成」接回原任务的那条（接回成功时按主机结算记账）。
两条用同一把幂等键。规则：谁先拿到主机终态谁记金额；另一条不记，在 `gateway_charged_on` 里指明记在哪条。

裁决用 `<data_root>/.runtime/gateway-charges/<幂等键>.json`：先写临时文件、再 `os.link` 到最终名——
同名已存在时 link 失败，所以「第一个」由文件系统裁决，读到的永远是写完整的内容。查找是 O(1)，不扫任务目录。
文件 48 小时后清理（幂等键 20 小时后已不再接回或补发）。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

_KEY = re.compile(r"^\d{9,12}-[0-9a-f]{32}$")
RETENTION_SECONDS = 48 * 3600


def _folder() -> Path:
    from character_workflow.lib import data_root

    folder = data_root.runtime_dir() / "gateway-charges"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def claim(idempotency_key: str, job_id: str) -> str:
    """登记「这把幂等键的主机扣费记在 job_id 上」；已被别的任务登记过就返回那一条的 job_id。"""
    if not _KEY.fullmatch(idempotency_key or ""):
        raise ValueError("网关幂等键格式不对，不能登记扣费")
    folder = _folder()
    final = folder / f"{idempotency_key}.json"
    if not final.exists():
        _prune(folder)
        temporary = folder / f".{idempotency_key}.{secrets.token_hex(6)}.tmp"
        temporary.write_text(json.dumps({
            "job_id": job_id, "at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")
        try:
            os.link(temporary, final)
            return job_id
        except FileExistsError:
            pass
        finally:
            temporary.unlink(missing_ok=True)
    return str(json.loads(final.read_text(encoding="utf-8"))["job_id"])


def owner(idempotency_key: str) -> str | None:
    """这把幂等键的扣费记在哪条任务上；还没人记时为 None。"""
    if not _KEY.fullmatch(idempotency_key or ""):
        return None
    path = _folder() / f"{idempotency_key}.json"
    try:
        return str(json.loads(path.read_text(encoding="utf-8"))["job_id"])
    except (FileNotFoundError, ValueError, KeyError):
        return None


def _prune(folder: Path) -> None:
    cutoff = time.time() - RETENTION_SECONDS
    for path in folder.iterdir():
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue
