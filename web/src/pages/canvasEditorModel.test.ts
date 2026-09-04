import { expect, it, test } from 'vitest';

import {
  acceptCanvasJobs,
  canvasDeletionBlockedMessage,
  canvasMediaOperationPlaceholder,
  canvasNodeRenderZIndex,
  canvasPendingInputNodes,
  clampCanvasNodeSize,
  layerStackSizeForCanvasVersion,
  normalizeCanvasImageParams,
  placeCanvasNodeWithoutOverlap,
  syncDraftLayerStackSources,
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

it('sizes a layer stack from the source image aspect ratio while preserving room for settings', () => {
  const version = {
    version_id: 'portrait', kind: 'image', path: 'uploads/portrait.png', mime_type: 'image/png',
    bytes: 42, width: 900, height: 1600, duration_ms: null, created_at: '2026-09-03T00:00:00Z',
    sha256: 'a'.repeat(64), origin: { kind: 'upload', upload_id: 'upload-portrait' },
  } as const;

  expect(layerStackSizeForCanvasVersion(version)).toEqual({ width: 648, height: 640 });
  expect(layerStackSizeForCanvasVersion({ ...version, width: 1600, height: 900 })).toEqual({
    width: 768,
    height: 400,
  });
});

it('follows an upstream image only while a layer stack is an idle draft', () => {
  const source = {
    id: 'source', title: '源图', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: 'source-new', generation_draft: null, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  } satisfies CanvasNode;
  const stack = {
    id: 'stack', title: '拆分图层', type: 'layer_stack', position: { x: 400, y: 0 }, z_index: 0,
    size: { width: 760, height: 480 },
    data: {
      source_version_id: 'source-old', alias: 'tokendance', model: 'seedream-5.0-pro', prompt: '',
      resolution: 'auto', base_version_id: null, base_visible: true, layers: [], active_run_id: null,
      error: null,
    },
  } satisfies CanvasNode;
  const version = {
    version_id: 'source-new', kind: 'image', path: 'uploads/new.png', mime_type: 'image/png',
    bytes: 42, width: 900, height: 1600, duration_ms: null, created_at: '2026-09-03T00:00:00Z',
    sha256: 'b'.repeat(64), origin: { kind: 'upload', upload_id: 'upload-new' },
  } as const;
  const current = documentWithNodes([source, stack], [
    { id: 'source-stack', role: 'input', source_node_id: source.id, target_node_id: stack.id },
  ] as CanvasDocument['connections']);
  current.content_versions[version.version_id] = version;

  const synced = syncDraftLayerStackSources(current);
  expect(synced.nodes.find(node => node.id === stack.id)).toMatchObject({
    size: { width: 648, height: 640 },
    data: { source_version_id: 'source-new' },
  });

  const running = {
    ...current,
    nodes: current.nodes.map(node => node.id === stack.id && node.type === 'layer_stack'
      ? { ...node, data: { ...node.data, active_run_id: 'run-one' } }
      : node),
  };
  const completed = {
    ...current,
    nodes: current.nodes.map(node => node.id === stack.id && node.type === 'layer_stack'
      ? { ...node, data: { ...node.data, base_version_id: 'base' } }
      : node),
  };
  expect(syncDraftLayerStackSources(running)).toBe(running);
  expect(syncDraftLayerStackSources(completed)).toBe(completed);
});

test('canvasDeletionBlockedMessage 只拦 job 仍在跑的节点，生成完成后 active_run_id 残留不拦', () => {
  const base = placementNode('image-a', 0, 0);
  const node = { ...base, data: { ...base.data, active_run_id: 'run-a' } } as CanvasNode;
  const ids = new Set([node.id]);
  const jobFor = (status: Job['status']) => new Map([['run-a', { status } as Job]]);

  expect(canvasDeletionBlockedMessage([node], ids, jobFor('done'))).toBeNull();
  expect(canvasDeletionBlockedMessage([node], ids, jobFor('failed'))).toBeNull();
  expect(canvasDeletionBlockedMessage([node], ids, new Map())).toBeNull();
  expect(canvasDeletionBlockedMessage([node], ids, jobFor('pending'))).toContain('正在生成');
  expect(canvasDeletionBlockedMessage([node], ids, jobFor('pending_confirm'))).toContain('正在生成');
});

test('canvasMediaOperationPlaceholder 镜像服务端落点：源节点右侧 96px、垂直居中、长边 320（切图 240）', () => {
  const source = { ...placementNode('image-a', 100, 200), size: { width: 400, height: 300 } } as CanvasNode;
  const matting = canvasMediaOperationPlaceholder(source, { width: 1024, height: 768 }, { kind: 'remove_background' });
  expect(matting).toEqual({
    id: 'placeholder-remove_background',
    position: { x: 596, y: 230 },
    size: { width: 320, height: 240 },
    label: '抠图中…',
  });
  const split = canvasMediaOperationPlaceholder(source, { width: 1024, height: 768 }, { kind: 'split', horizontal_lines: [], vertical_lines: [] });
  expect(split.size).toEqual({ width: 240, height: 180 });
  expect(split.label).toBe('切图中…');
  // 短边保底 80px：极细长图不会缩成一条线。
  const strip = canvasMediaOperationPlaceholder(source, { width: 2000, height: 100 }, { kind: 'crop', rect: { x: 0, y: 0, width: 1, height: 1 } });
  expect(strip.size.height).toBe(80);
});

function placementNode(id: string, x: number, y: number): CanvasNode {
  return {
    id,
    title: id,
    type: 'image',
    position: { x, y },
    size: { width: 320, height: 176 },
    z_index: 0,
    data: {
      current_version_id: null,
      generation_draft: null,
      active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  };
}

it('keeps the preferred position when it is free', () => {
  expect(placeCanvasNodeWithoutOverlap(
    { x: 120, y: 80 },
    [placementNode('far', 900, 600)],
    { width: 320, height: 176 },
  )).toEqual({ x: 120, y: 80 });
});

it('moves a colliding node to the nearest ranked free position', () => {
  expect(placeCanvasNodeWithoutOverlap(
    { x: 0, y: 0 },
    [placementNode('occupied', 0, 0)],
    { width: 320, height: 176 },
  )).toEqual({ x: 368, y: 0 });
});

it('falls outside a full viewport instead of overlapping an existing node', () => {
  expect(placeCanvasNodeWithoutOverlap(
    { x: 0, y: 0 },
    [placementNode('occupied', 0, 0)],
    { width: 320, height: 176 },
    { left: 0, top: 0, right: 320, bottom: 176 },
  )).toEqual({ x: 368, y: 0 });
});

it('places successive nodes in distinct nearby slots', () => {
  const nodes = [placementNode('first', 0, 0), placementNode('second', 368, 0)];
  const third = placeCanvasNodeWithoutOverlap(
    { x: 0, y: 0 },
    nodes,
    { width: 320, height: 176 },
  );
  nodes.push(placementNode('third', third.x, third.y));
  const fourth = placeCanvasNodeWithoutOverlap(
    { x: 0, y: 0 },
    nodes,
    { width: 320, height: 176 },
  );

  expect(third).toEqual({ x: 0, y: 224 });
  expect(fourth).toEqual({ x: -368, y: 0 });
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
