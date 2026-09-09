import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNode } from '@/schema/canvas';
import { restoreCanvasRetryConfiguration } from './canvasRetryMerge';

const draft = { mode: 'image' as const, input_policy: 'all_connected' as const, prompt: '当前草稿',
  model: 'gpt-image-2', alias: 'main', params: {}, updated_at: '2026-09-09T00:00:00Z' };
function documentFor(kind: 'image' | 'layer_stack'): CanvasDocument {
  const node: CanvasNode = kind === 'image'
    ? { id: 'result', type: 'image', title: '所属素材', position: { x: 0, y: 0 }, z_index: 0,
      data: { current_version_id: null, active_run_id: 'failed-run', generation_draft: draft,
        display: { fit: 'contain', free_resize: false } } }
    : { id: 'result', type: 'layer_stack', title: '拆分图层', position: { x: 0, y: 0 }, z_index: 0,
      data: { source_version_id: 'old-source', base_version_id: null, base_visible: true, prompt: '当前草稿',
        alias: 'main', model: 'seedream', resolution: 'auto', layers: [], active_run_id: 'failed-run', error: '失败' } };
  return { schema_version: 2, project_id: 'canvas', revision: 1, viewport: { x: 0, y: 0, zoom: 1 },
    settings: { background: 'none', show_image_info: true, show_minimap: true },
    updated_at: '2026-09-09T00:00:00Z', nodes: [node, {
      id: 'source', type: 'text', title: '输入', position: { x: 0, y: 0 }, z_index: 0,
      data: { current_version_id: null, active_run_id: null, generation_draft: null, display: { scale: 'sm' } },
    }], connections: [], content_versions: {} };
}
function serverRetry(before: CanvasDocument): CanvasDocument {
  return { ...before, revision: 2, nodes: before.nodes.map(node => node.type === 'image'
    ? { ...node, data: { ...node.data, generation_draft: { ...draft, prompt: '原任务草稿' }, active_run_id: 'new-run' } }
    : node.type === 'layer_stack'
      ? { ...node, data: { ...node.data, source_version_id: 'frozen-source', prompt: '原任务草稿', active_run_id: 'new-run', error: null } }
      : node), connections: [{ id: 'restored-input', role: 'input', source_node_id: 'source', target_node_id: 'result' }] };
}

describe('same-surface retry configuration merge', () => {
  it('does not restore a frozen prompt when only its input connection changed during the request', () => {
    const before = documentFor('image');
    const current = { ...before, connections: [{ id: 'new-input', role: 'input' as const, source_node_id: 'source', target_node_id: 'result' }] };
    const merged = restoreCanvasRetryConfiguration(current, serverRetry(before), before, 'result');
    expect(merged.connections).toEqual(current.connections);
    expect(merged.nodes[0]).toEqual(current.nodes[0]);
  });

  it('does not recreate a connection from a source deleted during the request', () => {
    const before = documentFor('image');
    const current = { ...before, nodes: before.nodes.filter(node => node.id !== 'source') };
    const merged = restoreCanvasRetryConfiguration(current, serverRetry(before), before, 'result');
    expect(merged.connections).toEqual([]);
    expect(merged.nodes[0]).toEqual(current.nodes[0]);
  });
  it.each(['image', 'layer_stack'] as const)('accepts authoritative %s retry inputs and draft after the old input was disconnected', kind => {
    const before = documentFor(kind);
    const remote = serverRetry(before);
    const merged = restoreCanvasRetryConfiguration(before, remote, before, 'result');
    expect(merged.connections).toEqual(remote.connections);
    const node = merged.nodes[0];
    expect(node.type === 'image' ? node.data.generation_draft?.prompt : node.type === 'layer_stack' ? node.data.prompt : null).toBe('原任务草稿');
    expect(before.connections).toEqual([]);
  });

  it.each(['image', 'layer_stack'] as const)('preserves new %s edits and input connections made while retry is in flight', kind => {
    const before = documentFor(kind);
    const current: CanvasDocument = { ...before,
      nodes: before.nodes.map(node => node.type === 'image'
        ? { ...node, data: { ...node.data, generation_draft: { ...draft, prompt: '请求期间新编辑' } } }
        : node.type === 'layer_stack' ? { ...node, data: { ...node.data, prompt: '请求期间新编辑' } } : node),
      connections: [{ id: 'new-input', role: 'input', source_node_id: 'another-source', target_node_id: 'result' }],
    };
    const merged = restoreCanvasRetryConfiguration(current, serverRetry(before), before, 'result');
    expect(merged.connections).toEqual(current.connections);
    const node = merged.nodes[0];
    expect(node.type === 'image' ? node.data.generation_draft?.prompt : node.type === 'layer_stack' ? node.data.prompt : null).toBe('请求期间新编辑');
  });
});
