import { expect, it } from 'vitest';

import {
  acceptCanvasJobs,
  canvasNodeRenderZIndex,
  canvasPendingInputNodes,
  clampCanvasNodeSize,
  normalizeCanvasImageParams,
} from './canvasEditorModel';
import type { CanvasDocument, CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

it('raises selected nodes above every persisted canvas layer without changing other nodes', () => {
  expect(canvasNodeRenderZIndex(3, false, 12)).toBe(3);
  expect(canvasNodeRenderZIndex(3, true, 12)).toBe(13);
});

it('normalizes model-specific image parameters when switching models', () => {
  const params = normalizeCanvasImageParams(
    'gpt-image-2',
    'openai',
    { n: 2, ratio: '21:9', resolution: '4K', quality: 'invalid' },
  );

  expect(params).toEqual({ n: 2, ratio: '21:9', quality: 'low', size: '2048x880' });
});

it('locks Midjourney jobs to the four paid outputs from one task', () => {
  const params = normalizeCanvasImageParams(
    'midjourney-v7',
    'custom',
    { n: 1, ratio: '16:9', resolution: '4K', quality: 'high' },
  );

  expect(params).toEqual({ n: 4, ratio: '16:9' });
});


it('clamps node sizes to the server bound instead of letting the save 422 forever', () => {
  // 后端 CanvasSize 是 le=4000。超界那次保存返回 422，而失败的快照会被重新入队，
  // 于是之后每一次编辑都不落盘 —— 一次拖动换来一个不可恢复的状态。
  expect(clampCanvasNodeSize({ width: 9000, height: 120 })).toEqual({ width: 4000, height: 120 });
  expect(clampCanvasNodeSize({ width: 0, height: -5 })).toEqual({ width: 1, height: 1 });
  const inBounds = { width: 420, height: 260 };
  expect(clampCanvasNodeSize(inBounds)).toBe(inBounds);
});

function job(id: string, status: Job['status']): Job {
  return {
    job_id: id,
    character_id: null,
    namespace: 'canvas',
    kind: 'image',
    status,
    prompt: '',
    model: 'gpt-image-2',
    alias: 'main',
    params: {},
    seed: null,
    output_paths: [],
    submitted_at: '2026-08-27T00:00:00Z',
    error: null,
  } as unknown as Job;
}

it('keeps a locally submitted job that the in-flight poll response predates', () => {
  // 轮询以前整体赋值。请求发出到响应落地之间还夹着一次 getCanvasDocument，窗口足够跨过一次提交：
  // 刚提交的 pending job 被抹掉 → hasRunningJobs 为假 → 轮询 effect 自己卸载 → 界面永远停在旧状态。
  const local = [job('old', 'done'), job('fresh', 'pending')];
  const remote = [job('old', 'done')];

  expect(acceptCanvasJobs(local, remote).map(item => item.job_id)).toEqual(['old', 'fresh']);
  // 服务端返回的同一条永远赢：状态推进不能被本地旧值盖回去。
  expect(acceptCanvasJobs([job('old', 'pending')], [job('old', 'done')])[0].status).toBe('done');
});

function documentWithNodes(nodes: CanvasNode[], connections: CanvasDocument['connections']): CanvasDocument {
  return {
    schema_version: 2,
    project_id: 'canvas-one',
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { background: 'none', show_image_info: true, show_minimap: true },
    nodes,
    connections,
    content_versions: {
      'version-filled': {
        version_id: 'version-filled',
        kind: 'text',
        text: '已有内容',
        sha256: 'b'.repeat(64),
        created_at: '2026-08-27T00:00:00Z',
      },
    },
    updated_at: '2026-08-27T00:00:00Z',
  } as unknown as CanvasDocument;
}

function textNode(id: string, title: string, versionId: string | null): CanvasNode {
  return {
    id,
    title,
    type: 'text',
    position: { x: 0, y: 0 },
    z_index: 0,
    data: {
      current_version_id: versionId,
      generation_draft: null,
      active_run_id: null,
      display: { scale: 'sm' },
    },
  };
}

it('lists connected-but-empty inputs per target so the button can name them before the 422', () => {
  const current = documentWithNodes(
    [
      textNode('filled', '已完成的分镜', 'version-filled'),
      textNode('empty', '待生成的分镜', null),
      textNode('target', '合成', null),
    ],
    [
      { id: 'c1', role: 'input', source_node_id: 'filled', target_node_id: 'target' },
      { id: 'c2', role: 'input', source_node_id: 'empty', target_node_id: 'target' },
      // 带 slot 的连线由 missingVideoFrame 单独把关，服务端在非首尾帧模式下会整体丢掉它们。
      { id: 'c3', role: 'input', source_node_id: 'empty', target_node_id: 'target', slot: 'first_frame' },
    ] as CanvasDocument['connections'],
  );

  expect(canvasPendingInputNodes(current).get('target')).toEqual([
    { nodeId: 'empty', title: '待生成的分镜' },
  ]);
  expect(canvasPendingInputNodes(null).size).toBe(0);
});
