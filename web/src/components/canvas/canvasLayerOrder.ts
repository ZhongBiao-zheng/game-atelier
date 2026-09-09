import type { CanvasLayerStackLayer, CanvasLayerStackNode } from '@/schema/canvas';

export interface LayerStackPart {
  key: string;
  layer: CanvasLayerStackLayer | null;
  versionId: string;
  zIndex: number;
  name: string;
  visible: boolean;
}

/** Painter order: low to high. The layer panel presents its reverse. */
export function orderedLayerStackParts(node: CanvasLayerStackNode): LayerStackPart[] {
  const base: LayerStackPart[] = node.data.base_version_id ? [{
    key: 'base', layer: null, versionId: node.data.base_version_id,
    zIndex: node.data.base_z_index ?? 0, name: '背景', visible: node.data.base_visible,
  }] : [];
  return [...base, ...node.data.layers.map(layer => ({
    key: `layer:${layer.id}`, layer, versionId: layer.version_id,
    zIndex: layer.z_index, name: layer.name || `图层 ${layer.z_index}`, visible: layer.visible,
  }))].sort((a, b) => a.zIndex - b.zIndex);
}

export function moveLayerStackPart(
  node: CanvasLayerStackNode, sourceKey: string, targetKey: string, after: boolean,
): CanvasLayerStackNode {
  const ordered = orderedLayerStackParts(node).reverse();
  const source = ordered.find(part => part.key === sourceKey);
  if (!source || sourceKey === targetKey || !ordered.some(part => part.key === targetKey)) return node;
  const next = ordered.filter(part => part !== source);
  next.splice(next.findIndex(part => part.key === targetKey) + Number(after), 0, source);
  if (next.every((part, index) => part === ordered[index])) return node;
  const zByKey = new Map(next.reverse().map((part, z) => [part.key, z]));
  return { ...node, data: { ...node.data,
    base_z_index: zByKey.get('base') ?? 0,
    layers: node.data.layers.map(layer => ({ ...layer, z_index: zByKey.get(`layer:${layer.id}`)! })),
  } };
}
