"""成员端：同一把网关幂等键的主机扣费只记一次（第 6 批 6-2a，管理会话定的对称规则）。

成员停止一个已发上游的网关任务后，主机照常跑完并扣费（飙哥定 Q3-1=B）。这笔扣费可能被两条成员任务拿到：
原「已停止」那条（补发线程拿到主机终态时回写）、和「再次生成」接回原任务的那条（接回成功时按主机结算记账）。
两条用同一把幂等键。规则：谁先拿到主机终态谁记金额；另一条不记，在 `gateway_charged_on` 里指明记在哪条。

裁决用 `<data_root>/.runtime/gateway-charges/<幂等键>.json`：先写临时文件、再 `os.link` 到最终名——
同名已存在时 link 失败，所以「第一个」由文件系统裁决。不支持硬链接的目录退回独占创建（`open(final, "x")`），
这时读方可能读到还没写完的文件，等一下再读。查找是 O(1)，不扫任务目录。`claim` 永不抛异常（见函数说明）。
文件 48 小时后清理（幂等键 20 小时后已不再接回或补发）。
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_KEY = re.compile(r"^\d{9,12}-[0-9a-f]{32}$")
RETENTION_SECONDS = 48 * 3600
READ_ATTEMPTS = 100
READ_INTERVAL_SECONDS = 0.02

logger = logging.getLogger(__name__)


def _folder() -> Path:
    from character_workflow.lib import data_root

    folder = data_root.runtime_dir() / "gateway-charges"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def claim(idempotency_key: str, job_id: str) -> str:
    """登记「这把幂等键的主机扣费记在 job_id 上」；已被别的任务登记过就返回那一条的 job_id。

    永不抛异常：调用点在出图完成、下载产物之前（成员端记账）或补发线程里，抛出去会把已出图、已扣费的任务
    记成失败。硬链接不可用（exFAT / FAT32 外接盘、部分 SMB 与网盘同步目录）时退回独占创建，同样先到先得；
    其他任何文件系统错误、键格式不对时记日志并按「登记到自己」处理——宁可极端情况下重复记一笔，也不让任务失败或金额丢失。
    """
    if not _KEY.fullmatch(idempotency_key or ""):
        logger.warning("网关幂等键格式不对，扣费不做去重登记 job=%s", job_id)
        return job_id
    try:
        folder = _folder()
        final = folder / f"{idempotency_key}.json"
        if not final.exists():
            _prune(folder)
            if _create(folder, final, idempotency_key, job_id):
                return job_id
        return _read_holder(final, job_id)
    except OSError as error:
        logger.warning("扣费登记失败，按登记到本任务处理 job=%s：%s", job_id, type(error).__name__)
        return job_id


def _create(folder: Path, final: Path, idempotency_key: str, job_id: str) -> bool:
    """原子地「第一个创建 final」：先写临时文件再硬链接；不支持硬链接时独占创建后写入。抢输了返回 False。"""
    content = json.dumps({"job_id": job_id, "at": datetime.now(timezone.utc).isoformat()})
    temporary = folder / f".{idempotency_key}.{secrets.token_hex(6)}.tmp"
    temporary.write_text(content, encoding="utf-8")
    try:
        os.link(temporary, final)
        return True
    except FileExistsError:
        return False
    except OSError:
        pass  # 文件系统不支持硬链接：下面退回独占创建
    finally:
        temporary.unlink(missing_ok=True)
    try:
        with open(final, "x", encoding="utf-8") as handle:
            handle.write(content)
        return True
    except FileExistsError:
        return False


def _read_holder(final: Path, job_id: str) -> str:
    """读登记者。独占创建的那一方可能还没写完（文件已建、内容为空）：等一下再读，最多约 2 秒。"""
    pause = threading.Event()
    for _ in range(READ_ATTEMPTS):
        try:
            return str(json.loads(final.read_text(encoding="utf-8"))["job_id"])
        except (ValueError, KeyError, TypeError):
            pause.wait(READ_INTERVAL_SECONDS)
    logger.warning("扣费登记文件一直读不出，按登记到本任务处理 job=%s", job_id)
    return job_id


def owner(idempotency_key: str) -> str | None:
    """这把幂等键的扣费记在哪条任务上；还没人记或读不出时为 None。"""
    if not _KEY.fullmatch(idempotency_key or ""):
        return None
    try:
        path = _folder() / f"{idempotency_key}.json"
        return str(json.loads(path.read_text(encoding="utf-8"))["job_id"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _prune(folder: Path) -> None:
    """清掉 48 小时前的登记；清理失败不影响登记本身。"""
    cutoff = time.time() - RETENTION_SECONDS
    try:
        paths = list(folder.iterdir())
    except OSError:
        return
    for path in paths:
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue
