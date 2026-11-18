"""坏落盘文件的统一处理：隔离原样保留、记一条不含内容的日志。

原因描述只取错误类型与字段位置：Pydantic 的错误文本会带上字段原值（提示词、网关密钥），
不能进日志。
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

logger = logging.getLogger(__name__)


def parse_reason(error: BaseException) -> str:
    if isinstance(error, ValidationError):
        fields = "; ".join(
            f"{'.'.join(str(part) for part in item['loc']) or '<root>'}: {item['type']}"
            for item in error.errors(include_input=False, include_url=False)[:3]
        )
        return f"校验不通过（{fields}）"
    if isinstance(error, UnicodeDecodeError):
        return f"不是 UTF-8 文本（位置 {error.start}）"
    # json.JSONDecodeError 的文本只有行列号，不含内容。
    return f"{type(error).__name__}: {error}"


def quarantine(path: Path, folder: Path, reason: str) -> Path | None:
    """把坏文件原样移到 folder；文件已被别人移走或删掉时返回 None。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = folder / f"{path.stem}.{stamp}{path.suffix}"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        os.replace(path, target)
    except FileNotFoundError:
        return None
    except OSError as error:
        logger.error("文件损坏且无法隔离：%s（%s；移动失败：%s）", path, reason, error)
        return None
    logger.error("文件损坏，已隔离：%s → %s（%s）", path, target, reason)
    return target


def count_files(folder: Path) -> int:
    try:
        return sum(1 for item in folder.iterdir() if item.is_file())
    except FileNotFoundError:
        return 0
