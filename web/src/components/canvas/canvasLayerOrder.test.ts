import { describe, expect, it } from 'vitest';
import type { CanvasLayerStackNode } from '@/schema/canvas';
import { moveLayerStackPart, orderedLayerStackParts } from './canvasLayerOrder';

const stack: CanvasLayerStackNode = {
  id: 'stack', type: 'layer_stack', title: '拆分', position: { x: 0, y: 0 }, z_index: 0,
  data: { source_version_id: 'source', alias: null, model: null, prompt: '', resolution: 'auto',
    base_version_id: 'background', base_visible: true, base_material_node_id: 'background-node',
    active_run_id: null, error: null,
    layers: [1, 2, 3].map(z => ({ id: `part-${z}`, version_id: `image-${z}`, z_index: z,
      name: `素材${z}`, description: '', visible: z !== 2, material_node_id: `node-${z}`,
      bounding_box: { absolute: [0, 0, 10, 10], normalized: [0, 0, 100, 100] },
    })),
  },
};

describe('layer painter order', () => {
  it('derives order from z, not array position, without changing initial composition', () => {
    const reversed = { ...stack, data: { ...stack.data, layers: [...stack.data.layers].reverse() } };
    expect(orderedLayerStackParts(reversed).map(p => p.key)).toEqual(['base', 'layer:part-1', 'layer:part-2', 'layer:part-3']);
  });
  it('moves the background to the foreground and preserves all material identities', () => {
    const moved = moveLayerStackPart(stack, 'base', 'layer:part-3', false);
    expect(orderedLayerStackParts(moved).map(p => p.key)).toEqual(['layer:part-1', 'layer:part-2', 'layer:part-3', 'base']);
    expect(moved.data.base_z_index).toBe(3);
    expect(moved.data.base_material_node_id).toBe('background-node');
    moved.data.layers.forEach((layer, index) => expect(layer).toEqual({ ...stack.data.layers[index], z_index: index }));
    expect(stack.data.layers[0].z_index).toBe(1);
  });
  it('supports moves in both directions and roundtrip persistence', () => {
    const moved = moveLayerStackPart(stack, 'layer:part-3', 'base', true);
    expect(orderedLayerStackParts(moved).map(p => p.key)).toEqual(['layer:part-3', 'base', 'layer:part-1', 'layer:part-2']);
    expect(orderedLayerStackParts(JSON.parse(JSON.stringify(moved)))).toEqual(orderedLayerStackParts(moved));
    const restored = moveLayerStackPart(moved, 'layer:part-3', 'layer:part-2', false);
    expect(restored.data.layers).toEqual(stack.data.layers);
    expect(restored.data.base_z_index).toBe(0);
  });
  it('does nothing for no-op, unknown and same-target drops', () => {
    expect(moveLayerStackPart(stack, 'base', 'base', false)).toBe(stack);
    expect(moveLayerStackPart(stack, 'unknown', 'base', false)).toBe(stack);
    expect(moveLayerStackPart(stack, 'base', 'unknown', false)).toBe(stack);
    expect(moveLayerStackPart(stack, 'base', 'layer:part-1', true)).toBe(stack);
  });
});
