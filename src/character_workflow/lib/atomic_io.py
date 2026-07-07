"""原子写 sidecar/JSON 的统一入口。

唯一临时名 + os.replace：并发写同一目标各自独占 tmp，消除「共享死写 .tmp 被先到者
改名后，后到者 replace 撞空 → 500 / 丢写」的竞态（Skill 与 viewer-server 双进程、
或前端快速连点都可能并发命中同一 sidecar）。写失败清掉孤儿 tmp，避免唯一名累积。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

# Windows 上 os.replace 偶发 PermissionError(WinError 5/32)：Defender 正扫刚写出的
# tmp，或长驻 viewer-server / watcher 正读目标 job 文件 —— 短暂重试即可越过。不重试时这个
# 文件改名错误会顶替掉真正的失败原因（如厂商额度耗尽），落进 job.error 误导画师。
# POSIX 的 replace 原子、不命中此竞态，故仅在 nt 上重试，其它平台行为不变。
_REPLACE_ATTEMPTS = 10
_REPLACE_DELAY = 0.05


def _replace_with_retry(tmp: Path, path: Path) -> None:
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if os.name != "nt" or attempt == _REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(_REPLACE_DELAY)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        _replace_with_retry(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))
