"""原子写 sidecar/JSON 的统一入口。

唯一临时名 + os.replace：并发写同一目标各自独占 tmp，消除「共享死写 .tmp 被先到者
改名后，后到者 replace 撞空 → 500 / 丢写」的竞态（Skill 与 viewer-server 双进程、
或前端快速连点都可能并发命中同一 sidecar）。写失败清掉孤儿 tmp，避免唯一名累积。
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))
