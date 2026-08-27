import { describe, expect, it } from 'vitest';

import type {
  CanvasConnection,
  CanvasContentVersion,
  CanvasNode,
} from '@/schema/canvas';
import {
  buildCanvasMaterialReferences,
  buildCanvasMentionReferences,
  canvasMentionToken,
  missingCanvasMentionIds,
} from './canvasMentions';

const now = '2026-08-25T00:00:00Z';
const draft = {
  mode: 'image' as const,
  prompt: '',
  input_policy: 'mentions_only' as const,
  model: 'gpt-image-2',
  alias: 'openai',
  params: {},
  updated_at: now,
};

function contentNode(id: string, type: 'text' | 'image' | 'video' | 'audio', versionId: string | null): CanvasNode {
  const base = {
    id,
    title: `${type}-${id}`,
    type,
    position: { x: 0, y: 0 },
    z_index: 0,
    data: { current_version_id: versionId, generation_draft: null, active_run_id: null },
  };
  return type === 'image' || type === 'video'
    ? { ...base, data: { ...base.data, display: { fit: 'contain' as const, free_resize: false } } } as CanvasNode
    : base as CanvasNode;
}

const config: CanvasNode = {
  id: 'config', title: '生成', type: 'config', position: { x: 0, y: 0 }, z_index: 0,
  data: { draft },
};

const versions: Record<string, CanvasContentVersion> = {
  'version-image-a': {
    version_id: 'version-image-a', kind: 'image', path: 'uploads/image-a.png', mime_type: 'image/png',
    bytes: 12, created_at: now, sha256: 'a'.repeat(64), origin: { kind: 'upload', upload_id: 'image-a' },
  },
  'version-text': {
    version_id: 'version-text', kind: 'text', text: '雨夜列车文案', created_at: now,
    sha256: 'b'.repeat(64), origin: { kind: 'user_edit' },
  },
  'version-image-b': {
    version_id: 'version-image-b', kind: 'image', path: 'uploads/image-b.png', mime_type: 'image/png',
    bytes: 12, created_at: now, sha256: 'c'.repeat(64), origin: { kind: 'upload', upload_id: 'image-b' },
  },
};

describe('Canvas connected mentions', () => {
  it('lists every canvas material with a valid current content version', () => {
    const nodes = [
      contentNode('image-a', 'image', 'version-image-a'),
      contentNode('empty-video', 'video', null),
      contentNode('text-a', 'text', 'version-text'),
      config,
    ];

    expect(buildCanvasMaterialReferences('canvas-test', nodes, versions)).toEqual([
      expect.objectContaining({
        nodeId: 'image-a',
        versionId: 'version-image-a',
        kind: 'image',
        title: 'image-image-a',
      }),
      expect.objectContaining({
        nodeId: 'text-a',
        versionId: 'version-text',
        kind: 'text',
        title: 'text-text-a',
        text: '雨夜列车文案',
      }),
    ]);
  });

  it('labels only incoming content with a valid current version, preserving connection order per kind', () => {
    const nodes = [
      contentNode('image-a', 'image', 'version-image-a'),
      contentNode('empty-video', 'video', null),
      contentNode('text-a', 'text', 'version-text'),
      contentNode('image-b', 'image', 'version-image-b'),
      config,
    ];
    const connections: CanvasConnection[] = [
      { id: 'e1', role: 'input', source_node_id: 'image-a', target_node_id: 'config' },
      { id: 'e2', role: 'input', source_node_id: 'empty-video', target_node_id: 'config' },
      { id: 'e3', role: 'input', source_node_id: 'text-a', target_node_id: 'config' },
      { id: 'e4', role: 'input', source_node_id: 'image-b', target_node_id: 'config' },
      {
        id: 'history', role: 'derivation', source_node_id: 'image-b', target_node_id: 'config',
        origin: { kind: 'generation_run', run_id: 'old-run' },
      },
    ];

    expect(buildCanvasMentionReferences('canvas-test', config, nodes, connections, versions)).toEqual([
      expect.objectContaining({ nodeId: 'image-a', versionId: 'version-image-a', kind: 'image', label: '图片1' }),
      expect.objectContaining({ nodeId: 'text-a', versionId: 'version-text', kind: 'text', label: '文本1', text: '雨夜列车文案' }),
      expect.objectContaining({ nodeId: 'image-b', versionId: 'version-image-b', kind: 'image', label: '图片2' }),
    ]);
  });

  it('keeps stable node tokens and reports disconnected references', () => {
    const prompt = `${canvasMentionToken('image-a')} 对照 ${canvasMentionToken('missing')} 再看 ${canvasMentionToken('missing')}`;
    expect(prompt).toContain('@[node:image-a]');
    expect(missingCanvasMentionIds(prompt, [{
      nodeId: 'image-a', versionId: 'version-image-a', kind: 'image', label: '图片1', title: '图片 A',
    }])).toEqual(['missing']);
  });

  it('reserves the implicit self label and hides inputs for existing video edits', () => {
    const existingImage = contentNode('surface-image', 'image', 'version-image-a');
    if (existingImage.type !== 'image') throw new Error('expected image node');
    existingImage.data.generation_draft = draft;
    const imageSource = contentNode('image-b', 'image', 'version-image-b');
    const imageConnections: CanvasConnection[] = [{
      id: 'image-input', role: 'input', source_node_id: imageSource.id, target_node_id: existingImage.id,
    }];
    expect(buildCanvasMentionReferences(
      'canvas-test', existingImage, [existingImage, imageSource], imageConnections, versions,
    )[0]).toEqual(expect.objectContaining({ nodeId: imageSource.id, label: '图片2' }));

    const existingVideo = contentNode('surface-video', 'video', 'version-video');
    if (existingVideo.type !== 'video') throw new Error('expected video node');
    existingVideo.data.generation_draft = { ...draft, mode: 'video' };
    const videoVersions = {
      ...versions,
      'version-video': {
        version_id: 'version-video', kind: 'video' as const, path: 'uploads/source.mp4',
        mime_type: 'video/mp4', bytes: 12, created_at: now, sha256: 'd'.repeat(64),
        origin: { kind: 'upload' as const, upload_id: 'video' },
      },
    };
    expect(buildCanvasMentionReferences(
      'canvas-test', existingVideo, [existingVideo, imageSource], [{
        id: 'video-input', role: 'input', source_node_id: imageSource.id, target_node_id: existingVideo.id,
      }], videoVersions,
    )).toEqual([]);
  });
});
