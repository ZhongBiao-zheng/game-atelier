"""团队库测试共用的 helper。"""
from __future__ import annotations

from character_workflow.lib import team_library_index as idx
from character_workflow.lib.schemas import TeamLibraryIndex


def scan_and_cache(mount) -> TeamLibraryIndex:
    """扫描并写本机索引缓存（refresh_team_library 去掉广播与并发票号的那部分）。"""
    index = idx.build_index(mount)
    idx.write_index(index)
    return index
