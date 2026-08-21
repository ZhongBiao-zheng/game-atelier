"""正式资产目录的版本号分配与跨进程互斥。"""
from __future__ import annotations

import hashlib
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from character_workflow.lib.jobs import job_lock


_VERSION_FILE = re.compile(r"^v(?P<number>[1-9]\d*)\.[A-Za-z0-9]+$")


@contextmanager
def asset_output_lock(output_dir: Path) -> Iterator[None]:
    """同一资产目录的所有版本写入共用一把跨进程锁。"""
    key = hashlib.sha256(str(output_dir.resolve()).encode("utf-8")).hexdigest()
    with job_lock(f"asset-output-{key}"):
        yield


def next_asset_path(output_dir: Path, extension: str) -> Path:
    """返回跨文件格式唯一的下一个版本路径；调用方必须持有 asset_output_lock。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = extension.lstrip(".").lower()
    if not suffix or not suffix.isalnum():
        raise ValueError(f"invalid asset extension: {extension!r}")
    versions = [
        int(match.group("number"))
        for path in output_dir.iterdir()
        if path.is_file() and (match := _VERSION_FILE.fullmatch(path.name))
    ]
    return output_dir / f"v{max(versions, default=0) + 1}.{suffix}"
