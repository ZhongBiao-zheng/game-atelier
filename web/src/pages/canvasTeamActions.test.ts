import { describe, expect, it } from 'vitest';

import type { CanvasContentVersion, CanvasImageNode, CanvasNode, CanvasTextNode } from '@/schema/canvas';
import type { GenerationRecipe } from '@/schema/creationAssets';
import {
  canvasNodeSaveRequest,
  canvasNodeShareRequest,
  canvasReproduceNotices,
  isSavableCanvasVersion,
  isShareableCanvasVersion,
  placeCanvasNodeGroupWithoutOverlap,
} from './canvasTeamActions';

const imageNode: CanvasImageNode = {
  id: 'node-image', title: '城堡', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
  data: {
    current_version_id: 'v-image', generation_draft: null, active_run_id: null,
    display: { fit: 'contain', free_resize: false },
  },
};

const textNode: CanvasTextNode = {
  id: 'node-text', title: '台词', type: 'text', position: { x: 0, y: 0 }, z_index: 0,
  data: { current_version_id: 'v-text', generation_draft: null, active_run_id: null, display: { scale: 'sm' } },
};

function media(kind: 'image' | 'video' | 'audio', origin: CanvasContentVersion['origin']): CanvasContentVersion {
  return {
    version_id: `v-${kind}`, kind, created_at: '2026-09-24T00:00:00Z', sha256: 'a'.repeat(64), origin,
    path: `uploads/${kind}.bin`, mime_type: `${kind}/x`, bytes: 1,
  };
}

const generated = { kind: 'job_output', job_id: 'job-1', candidate_id: 'c-1' } as const;
const uploaded = { kind: 'upload', upload_id: 'u-1' } as const;

function recipe(overrides: Partial<GenerationRecipe> = {}): GenerationRecipe {
  return {
    mode: 'image', model: 'gpt-image-2', provider: 'openai', alias: 'main', final_prompt: '城堡', draft_prompt: null,
    params: {}, inputs: [], cost_cny: null, cost_basis: null, submitted_at: '2026-09-24T00:00:00Z',
    ...overrides,
  };
}

describe('canvas save / share eligibility', () => {
  it('saves text, image and video versions but not audio', () => {
    expect(isSavableCanvasVersion({ version_id: 'v', kind: 'text', text: 'x', sha256: 'x', created_at: '', origin: { kind: 'user_edit' } })).toBe(true);
    expect(isSavableCanvasVersion(media('image', uploaded))).toBe(true);
    expect(isSavableCanvasVersion(media('video', generated))).toBe(true);
    expect(isSavableCanvasVersion(media('audio', generated))).toBe(false);
    expect(isSavableCanvasVersion(undefined)).toBe(false);
  });

  it('shares only generated image and video versions', () => {
    expect(isShareableCanvasVersion(media('image', generated))).toBe(true);
    expect(isShareableCanvasVersion(media('video', generated))).toBe(true);
    expect(isShareableCanvasVersion(media('image', uploaded))).toBe(false);
    expect(isShareableCanvasVersion(media('audio', generated))).toBe(false);
  });
});

describe('canvasNodeSaveRequest', () => {
  it('saves a generated result as a generation asset from the canvas result', () => {
    expect(canvasNodeSaveRequest({
      node: imageNode, version: media('image', generated), projectId: 'canvas-one', previewUrl: '/media', requestId: 'r1',
    })).toEqual({
      libraryMode: 'assets',
      request: {
        requestId: 'r1', kind: 'media', title: '城堡', previewUrl: '/media', mediaKind: 'image', projectId: 'canvas-one',
        source: { kind: 'canvas_result', canvas_project_id: 'canvas-one', node_id: 'node-image', version_id: 'v-image' },
      },
    });
  });

  it('saves uploaded media as a plain media asset with its kind', () => {
    expect(canvasNodeSaveRequest({
      node: imageNode, version: media('video', uploaded), projectId: 'canvas-one', previewUrl: '/media', requestId: 'r2',
    })).toEqual({
      libraryMode: 'assets',
      request: {
        requestId: 'r2', kind: 'media', title: '城堡', sourcePath: 'canvases/canvas-one/uploads/video.bin',
        previewUrl: '/media', mediaKind: 'video', projectId: 'canvas-one',
      },
    });
  });

  it('saves text as a prompt asset', () => {
    const result = canvasNodeSaveRequest({
      node: textNode,
      version: { version_id: 'v-text', kind: 'text', text: '你好', sha256: 'x', created_at: '', origin: { kind: 'user_edit' } },
      projectId: 'canvas-one', previewUrl: '/media', requestId: 'r3',
    });
    expect(result).toEqual({
      libraryMode: 'prompts',
      request: { requestId: 'r3', kind: 'prompt', title: '台词', segments: [{ kind: 'text', text: '你好' }], projectId: 'canvas-one' },
    });
  });

  it('refuses audio', () => {
    expect(canvasNodeSaveRequest({
      node: imageNode, version: media('audio', uploaded), projectId: 'canvas-one', previewUrl: '/media', requestId: 'r4',
    })).toBeNull();
  });
});

describe('canvasNodeShareRequest', () => {
  it('shares a generated image with its preview', () => {
    expect(canvasNodeShareRequest({ node: imageNode, version: media('image', generated), projectId: 'canvas-one', previewUrl: '/media' }))
      .toEqual({
        source: { kind: 'canvas_result', canvas_project_id: 'canvas-one', node_id: 'node-image', version_id: 'v-image' },
        defaultTitle: '城堡',
        previewUrl: '/media',
        defaultCategory: null,
      });
  });

  it('prefills the category when the content is finalized in this project', () => {
    expect(canvasNodeShareRequest({
      node: imageNode, version: media('image', generated), projectId: 'canvas-one', previewUrl: '/media', finalCategory: '角色',
    })?.defaultCategory).toBe('角色');
  });

  it('shares a generated video without an image preview', () => {
    expect(canvasNodeShareRequest({ node: imageNode, version: media('video', generated), projectId: 'canvas-one', previewUrl: '/media' })?.previewUrl)
      .toBeNull();
  });

  it('refuses non-generated versions', () => {
    expect(canvasNodeShareRequest({ node: imageNode, version: media('image', uploaded), projectId: 'canvas-one', previewUrl: '/media' }))
      .toBeNull();
  });
});

describe('canvas reproduce helpers', () => {
  it('lists the missing model first, then each server warning', () => {
    expect(canvasReproduceNotices(recipe(), null, ['没有带上遮罩（1 份）'])).toEqual([
      '本机没有 gpt-image-2',
      '没有带上遮罩（1 份）',
    ]);
    expect(canvasReproduceNotices(recipe(), { alias: 'main', model: 'gpt-image-2' }, [])).toEqual([]);
  });
});

describe('placeCanvasNodeGroupWithoutOverlap', () => {
  const portrait = (id: string): CanvasContentVersion => ({
    version_id: id, kind: 'image', created_at: '', sha256: 'a'.repeat(64), origin: { kind: 'upload', upload_id: id },
    path: `${id}.png`, mime_type: 'image/png', bytes: 1, width: 900, height: 1600,
  });
  const versions = { 'v-1': portrait('v-1'), 'v-2': portrait('v-2') };
  // 服务端布局：参考一列在左纵排（9:16 渲染成 320 × 568.9，行距 48），配置节点在右、与首个参考顶对齐。
  const group: CanvasNode[] = [
    { ...imageNode, id: 'ref-1', position: { x: 40, y: 40 }, data: { ...imageNode.data, current_version_id: 'v-1' } },
    { ...imageNode, id: 'ref-2', position: { x: 40, y: 40 + 320 * 16 / 9 + 48 }, data: { ...imageNode.data, current_version_id: 'v-2' } },
    { id: 'config', title: '图片生成', type: 'image', position: { x: 40 + 320 + 96, y: 40 }, z_index: 0,
      data: { current_version_id: null, active_run_id: null, display: { fit: 'contain', free_resize: false }, generation_draft: { mode: 'image', prompt: '', input_policy: 'all_connected', model: '', params: {}, updated_at: '' } } },
  ];
  const offsets = (nodes: CanvasNode[]) => nodes.map(node => ({
    x: node.position.x - nodes[0].position.x,
    y: node.position.y - nodes[0].position.y,
  }));

  it('moves the whole group by one offset away from an existing node', () => {
    const blocker = { ...textNode, position: { x: 40, y: 40 } };
    const placed = placeCanvasNodeGroupWithoutOverlap(group, [blocker], versions, { left: 0, top: 0, right: 1000, bottom: 740 });
    expect(offsets(placed)).toEqual(offsets(group));
    expect(placed[0].position).not.toEqual(group[0].position);
  });

  it('places two copies of a template clear of each other and the existing node', () => {
    const bounds = { left: 30, top: 20, right: 930, bottom: 700 };
    const size = { width: 200, height: 120 };
    const template: CanvasNode[] = [
      { id: 'group', type: 'group', title: '模板', position: { x: 0, y: 0 }, size, z_index: 0,
        data: { member_node_ids: ['member'] } },
      { ...textNode, id: 'member', position: { x: 10, y: 10 }, size: { width: 100, height: 80 } },
    ];
    const center = { x: 380, y: 300 };
    const existing = [{ ...textNode, position: center, size }];
    for (let i = 0; i < 2; i++) {
      const [frame, member] = placeCanvasNodeGroupWithoutOverlap(template, existing, {}, bounds, true);
      const { x, y } = frame.position;
      expect(member.position).toEqual({ x: x + 10, y: y + 10 });
      expect(x >= bounds.left && x + size.width <= bounds.right).toBe(true);
      expect(y >= bounds.top && y + size.height <= bounds.bottom).toBe(true);
      for (const { position } of existing) {
        expect(x + size.width <= position.x || x >= position.x + size.width
          || y + size.height <= position.y || y >= position.y + size.height).toBe(true);
      }
      existing.push({ ...textNode, position: frame.position, size });
    }
    expect(placeCanvasNodeGroupWithoutOverlap(template, [], {}, bounds, true)[0].position).toEqual(center);
    const narrow = { ...bounds, right: 140 };
    expect(placeCanvasNodeGroupWithoutOverlap(template, [], {}, narrow, true)[0].position)
      .toEqual({ x: bounds.left, y: bounds.top });
  });

  it('keeps a group that already sits on free canvas untouched', () => {
    expect(placeCanvasNodeGroupWithoutOverlap(group, [], versions)).toEqual(group);
  });

  it('places nothing for an empty group', () => {
    expect(placeCanvasNodeGroupWithoutOverlap([], [], {})).toEqual([]);
  });
});
