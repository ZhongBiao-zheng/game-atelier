"""本机路径闸门：浏览器或团队库分享能触达的本机文件，必须落在数据根内的可公开区域。"""
from __future__ import annotations

from pathlib import Path

from character_workflow.lib import data_root


class DataRootFileMissing(ValueError):
    """路径合规，但本机没有这个文件。"""


def _is_protected(parts: tuple[str, ...]) -> bool:
    # macOS / Windows 默认大小写不敏感，resolve() 不规范化大小写；Windows 还会吞掉尾随点与空格。
    head = [part.casefold().rstrip(". ") for part in parts[:2]]
    if not head or head[0] == ".config":
        return True
    return head[0] == ".runtime" and (len(parts) < 3 or head[1] != "uploads")


def data_root_file(value: str) -> Path:
    """绝对路径或数据根相对路径 → 数据根内一个真实存在的文件（resolve 后的绝对路径）。

    resolve 后（symlink 已展开）必须在数据根内，不能在 .config/ 下，.runtime/ 下只认 uploads/。
    网络地址、非法路径、越界 → ValueError；文件不存在 → DataRootFileMissing（ValueError 子类）。
    """
    if value.startswith(("http://", "https://")):
        raise ValueError("网络地址不是本机文件")
    if "\x00" in value:
        raise ValueError("参考路径无效")
    root = data_root.resolve_data_root().resolve()
    raw = Path(value)
    try:
        path = (raw if raw.is_absolute() else root / raw).resolve()
    except (OSError, RuntimeError) as error:
        raise ValueError("参考路径无效") from error
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise ValueError("参考文件必须在数据目录内") from error
    if _is_protected(parts):
        raise ValueError("参考文件在受保护目录内")
    try:
        is_file = path.is_file()
    except OSError as error:
        raise ValueError("参考路径无效") from error
    if not is_file:
        raise DataRootFileMissing(f"本机找不到文件：{path.name}")
    return path
