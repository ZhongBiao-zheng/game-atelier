import { describe, expect, it } from 'vitest';

import type { CanvasContentVersion, CanvasDocument, CanvasNode } from '@/schema/canvas';
import type { PluginNodeContribution } from '@/schema/plugins';
import { brokerInputsFor, pluginInputsFromDocument } from './inputs';

const image = (id: string, members?: string[]): CanvasNode => ({
  id, type: 'image', title: id, position: { x: 0, y: 0 }, z_index: 0, hidden: false,
  data: { current_version_id: `v-${id}`, generation_draft: null, active_run_id: null,
    display: { fit: 'contain', free_resize: false },
    ...(members ? { result_stack: { run_id: 'plugin:frames:x', member_node_ids: members } } : {}) },
} as CanvasNode);
const plugin: CanvasNode = {
  id: 'p', type: 'plugin', title: '补间', position: { x: 0, y: 0 }, z_index: 0, hidden: false,
  data: { plugin_id: 'frames', node_type: 'tween', plugin_version: '0.1.0', data_schema_version: 1, payload: {},
    generation_draft: null },
} as CanvasNode;
const doc = (nodes: CanvasNode[], sources: string[]): CanvasDocument => ({
  nodes, connections: sources.map(source => ({ id: `c-${source}`, role: 'input', source_node_id: source, target_node_id: 'p' })),
} as unknown as CanvasDocument);
const version = (versionId: string | null | undefined): CanvasContentVersion | undefined => (versionId ? {
  kind: 'image', version_id: versionId, path: `${versionId}.png`, mime_type: 'image/png', bytes: 10, width: 8, height: 8,
  sha256: 'a'.repeat(64), created_at: '2026-11-15T00:00:00Z', origin: { kind: 'upload', upload_id: versionId },
} : undefined) as CanvasContentVersion | undefined;
const contribution = (expand: boolean) => ({ input_modalities: ['image'], expand_result_stack: expand }) as PluginNodeContribution;

describe('插件节点的结果组输入', () => {
  const document = doc([image('cover', ['m2', 'gone', 'm3']), image('m2'), image('m3'), image('solo'), plugin], ['cover', 'solo']);

  it('连封面时按组内顺序列出封面与还在的成员', () => {
    const inputs = pluginInputsFromDocument(document).get('p')!;
    expect(inputs.map(input => [input.nodeId, input.groupVersionId ?? null, Boolean(input.member)])).toEqual([
      ['cover', 'v-cover', false], ['m2', 'v-cover', true], ['m3', 'v-cover', true], ['solo', null, false],
    ]);
  });

  it('声明展开的节点收到整组并带分组；没声明的只收封面', () => {
    const inputs = pluginInputsFromDocument(document).get('p')!;
    expect(brokerInputsFor(inputs, contribution(true), version).map(input => [input.versionId, input.groupVersionId ?? null]))
      .toEqual([['v-cover', 'v-cover'], ['v-m2', 'v-cover'], ['v-m3', 'v-cover'], ['v-solo', null]]);
    expect(brokerInputsFor(inputs, contribution(false), version).map(input => [input.versionId, input.groupVersionId ?? null]))
      .toEqual([['v-cover', null], ['v-solo', null]]);
  });

  it('同一张图又单独连了一次时只列一次', () => {
    const inputs = pluginInputsFromDocument(doc([image('cover', ['m2']), image('m2'), plugin], ['cover', 'm2'])).get('p')!;
    expect(brokerInputsFor(inputs, contribution(true), version).map(input => input.versionId)).toEqual(['v-cover', 'v-m2']);
  });
});
