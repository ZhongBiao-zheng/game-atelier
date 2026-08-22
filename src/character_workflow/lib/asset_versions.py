"""Formal asset version allocation, locking, and stable display ordering."""
from __future__ import annotations

import hashlib
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from character_workflow.lib.jobs import job_lock


_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
_VERSION_RE = re.compile(r"^v([1-9][0-9]*)$", re.IGNORECASE)
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


def first_image_version(directory: Path, root: Path) -> str | None:
    if not directory.is_dir():
        return None
    images = [
        path for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS
    ]
    if not images:
        return None

    def order(path: Path) -> tuple[int, int, str]:
        match = _VERSION_RE.fullmatch(path.stem)
        return (0, int(match.group(1)), path.name.casefold()) if match else (
            1, 0, path.name.casefold()
        )

    return min(images, key=order).resolve().relative_to(root.resolve()).as_posix()
