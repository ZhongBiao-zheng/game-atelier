import type { CanvasMaterialConnection, CanvasNode } from '@/schema/canvas';

export interface CanvasLayerMaterialConnection extends CanvasMaterialConnection {
  layerName: string;
}

/** View-only lines: ownership remains exclusively in the layer's material binding. */
export function canvasLayerMaterialConnections(nodes: readonly CanvasNode[]): CanvasLayerMaterialConnection[] {
  const imageIds = new Set(nodes.filter(node => node.type === 'image').map(node => node.id));
  return nodes.flatMap(node => {
    if (node.type !== 'layer_stack') return [];
    const parts = [
      { key: 'base', name: '背景', materialId: node.data.base_material_node_id },
      ...node.data.layers.map(layer => ({ key: `layer:${layer.id}`, name: layer.name || `图层 ${layer.z_index}`, materialId: layer.material_node_id })),
    ];
    return parts.flatMap(part => part.materialId && imageIds.has(part.materialId) ? [{
      id: `layer-material:${node.id}:${part.key}`, role: 'material' as const,
      source_node_id: node.id, target_node_id: part.materialId, layerName: part.name,
    }] : []);
  });
}
