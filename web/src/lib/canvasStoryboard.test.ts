import { describe, expect, it } from 'vitest';

import fixture from '../../../tests/fixtures/storyboard_payload_cases.json';
import type { CanvasNode } from '@/schema/canvas';
import {
  STORYBOARD_MAX_ENTITIES, STORYBOARD_MAX_SCRIPT_NODES, STORYBOARD_MAX_SHOTS, STORYBOARD_MAX_SHOT_ENTITIES,
  STORYBOARD_PAYLOAD_MAX_BYTES, STORYBOARD_TOO_LARGE, addStoryboardEntity, addStoryboardShot, createStoryboardNode,
  duplicateStoryboardShot, emptyStoryboardEntity, emptyStoryboardShot, formatStoryboardDuration, isStoryboardNode,
  mergeParsedStoryboard, moveStoryboardShot, normalizeStoryboardPayload, remapStoryboardPayload, removeStoryboardEntity, removeStoryboardShot,
  resolveStoryboardBinding, storyboardPayloadOf, storyboardShotLabel, storyboardTotalDuration, updateStoryboardShot,
  withStoryboardPayload, type StoryboardPayload,
} from './canvasStoryboard';

/** 夹具里的 {"repeat": 文本, "count": n} 展开成重复 n 次的字符串。 */
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value !== null && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join() === 'count,repeat') return String(item.repeat).repeat(Number(item.count));
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, expand(child)]));
  }
  return value;
}

function payloadWith(...ids: string[]): StoryboardPayload {
  return normalizeStoryboardPayload({ shots: ids.map(id => ({ id, visual: id })) });
}

describe('分镜载荷的宽容读取', () => {
  it.each(fixture.cases)('$name', testCase => {
    expect(normalizeStoryboardPayload(expand(testCase.input))).toEqual(expand(testCase.expected));
  });

  it('整理过的载荷再读一次不变', () => {
    for (const testCase of fixture.cases) {
      const once = normalizeStoryboardPayload(expand(testCase.input));
      expect(normalizeStoryboardPayload(once)).toEqual(once);
    }
  });

  it('数量上限与后端一致', () => {
    expect(fixture.limits).toEqual({
      shots: STORYBOARD_MAX_SHOTS, entities: STORYBOARD_MAX_ENTITIES,
      shot_entities: STORYBOARD_MAX_SHOT_ENTITIES, script_nodes: STORYBOARD_MAX_SCRIPT_NODES,
    });
    const entities = Array.from({ length: STORYBOARD_MAX_ENTITIES + 5 }, (_, index) => ({ id: `e${index}` }));
    const payload = normalizeStoryboardPayload({
      entities,
      shots: Array.from({ length: STORYBOARD_MAX_SHOTS + 5 }, (_, index) => ({ id: `s${index}`, entity_ids: entities.map(item => item.id) })),
      script_node_ids: Array.from({ length: STORYBOARD_MAX_SCRIPT_NODES + 5 }, (_, index) => `text-${index}`),
    });
    expect(payload.entities).toHaveLength(STORYBOARD_MAX_ENTITIES);
    expect(payload.shots).toHaveLength(STORYBOARD_MAX_SHOTS);
    expect(payload.shots[0].entity_ids).toHaveLength(STORYBOARD_MAX_SHOT_ENTITIES);
    expect(payload.script_node_ids).toHaveLength(STORYBOARD_MAX_SCRIPT_NODES);
  });
});

describe('分镜节点', () => {
  it('新建的节点只用插件节点已有的字段', () => {
    const node = createStoryboardNode('plugin-1', { x: 0, y: 0 }, ['text-1']);
    expect(node.type).toBe('plugin');
    expect(Object.keys(node.data).sort()).toEqual(
      ['data_schema_version', 'generation_draft', 'node_type', 'payload', 'plugin_id', 'plugin_version']);
    expect(isStoryboardNode(node)).toBe(true);
    expect(storyboardPayloadOf(node).script_node_ids).toEqual(['text-1']);
  });

  it('别的插件节点不算分镜节点', () => {
    const node = createStoryboardNode('plugin-1', { x: 0, y: 0 });
    expect(isStoryboardNode({ ...node, data: { ...node.data, plugin_id: 'frames' } } as CanvasNode)).toBe(false);
    expect(isStoryboardNode(null)).toBe(false);
  });

  it('超过载荷上限时不写入，提示一句话', () => {
    const node = createStoryboardNode('plugin-1', { x: 0, y: 0 });
    const heavy = normalizeStoryboardPayload({
      shots: Array.from({ length: STORYBOARD_MAX_SHOTS }, (_, index) => ({ id: `s${index}`, visual: '画'.repeat(2000) })),
    });
    expect(new TextEncoder().encode(JSON.stringify(heavy)).length).toBeGreaterThan(STORYBOARD_PAYLOAD_MAX_BYTES);
    expect(withStoryboardPayload(node, heavy)).toEqual({ ok: false, message: STORYBOARD_TOO_LARGE });
    const written = withStoryboardPayload(node, payloadWith('a'));
    expect(written.ok && storyboardPayloadOf(written.node).shots.map(shot => shot.id)).toEqual(['a']);
  });
});

describe('镜头增删改排序', () => {
  it('添加到末尾或指定镜头之后', () => {
    const base = payloadWith('a', 'b');
    expect(addStoryboardShot(base, emptyStoryboardShot('c')).shots.map(shot => shot.id)).toEqual(['a', 'b', 'c']);
    expect(addStoryboardShot(base, emptyStoryboardShot('c'), 'a').shots.map(shot => shot.id)).toEqual(['a', 'c', 'b']);
  });

  it('到上限或 id 重复时不添加', () => {
    const full = payloadWith(...Array.from({ length: STORYBOARD_MAX_SHOTS }, (_, index) => `s${index}`));
    expect(addStoryboardShot(full, emptyStoryboardShot('extra'))).toBe(full);
    const base = payloadWith('a');
    expect(addStoryboardShot(base, emptyStoryboardShot('a'))).toBe(base);
  });

  it('复制出的镜头排在原镜头后面，不带图片与视频绑定', () => {
    const base = updateStoryboardShot(payloadWith('a', 'b'), 'a', { image_node_id: 'image-1', video_node_id: 'video-1' });
    const copied = duplicateStoryboardShot(base, 'a', 'c');
    expect(copied.shots.map(shot => shot.id)).toEqual(['a', 'c', 'b']);
    expect(copied.shots[1]).toMatchObject({ visual: 'a', image_node_id: null, video_node_id: null });
    expect(copied.shots[0].image_node_id).toBe('image-1');
  });

  it('删除与重排只改镜头表', () => {
    const base = payloadWith('a', 'b', 'c');
    expect(removeStoryboardShot(base, 'b').shots.map(shot => shot.id)).toEqual(['a', 'c']);
    expect(moveStoryboardShot(base, 'c', 0).shots.map(shot => shot.id)).toEqual(['c', 'a', 'b']);
    expect(moveStoryboardShot(base, 'a', 99).shots.map(shot => shot.id)).toEqual(['b', 'c', 'a']);
    expect(moveStoryboardShot(base, 'a', 0)).toBe(base);
    expect(moveStoryboardShot(base, 'ghost', 1)).toBe(base);
  });

  it('序号与总时长由顺序和时长算出', () => {
    expect([0, 8, 99].map(storyboardShotLabel)).toEqual(['01', '09', '100']);
    const base = updateStoryboardShot(payloadWith('a', 'b'), 'a', { duration_s: 3.5 });
    expect(storyboardTotalDuration(base)).toBe(8.5);
    expect(formatStoryboardDuration(8.5)).toBe('8.5 秒');
    expect(formatStoryboardDuration(125)).toBe('2:05');
  });

  it('删除条目时同时从镜头里移除', () => {
    let payload = addStoryboardEntity(payloadWith('a'), emptyStoryboardEntity('e1'));
    payload = addStoryboardEntity(payload, emptyStoryboardEntity('e2', 'scene'));
    payload = updateStoryboardShot(payload, 'a', { entity_ids: ['e1', 'e2'] });
    const removed = removeStoryboardEntity(payload, 'e1');
    expect(removed.entities.map(entity => entity.id)).toEqual(['e2']);
    expect(removed.shots[0].entity_ids).toEqual(['e2']);
  });
});

describe('节点绑定', () => {
  const nodes = new Map<string, CanvasNode>([
    ['image-1', { id: 'image-1', type: 'image' } as CanvasNode],
    ['video-1', { id: 'video-1', type: 'video' } as CanvasNode],
  ]);
  const find = (id: string) => nodes.get(id);

  it('只认当前文档里类型相符的节点', () => {
    expect(resolveStoryboardBinding(find, 'image-1', 'image')?.id).toBe('image-1');
    expect(resolveStoryboardBinding(find, 'video-1', 'image')).toBeNull();
    expect(resolveStoryboardBinding(find, 'gone', 'image')).toBeNull();
    expect(resolveStoryboardBinding(find, null, 'video')).toBeNull();
  });

  it('复制粘贴：一同复制的绑定改指新节点，其余清空', () => {
    const payload = normalizeStoryboardPayload({
      entities: [{ id: 'e1', reference_node_id: 'image-ref' }, { id: 'e2', reference_node_id: 'image-other' }],
      shots: [{ id: 'a', image_node_id: 'image-1', video_node_id: 'video-1' }],
      script_node_ids: ['text-1', 'text-2'],
    });
    const remapped = normalizeStoryboardPayload(remapStoryboardPayload(payload, new Map([
      ['image-1', 'image-9'], ['image-ref', 'image-8'], ['text-2', 'text-7'],
    ])));
    expect(remapped.shots[0]).toMatchObject({ image_node_id: 'image-9', video_node_id: null });
    expect(remapped.entities.map(entity => entity.reference_node_id)).toEqual(['image-8', null]);
    expect(remapped.script_node_ids).toEqual(['text-7']);
  });
});

describe('并入剧本解析结果', () => {
  const ids = () => {
    let next = 0;
    return (prefix: 's' | 'e') => `${prefix}-${next += 1}`;
  };
  const shot = (visual: string, entities: string[] = []) => ({
    scene: '', shot_size: '中景', camera: '', duration_s: 4, visual, dialogue: '', image_prompt: '', video_prompt: '', entities,
  });
  const base = normalizeStoryboardPayload({
    entities: [{ id: 'e-old', kind: 'scene', name: '茶馆', description: '老木桌', reference_node_id: 'image-1' }],
    shots: [{ id: 's-old', visual: '旧镜头', image_node_id: 'image-2' }],
  });

  it('追加：新条目去重，镜头里的名称换成 id', () => {
    const { payload, droppedShots } = mergeParsedStoryboard(base, [
      { entities: [{ kind: 'character', name: '阿青', description: '青色短袄' }, { kind: 'scene', name: '茶馆', description: '别的描述' }],
        shots: [shot('进门', ['阿青', '茶馆', '不存在'])] },
      { entities: [{ kind: 'character', name: '阿青', description: '重复' }], shots: [shot('坐下', ['阿青'])] },
    ], 'append', ids());
    expect(droppedShots).toBe(0);
    expect(payload.entities.map(entity => [entity.name, entity.description, entity.reference_node_id])).toEqual([
      ['茶馆', '老木桌', 'image-1'], ['阿青', '青色短袄', null]]);
    const qing = payload.entities[1].id;
    expect(payload.shots.map(item => [item.visual, item.entity_ids])).toEqual([
      ['旧镜头', []], ['进门', [qing, 'e-old']], ['坐下', [qing]]]);
    expect(payload.shots[1]).toMatchObject({ shot_size: '中景', duration_s: 4, image_node_id: null });
  });

  it('替换：清空现有镜头，条目保留', () => {
    const { payload } = mergeParsedStoryboard(base, [{ entities: [], shots: [shot('新镜头', ['茶馆'])] }], 'replace', ids());
    expect(payload.shots.map(item => item.visual)).toEqual(['新镜头']);
    expect(payload.entities.map(entity => entity.name)).toEqual(['茶馆']);
  });

  it('超过镜头上限的部分丢弃并回报数量', () => {
    const many = Array.from({ length: STORYBOARD_MAX_SHOTS + 3 }, (_, index) => shot(String(index)));
    const { payload, droppedShots } = mergeParsedStoryboard(base, [{ entities: [], shots: many }], 'append', ids());
    expect(payload.shots).toHaveLength(STORYBOARD_MAX_SHOTS);
    expect(droppedShots).toBe(4);
  });
});

describe('时间线读取', () => {
  it('与后端同一份夹具：按镜头顺序给出每镜选定的视频', async () => {
    const { default: timelineCase } = await import('../../../tests/fixtures/storyboard_timeline_case.json');
    const { storyboardTimeline } = await import('./canvasStoryboard');
    const nodes = timelineCase.nodes as unknown as CanvasNode[];
    const versions = timelineCase.content_versions as Record<string, { kind: string; version_id: string; duration_ms?: number }>;
    const rows = storyboardTimeline(
      normalizeStoryboardPayload(timelineCase.payload),
      id => nodes.find(node => node.id === id),
      id => (id ? versions[id] : undefined),
    );
    expect(rows).toEqual(timelineCase.expected);
  });
});
