import { describe, expect, it } from 'vitest';

import type { KeyView } from '@/api/keys';
import { createStoryboardNode, normalizeStoryboardPayload, storyboardPayloadOf, type StoryboardNode } from './canvasStoryboard';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import type { CanvasContentVersion, CanvasDocument, CanvasNode, JsonValue } from '@/schema/canvas';

import {
  NO_IMAGE_FOR_VIDEO, applyShotGenerationPlan, composeShotImagePrompt, defaultShotSelection, planShotGeneration,
  rebindShotResult, shotCellPosition, type ShotGenerationDeps,
} from './storyboardGeneration';

const key = (alias: string, provider: string, baseUrl: string | null, model: KeyView['models'][number]): KeyView => ({
  alias, provider, base_url: baseUrl, access_key: '', secret_key: null, capabilities: [], notes: '', created_at: '',
  models: [model],
} as KeyView);
const PRICED_IMAGE = key('方舟图片', 'seedream', 'https://ark.cn-beijing.volces.com/api/v3',
  { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0', modality: 'image', protocol: 'ark' });
const UNPRICED_IMAGE = key('自建', 'custom', 'https://example.test/v1', { id: 'my-own-painter', name: '自建模型', modality: 'image' });
const VIDEO = key('方舟视频', 'seedance', null, { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', modality: 'video', protocol: 'seedance' });

function deps(providers: KeyView[]): ShotGenerationDeps {
  let next = 0;
  return { providers, newId: prefix => `${prefix}-${next += 1}` };
}

const imageVersion = (id: string): CanvasContentVersion => ({
  version_id: id, kind: 'image', path: `${id}.png`, mime_type: 'image/png', bytes: 1, created_at: '', sha256: id,
  origin: { kind: 'upload', upload_id: id },
});
function imageNode(id: string, versionId: string | null, extra: Record<string, unknown> = {}): CanvasNode {
  return { id, type: 'image', title: id, position: { x: -400, y: 0 }, z_index: 0,
    data: { current_version_id: versionId, active_run_id: null, generation_draft: null, display: { fit: 'contain', free_resize: false }, ...extra } } as CanvasNode;
}

function documentWith(payload: unknown, nodes: CanvasNode[] = [], versions: CanvasContentVersion[] = []): { document: CanvasDocument; storyboard: StoryboardNode } {
  const base = createStoryboardNode('storyboard-1', { x: 0, y: 0 });
  const storyboard = { ...base, data: { ...base.data, payload: normalizeStoryboardPayload(payload) as unknown as JsonValue } };
  return {
    storyboard,
    document: {
      schema_version: 2, project_id: 'p', revision: 1, viewport: { x: 0, y: 0, zoom: 1 }, settings: {} as CanvasDocument['settings'],
      nodes: [storyboard, ...nodes], connections: [], updated_at: '',
      content_versions: Object.fromEntries(versions.map(version => [version.version_id, version])),
    },
  };
}

const PAYLOAD = {
  ratio: '16:9', style_prefix: '水墨淡彩',
  entities: [
    { id: 'e-scene', kind: 'scene', name: '茶馆', description: '老木桌，竹帘', reference_node_id: 'ref-scene' },
    { id: 'e-role', kind: 'character', name: '阿青', description: '青色短袄，高马尾', reference_node_id: 'ref-role' },
    { id: 'e-prop', kind: 'prop', name: '油纸伞', description: '', reference_node_id: 'ref-missing' },
  ],
  shots: [
    { id: 'a', duration_s: 4, visual: '进门', image_prompt: '门口逆光', video_prompt: '推门走入', entity_ids: ['e-scene', 'e-role', 'e-prop'] },
    { id: 'b', duration_s: 7, visual: '坐下', entity_ids: ['e-role'] },
    { id: 'c', duration_s: 20, visual: '离开' },
  ],
};
const REFS = [imageNode('ref-scene', 'v-scene'), imageNode('ref-role', 'v-role')];
const REF_VERSIONS = [imageVersion('v-scene'), imageVersion('v-role')];

describe('出图提示词', () => {
  it('风格前缀 + 镜头提示词 + 条目固定描述，顺序为角色、场景、道具', () => {
    const payload = normalizeStoryboardPayload(PAYLOAD);
    expect(composeShotImagePrompt(payload, payload.shots[0])).toBe(
      '水墨淡彩\n门口逆光\n阿青：青色短袄，高马尾\n茶馆：老木桌，竹帘');  // 没有固定描述的道具不写
    expect(composeShotImagePrompt(payload, payload.shots[1])).toBe('水墨淡彩\n坐下\n阿青：青色短袄，高马尾');  // 没写提示词时用画面
  });
});

describe('生成计划（确认弹窗的数据来源）', () => {
  it('每镜一个图片节点：草稿、参考连线与网格位置', () => {
    const { document, storyboard } = documentWith(PAYLOAD, REFS, REF_VERSIONS);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a', 'b'], kind: 'image', deps: deps([PRICED_IMAGE]) });
    expect(plan.items.map(item => [item.shotId, item.label, item.create?.title])).toEqual([['a', '01', '01 图'], ['b', '02', '02 图']]);
    expect(plan.models).toEqual(['Seedream 5.0']);
    const [first, second] = plan.items;
    expect(first.draft).toMatchObject({ mode: 'image', model: PRICED_IMAGE.models[0].id, prompt: '水墨淡彩\n门口逆光\n阿青：青色短袄，高马尾\n茶馆：老木桌，竹帘' });
    expect(first.draft.params).toMatchObject({ n: 1, ratio: '16:9', size_mode: 'ratio' });
    // 参考图按角色、场景的顺序连线；绑定的节点不存在（ref-missing）就没有连线。
    expect(first.connections.map(edge => [edge.source_node_id, edge.target_node_id, edge.role])).toEqual([
      ['ref-role', first.nodeId, 'input'], ['ref-scene', first.nodeId, 'input']]);
    expect(second.connections.map(edge => edge.source_node_id)).toEqual(['ref-role']);
    expect(first.create?.position).toEqual(shotCellPosition(storyboard, 0, '16:9', 'image'));
    expect(second.create!.position.x - first.create!.position.x).toBe(368);
  });

  it('显示的镜头数、模型与总花费就是实际提交的内容', () => {
    const { document, storyboard } = documentWith(PAYLOAD);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a', 'b', 'c'], kind: 'image', count: 2, deps: deps([PRICED_IMAGE]) });
    const each = estimateGenerationCostForSubmission(PRICED_IMAGE, PRICED_IMAGE.models[0].id, 'image', plan.items[0].draft.params);
    expect(each).toBeGreaterThan(0);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every(item => item.draft.params.n === 2 && item.cost === each)).toBe(true);
    expect(plan.totalCost).toBeCloseTo(each! * 3);
    expect(plan.unpricedCount).toBe(0);
    // 应用后：新建的节点数 = 弹窗里的镜头数，每个节点的模型与参数 = 弹窗里算花费用的那份。
    const applied = applyShotGenerationPlan(document, plan);
    expect(applied.nodeIds).toEqual(plan.items.map(item => item.nodeId));
    const created = applied.document.nodes.filter(node => node.type === 'image');
    expect(created).toHaveLength(3);
    for (const item of plan.items) {
      const node = created.find(candidate => candidate.id === item.nodeId)!;
      expect(node.type === 'image' && node.data.generation_draft).toEqual(item.draft);
    }
    expect(storyboardPayloadOf(applied.document.nodes[0] as StoryboardNode).shots.map(shot => shot.image_node_id))
      .toEqual(plan.items.map(item => item.nodeId));
  });

  it('模型没有价格时总花费是未计价（null），不是 0', () => {
    const { document, storyboard } = documentWith(PAYLOAD);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a', 'b'], kind: 'image', deps: deps([UNPRICED_IMAGE]) });
    expect(plan.items.map(item => item.cost)).toEqual([null, null]);
    expect(plan.totalCost).toBeNull();
    expect(plan.unpricedCount).toBe(2);
  });

  it('确认之后新增或改动的镜头不会被这次确认带上', () => {
    const { document, storyboard } = documentWith(PAYLOAD);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a', 'b'], kind: 'image', deps: deps([PRICED_IMAGE]) });
    // 确认之后：改了镜头 a 的提示词，新增了镜头 d，删掉了镜头 b。
    const edited = normalizeStoryboardPayload({
      ...PAYLOAD,
      shots: [{ ...PAYLOAD.shots[0], image_prompt: '确认后才改的提示词' }, PAYLOAD.shots[2], { id: 'd', visual: '确认后新增' }],
    });
    const later: CanvasDocument = { ...document, nodes: document.nodes.map(node => (node.id === storyboard.id
      ? { ...storyboard, data: { ...storyboard.data, payload: edited as unknown as JsonValue } } : node)) };
    const applied = applyShotGenerationPlan(later, plan);
    const created = applied.document.nodes.filter(node => node.type === 'image');
    expect(created.map(node => node.title)).toEqual(['01 图']);  // 只有计划里还在的镜头 a；b 已删、d 不在计划里
    expect(created[0].type === 'image' && created[0].data.generation_draft?.prompt).toContain('门口逆光');
    expect(applied.nodeIds).toEqual([plan.items[0].nodeId]);
    const shots = storyboardPayloadOf(applied.document.nodes[0] as StoryboardNode).shots;
    expect(shots.map(shot => [shot.id, shot.image_node_id])).toEqual([['a', plan.items[0].nodeId], ['c', null], ['d', null]]);
    expect(shots[0].image_prompt).toBe('确认后才改的提示词');  // 镜头表里的改动原样保留
  });

  it('重跑单个镜头只动这一镜', () => {
    const draft = { mode: 'image' as const, prompt: '已有提示词', input_policy: 'all_connected' as const, model: PRICED_IMAGE.models[0].id, alias: PRICED_IMAGE.alias, params: { n: 1 }, updated_at: '' };
    const { document, storyboard } = documentWith(
      { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[0], image_node_id: 'image-a' }, { ...PAYLOAD.shots[1], image_node_id: 'image-b' }] },
      [imageNode('image-a', 'v-a', { generation_draft: draft }), imageNode('image-b', 'v-b', { generation_draft: { ...draft, prompt: '另一镜' } })],
      [imageVersion('v-a'), imageVersion('v-b')]);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a'], kind: 'image', count: 3, deps: deps([PRICED_IMAGE]) });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ nodeId: 'image-a', create: null, connections: [] });
    const applied = applyShotGenerationPlan(document, plan);
    expect(applied.nodeIds).toEqual(['image-a']);
    expect(applied.document.nodes).toHaveLength(document.nodes.length);  // 没有新建节点
    expect(applied.document.nodes.find(node => node.id === 'image-b')).toBe(document.nodes.find(node => node.id === 'image-b'));
    const rerun = applied.document.nodes.find(node => node.id === 'image-a')!;
    expect(rerun.type === 'image' && rerun.data.generation_draft).toMatchObject({ prompt: '已有提示词', params: { n: 3 } });
    expect(rerun.type === 'image' && rerun.data.current_version_id).toBe('v-a');
  });

  it('正在生成的镜头跳过并说明', () => {
    const draft = { mode: 'image' as const, prompt: 'p', input_policy: 'all_connected' as const, model: PRICED_IMAGE.models[0].id, alias: PRICED_IMAGE.alias, params: {}, updated_at: '' };
    const { document, storyboard } = documentWith(
      { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[0], image_node_id: 'image-a' }] },
      [imageNode('image-a', null, { generation_draft: draft, active_run_id: 'run-1' })]);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a'], kind: 'image', deps: deps([PRICED_IMAGE]) });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ shotId: 'a', label: '01', reason: '正在生成' }]);
  });

  it('没有可用模型时不建节点', () => {
    const { document, storyboard } = documentWith(PAYLOAD);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a'], kind: 'image', deps: deps([]) });
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toBe('没有可用的图片模型');
  });
});

describe('出视频', () => {
  const withImages = () => documentWith(
    { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[0], image_node_id: 'image-a' }, { ...PAYLOAD.shots[1], image_node_id: 'image-empty' }, PAYLOAD.shots[2]] },
    [imageNode('image-a', 'v-a'), imageNode('image-empty', null)], [imageVersion('v-a')]);

  it('没有图的镜头不能出视频，并说明原因', () => {
    const { document, storyboard } = withImages();
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a', 'b', 'c'], kind: 'video', deps: deps([VIDEO]) });
    expect(plan.items.map(item => item.shotId)).toEqual(['a']);
    expect(plan.skipped).toEqual([
      { shotId: 'b', label: '02', reason: NO_IMAGE_FOR_VIDEO },   // 图片节点还是空的
      { shotId: 'c', label: '03', reason: NO_IMAGE_FOR_VIDEO },   // 没有图片节点
    ]);
  });

  it('首帧取这一镜的图，提示词写在草稿里，时长取不小于计划时长的最小档', () => {
    const { document, storyboard } = withImages();
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a'], kind: 'video', deps: deps([VIDEO]) });
    const [item] = plan.items;
    expect(item.create).toMatchObject({ type: 'video', title: '01 视频' });
    expect(item.draft).toMatchObject({ mode: 'video', prompt: '推门走入', model: VIDEO.models[0].id });
    expect(item.draft.prompt).not.toContain('@');
    expect(item.draft.params).toMatchObject({ frame_mode: 'firstlast', ratio: '16:9' });
    expect(item.draft.params.duration).toBeGreaterThanOrEqual(4);
    expect(item.connections).toEqual([{ id: expect.any(String), role: 'input', slot: 'first_frame', source_node_id: 'image-a', target_node_id: item.nodeId }]);
    expect(item.create!.position.y).toBeGreaterThan(shotCellPosition(storyboard, 0, '16:9', 'image').y);
    const applied = applyShotGenerationPlan(document, plan);
    expect(storyboardPayloadOf(applied.document.nodes[0] as StoryboardNode).shots[0]).toMatchObject({ image_node_id: 'image-a', video_node_id: item.nodeId });
    expect(applied.document.connections).toHaveLength(1);
  });

  it('计划时长超过模型最长档时取最长一档', () => {
    const { document, storyboard } = documentWith(
      { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[2], image_node_id: 'image-a' }] }, [imageNode('image-a', 'v-a')], [imageVersion('v-a')]);
    const [item] = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['c'], kind: 'video', deps: deps([VIDEO]) }).items;
    expect(item.draft.params.duration).toBeLessThan(20);
    expect(item.draft.params.duration).toBeGreaterThanOrEqual(10);
  });
});

describe('默认范围', () => {
  it('出图取还没有图的镜头，出视频取有图但还没有视频的镜头', () => {
    const { document, storyboard } = documentWith(
      { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[0], image_node_id: 'image-a' }, PAYLOAD.shots[1], PAYLOAD.shots[2]] },
      [imageNode('image-a', 'v-a')], [imageVersion('v-a')]);
    const payload = storyboardPayloadOf(storyboard);
    expect(defaultShotSelection(document, payload, 'image')).toEqual(['b', 'c']);
    expect(defaultShotSelection(document, payload, 'video')).toEqual(['a']);
  });
});

describe('重新生成后的改绑', () => {
  it('结果落到新节点时，这一镜改绑过去并沿用标题，其它镜头不动', () => {
    const draft = { mode: 'image' as const, prompt: 'p', input_policy: 'all_connected' as const, model: PRICED_IMAGE.models[0].id, alias: PRICED_IMAGE.alias, params: {}, updated_at: '' };
    const { document, storyboard } = documentWith(
      { ...PAYLOAD, shots: [{ ...PAYLOAD.shots[0], image_node_id: 'image-a' }, { ...PAYLOAD.shots[1], image_node_id: 'image-b' }] },
      [imageNode('image-a', 'v-a', { generation_draft: draft }), imageNode('image-b', 'v-b'), imageNode('image-new', null)],
      [imageVersion('v-a'), imageVersion('v-b')]);
    const plan = planShotGeneration({ document, storyboardNodeId: storyboard.id, shotIds: ['a'], kind: 'image', deps: deps([PRICED_IMAGE]) });
    const rebound = rebindShotResult(document, plan, 'a', 'image-new', '01 图');
    expect(storyboardPayloadOf(rebound.nodes[0] as StoryboardNode).shots.map(shot => shot.image_node_id)).toEqual(['image-new', 'image-b']);
    expect(rebound.nodes.find(node => node.id === 'image-new')?.title).toBe('01 图');
    expect(rebound.nodes.find(node => node.id === 'image-a')).toBe(document.nodes.find(node => node.id === 'image-a'));
    // 结果节点类型不符、或镜头已被删掉：不动。
    expect(rebindShotResult(document, plan, 'a', 'ref-missing', '01 图')).toBe(document);
    expect(rebindShotResult(document, plan, 'gone', 'image-new', '01 图')).toBe(document);
  });
});
