import { describe, expect, it } from 'vitest';

import type { CanvasDocument, CanvasImageNode, CanvasNode } from '@/schema/canvas';
import {
  normalizeResultStacks,
  resultStackOwners,
  settleResultStack,
  swapResultStackCover,
} from './canvasResultStacks';

const imageVersion = (id: string) => ({
  version_id: id, kind: 'image', width: 1024, height: 1024,
} as unknown as CanvasDocument['content_versions'][string]);

const imageNode = (id: string, versionId: string, extra: Partial<CanvasImageNode['data']> = {}): CanvasImageNode => ({
  id, type: 'image', title: id, position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, z_index: 0, hidden: false,
  data: {
    current_version_id: versionId, generation_draft: null, active_run_id: null,
    display: { fit: 'contain', free_resize: false }, ...extra,
  },
} as CanvasImageNode);

const doc = (nodes: CanvasNode[], connections: CanvasDocument['connections'] = []): CanvasDocument => ({
  nodes,
  connections,
  content_versions: Object.fromEntries(['v1', 'v2', 'v3', 'v4'].map(id => [id, imageVersion(id)])),
} as unknown as CanvasDocument);

let counter = 0;
const nextId = () => `member-${++counter}`;

describe('settleResultStack', () => {
  it('turns the other results into member nodes laid out to the right of the cover', () => {
    counter = 0;
    const settled = settleResultStack(doc([imageNode('cover', 'v1')]), 'cover', { runId: 'run-1', versionIds: ['v2', 'v3'] }, nextId);
    const cover = settled.nodes.find(node => node.id === 'cover') as CanvasImageNode;
    expect(cover.data.result_stack).toEqual({ run_id: 'run-1', member_node_ids: ['member-1', 'member-2'] });
    expect(settled.nodes.find(node => node.id === 'member-1')?.position).toEqual({ x: 216, y: 0 });
    expect(settled.nodes.find(node => node.id === 'member-2')?.position).toEqual({ x: 432, y: 0 });
    expect(resultStackOwners(settled.nodes).get('member-2')).toBe('cover');
  });

  it('replaces old members but keeps the ones already in use as plain nodes', () => {
    counter = 10;
    const cover = imageNode('cover', 'v1', { result_stack: { run_id: 'run-1', member_node_ids: ['old-free', 'old-used'] } });
    const before = doc(
      [cover, imageNode('old-free', 'v2'), imageNode('old-used', 'v3'), imageNode('downstream', 'v4')],
      [{ id: 'edge', role: 'input', source_node_id: 'old-used', target_node_id: 'downstream' } as CanvasDocument['connections'][number]],
    );
    const settled = settleResultStack(before, 'cover', { runId: 'run-2', versionIds: ['v4'] }, nextId);
    const ids = settled.nodes.map(node => node.id);
    expect(ids).not.toContain('old-free');
    expect(ids).toContain('old-used');
    expect((settled.nodes.find(node => node.id === 'cover') as CanvasImageNode).data.result_stack)
      .toEqual({ run_id: 'run-2', member_node_ids: ['member-11'] });
  });
});

describe('normalizeResultStacks', () => {
  it('deletes the members together with their connections when the cover is deleted', () => {
    const cover = imageNode('cover', 'v1', { result_stack: { run_id: 'run-1', member_node_ids: ['member'] } });
    const previous = doc([cover, imageNode('member', 'v2'), imageNode('other', 'v3')]);
    const next = doc(
      [imageNode('member', 'v2'), imageNode('other', 'v3')],
      [{ id: 'edge', role: 'input', source_node_id: 'member', target_node_id: 'other' } as CanvasDocument['connections'][number]],
    );
    const normalized = normalizeResultStacks(next, previous);
    expect(normalized.nodes.map(node => node.id)).toEqual(['other']);
    expect(normalized.connections).toEqual([]);
  });

  it('keeps members next to the cover after the cover moves', () => {
    const cover = imageNode('cover', 'v1', { result_stack: { run_id: 'run-1', member_node_ids: ['member'] } });
    const moved = { ...cover, position: { x: 100, y: 50 } };
    const normalized = normalizeResultStacks(doc([moved, imageNode('member', 'v2')]), doc([cover, imageNode('member', 'v2')]));
    expect(normalized.nodes.find(node => node.id === 'member')?.position).toEqual({ x: 316, y: 50 });
  });
});

describe('swapResultStackCover', () => {
  it('swaps the images and moves each connection along with its image', () => {
    const cover = imageNode('cover', 'v1', { result_stack: { run_id: 'run-1', member_node_ids: ['member'] } });
    const swapped = swapResultStackCover(doc(
      [cover, imageNode('member', 'v2'), imageNode('downstream', 'v3')],
      [{ id: 'edge', role: 'input', source_node_id: 'member', target_node_id: 'downstream' } as CanvasDocument['connections'][number]],
    ), 'cover', 'member');
    expect((swapped.nodes.find(node => node.id === 'cover') as CanvasImageNode).data.current_version_id).toBe('v2');
    expect((swapped.nodes.find(node => node.id === 'member') as CanvasImageNode).data.current_version_id).toBe('v1');
    expect(swapped.connections[0].source_node_id).toBe('cover');
  });
});
