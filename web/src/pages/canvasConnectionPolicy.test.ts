import { describe, expect, it } from 'vitest';

import type { CanvasDocument, CanvasNode } from '@/schema/canvas';

import {
  canvasConnectionCreationCapabilities,
  canCreateCanvasInputConnection,
  canvasNodeAcceptsInput,
  canvasNodeHasCurrentContent,
  canvasNodeProvidesOutput,
  canvasNodeProvidesContent,
  closestCanvasConnectionEndpoint,
} from './canvasEditorModel';

const contentData = {
  current_version_id: null,
  generation_draft: null,
  active_run_id: null,
};

function node(
  id: string,
  type: 'text' | 'image' | 'video' | 'audio' | 'config' | 'group' | 'plugin',
  currentVersionId: string | null = null,
): CanvasNode {
  const common = { id, title: id, position: { x: 0, y: 0 }, z_index: 0 };
  const nodeContentData = { ...contentData, current_version_id: currentVersionId };
  if (type === 'text') {
    return { ...common, type, data: { ...nodeContentData, display: { scale: 'sm' } } };
  }
  if (type === 'image' || type === 'video') {
    return { ...common, type, data: { ...nodeContentData, display: { fit: 'contain', free_resize: false } } };
  }
  if (type === 'audio') return { ...common, type, data: nodeContentData };
  if (type === 'config') {
    return {
      ...common,
      type,
      data: {
        draft: {
          mode: 'image',
          prompt: '',
          input_policy: 'mentions_only',
          model: '',
          params: {},
          updated_at: '2026-08-25T00:00:00Z',
        },
      },
    };
  }
  if (type === 'group') return { ...common, type, data: { member_node_ids: [] } };
  return {
    ...common,
    type,
    data: {
      plugin_id: 'plugin',
      node_type: 'node',
      plugin_version: '1.0.0',
      data_schema_version: 1,
      payload: {},
      generation_draft: null,
    },
  };
}

function document(nodes: CanvasNode[]): CanvasDocument {
  return {
    schema_version: 2,
    project_id: 'canvas-policy-test',
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { background: 'none', show_image_info: true, show_minimap: true },
    nodes,
    connections: [],
    content_versions: {},
    updated_at: '2026-08-25T00:00:00Z',
  };
}

describe('canvas connection policy', () => {
  it('shares endpoint capabilities between rendering and validation', () => {
    expect(canvasNodeProvidesContent(node('text', 'text'))).toBe(true);
    expect(canvasNodeProvidesContent(node('config', 'config'))).toBe(false);
    expect(canvasNodeAcceptsInput(node('config', 'config'))).toBe(true);
    expect(canvasNodeAcceptsInput(node('group', 'group'))).toBe(false);
    expect(canvasNodeAcceptsInput(node('plugin', 'plugin'))).toBe(false);
    expect(canvasNodeHasCurrentContent(node('empty', 'text'), {})).toBe(false);
    expect(canvasNodeHasCurrentContent(node('missing', 'text', 'version-missing'), {})).toBe(false);
    // 四类内容节点都无条件算内容源：先连线、后逐个生成是正常画布工作流。空输入不是在这里拦，
    // 而是由 canvasPendingInputNodes 在生成按钮上指名拦住。
    expect(canvasNodeProvidesOutput(node('empty-image', 'image'), {})).toBe(true);
    expect(canvasNodeProvidesOutput(node('empty-video', 'video'), {})).toBe(true);
    expect(canvasNodeProvidesOutput(node('empty-text', 'text'), {})).toBe(true);
    expect(canvasNodeProvidesOutput(node('empty-audio', 'audio'), {})).toBe(true);
  });

  it('allows directional cycles while rejecting self, duplicate, and invalid endpoints', () => {
    const current = document([
      node('source', 'text', 'version-source'),
      node('target', 'text', 'version-target'),
      node('empty', 'text'),
      node('empty-image', 'image'),
      node('empty-video', 'video'),
      node('config', 'config'),
      node('group', 'group'),
      node('plugin', 'plugin'),
    ]);
    current.content_versions = {
      'version-source': {
        version_id: 'version-source',
        kind: 'text',
        text: 'source',
        created_at: '2026-08-25T00:00:00Z',
        sha256: '0'.repeat(64),
        origin: { kind: 'user_edit' },
      },
      'version-target': {
        version_id: 'version-target',
        kind: 'text',
        text: 'target',
        created_at: '2026-08-25T00:00:00Z',
        sha256: '1'.repeat(64),
        origin: { kind: 'user_edit' },
      },
    };
    expect(canCreateCanvasInputConnection(current, { source: 'source', target: 'target' })).toBe(true);
    expect(canCreateCanvasInputConnection(current, { source: 'target', target: 'source' })).toBe(true);
    expect(canCreateCanvasInputConnection(current, { source: 'source', target: 'source' })).toBe(false);
    expect(canCreateCanvasInputConnection(current, { source: 'config', target: 'target' })).toBe(false);
    expect(canCreateCanvasInputConnection(current, { source: 'empty', target: 'target' })).toBe(true);
    expect(canCreateCanvasInputConnection(current, { source: 'empty-image', target: 'target' })).toBe(true);
    expect(canCreateCanvasInputConnection(current, { source: 'empty-video', target: 'target' })).toBe(true);
    expect(canCreateCanvasInputConnection(current, { source: 'source', target: 'group' })).toBe(false);
    expect(canCreateCanvasInputConnection(current, { source: 'source', target: 'plugin' })).toBe(false);

    current.connections.push({
      id: 'connection-1',
      role: 'input',
      source_node_id: 'source',
      target_node_id: 'target',
    });
    expect(canCreateCanvasInputConnection(current, { source: 'source', target: 'target' })).toBe(false);
  });

  it('snaps only beside a node handle and leaves vertical blank canvas untouched', () => {
    const nodes = [{ id: 'node', left: 100, right: 300, top: 100, bottom: 220 }];

    expect(closestCanvasConnectionEndpoint({ x: 80, y: 160 }, nodes, 'left')).toBe('node');
    expect(closestCanvasConnectionEndpoint({ x: 320, y: 160 }, nodes, 'right')).toBe('node');
    expect(closestCanvasConnectionEndpoint({ x: 320, y: 160 }, nodes, 'left')).toBeNull();
    expect(closestCanvasConnectionEndpoint({ x: 80, y: 160 }, nodes, 'right')).toBeNull();
    expect(closestCanvasConnectionEndpoint({ x: 200, y: 80 }, nodes, 'left')).toBeNull();
    expect(closestCanvasConnectionEndpoint({ x: 200, y: 240 }, nodes, 'right')).toBeNull();
    expect(closestCanvasConnectionEndpoint({ x: 60, y: 160 }, nodes, 'left')).toBeNull();
  });

  it('offers only immediately valid sources when creating backward from a target handle', () => {
    expect(canvasConnectionCreationCapabilities('target')).toEqual({
      allowEmptyNodes: false,
      allowUpload: true,
      allowConfig: false,
    });
    expect(canvasConnectionCreationCapabilities('source')).toEqual({
      allowEmptyNodes: true,
      allowUpload: false,
      allowConfig: true,
    });
  });
});
