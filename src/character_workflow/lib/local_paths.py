"""本机路径闸门：浏览器或团队库分享能触达的本机文件，必须落在数据根内的可公开区域。"""
from __future__ import annotations

from pathlib import Path

from character_workflow.lib import data_root


class DataRootFileMissing(ValueError):
    """路径合规，但本机没有这个文件。"""


def data_root_file(value: str) -> Path:
    """绝对路径或数据根相对路径 → 数据根内一个真实存在的文件。

    resolve 后（symlink 已展开）必须在数据根内，不能在 .config/ 下，.runtime/ 下只认 uploads/。
    网络地址、越界 → ValueError；文件不存在 → DataRootFileMissing（ValueError 子类）。
    """
    if value.startswith(("http://", "https://")):
        raise ValueError("网络地址的参考无法打包")
    root = data_root.resolve_data_root().resolve()
    raw = Path(value)
    path = (raw if raw.is_absolute() else root / raw).resolve()
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise ValueError("参考文件不在数据目录内") from error
    if not parts or parts[0] == ".config" or (
        parts[0] == ".runtime" and (len(parts) < 3 or parts[1] != "uploads")
    ):
        raise ValueError("参考文件不在允许打包的目录内")
    if not path.is_file():
        raise DataRootFileMissing(f"本机找不到文件：{path.name}")
    return path
