import { expect, it } from 'vitest';
import type { CanvasImageNode, CanvasLayerStackNode } from '@/schema/canvas';
import { canvasLayerMaterialConnections } from './canvasLayerMaterialConnections';

const material: CanvasImageNode = { id: 'material', type: 'image', title: '标题', position: { x: 0, y: 0 }, z_index: 0,
  data: { current_version_id: 'version', active_run_id: null, generation_draft: null, display: { fit: 'contain', free_resize: false } } };
const stack: CanvasLayerStackNode = { id: 'stack', type: 'layer_stack', title: '拆分图层', position: { x: 0, y: 0 }, z_index: 0,
  data: { source_version_id: 'source', base_version_id: 'base', base_material_node_id: 'background', base_visible: true,
    prompt: '', alias: null, model: null, resolution: 'auto', active_run_id: null, error: null,
    layers: [{ id: 'title', version_id: 'version', material_node_id: material.id, name: '活动标题', description: '',
      z_index: 1, visible: true, bounding_box: { absolute: [0, 0, 10, 10], normalized: [0, 0, 1000, 1000] } }],
  } };

it('derives layer-named associations from existing bindings without writing edges', () => {
  const nodes = [stack, material, { ...material, id: 'background' }];
  const before = structuredClone(nodes);
  expect(canvasLayerMaterialConnections(nodes)).toEqual([
    { id: 'layer-material:stack:base', role: 'material', source_node_id: 'stack', target_node_id: 'background', layerName: '背景' },
    { id: 'layer-material:stack:layer:title', role: 'material', source_node_id: 'stack', target_node_id: 'material', layerName: '活动标题' },
  ]);
  expect(nodes).toEqual(before);
  expect(canvasLayerMaterialConnections([stack])).toEqual([]);
  expect(canvasLayerMaterialConnections([{ ...stack, data: { ...stack.data, layers: [] } }, material])).toEqual([]);
});
