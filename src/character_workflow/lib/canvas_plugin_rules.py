"""画布文档里与插件清单有关的规则。

只核对「这次保存新增的」连线：文档读取与已有连线都不依赖插件是否还在，
所以停用或卸掉插件后，含它节点的画布照常打开、照常保存。
"""
from __future__ import annotations

from character_workflow.lib import plugin_registry
from character_workflow.lib.schemas import CanvasDocument


class PluginConnectionError(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "canvas_plugin_connection_rejected"
        self.message = message


def _plugin_inputs(document: CanvasDocument) -> dict[str, list[str]]:
    plugin_nodes = {node.id for node in document.nodes if node.type == "plugin"}
    inputs: dict[str, list[str]] = {}
    for edge in document.connections:
        if edge.role == "input" and edge.target_node_id in plugin_nodes:
            inputs.setdefault(edge.target_node_id, []).append(edge.source_node_id)
    return inputs


def validate_new_plugin_connections(current: CanvasDocument, updated: CanvasDocument) -> None:
    before = {(node_id, source) for node_id, sources in _plugin_inputs(current).items() for source in sources}
    after = _plugin_inputs(updated)
    added = {node_id for node_id, sources in after.items() if any((node_id, s) not in before for s in sources)}
    if not added:
        return
    nodes = {node.id: node for node in updated.nodes}
    enabled = plugin_registry.enabled_ids()
    records = {record.plugin_id: record for record in plugin_registry.scan()}
    for node_id in added:
        node = nodes[node_id]
        record = records.get(node.data.plugin_id)
        contribution = None
        if record is not None and record.lock is not None and node.data.plugin_id in enabled:
            contribution = next(
                (item for item in record.lock.contributes.nodes if item.type == node.data.node_type), None)
        if contribution is None:
            raise PluginConnectionError("这个插件未启用，不能连接新的素材。")
        sources = after[node_id]
        if contribution.max_inputs is not None and len(sources) > contribution.max_inputs:
            raise PluginConnectionError(f"「{node.title}」最多连接 {contribution.max_inputs} 个素材。")
        for source_id in sources:
            if (node_id, source_id) in before:
                continue
            source = nodes.get(source_id)
            if source is None or source.type not in contribution.input_modalities:
                raise PluginConnectionError(f"「{node.title}」不接收这种素材。")
