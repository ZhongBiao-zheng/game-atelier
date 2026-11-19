"""「这张图来自 PS 的哪个文档、哪个位置」：存在插件的项目状态里，按图片版本 id 索引。

发回时按顺序找来源：① 这张图自己；② 它的输入连线里恰好一张图有来源（生成结果回到原位）；
都没有就交给 PS 放进活动文档中心。节点被复制、换了版本，来源自然找不到，不猜。
"""
from __future__ import annotations

from typing import Any

MAX_ORIGINS = 500


def record(data: Any, version_id: str, origin: dict[str, Any]) -> dict[str, Any]:
    """返回加上这一条来源后的新状态；超过上限时丢掉最早的记录（状态文件上限 1 MiB）。"""
    current = data if isinstance(data, dict) else {}
    origins = {key: value for key, value in (current.get("origins") or {}).items() if isinstance(value, dict)}
    origins[version_id] = origin
    if len(origins) > MAX_ORIGINS:
        newest = sorted(origins.items(), key=lambda item: str(item[1].get("at", "")))[-MAX_ORIGINS:]
        origins = dict(newest)
    return {**current, "origins": origins}


def find_origin(data: Any, document: Any, node_id: str, version_id: str) -> dict[str, Any] | None:
    origins = (data or {}).get("origins") if isinstance(data, dict) else None
    if not isinstance(origins, dict):
        return None
    if isinstance(origins.get(version_id), dict):
        return origins[version_id]
    nodes = {node.id: node for node in document.nodes}
    sources = {
        source.data.current_version_id
        for edge in document.connections
        if edge.role == "input" and edge.target_node_id == node_id
        and (source := nodes.get(edge.source_node_id)) is not None
        and source.type == "image" and source.data.current_version_id
    }
    found = [origins[version] for version in sources if isinstance(origins.get(version), dict)]
    return found[0] if len(found) == 1 else None
