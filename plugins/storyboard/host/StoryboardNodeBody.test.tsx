import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';

import {
  STORYBOARD_MAX_SHOTS, STORYBOARD_TOO_LARGE, createStoryboardNode, isStoryboardNode, normalizeStoryboardPayload,
  storyboardAutoHeight, storyboardPayloadOf, type StoryboardNode,
} from './canvasStoryboard';
import type { CanvasContentVersion, CanvasNode, JsonValue } from '@/schema/canvas';

import { StoryboardNodeBody, type StoryboardHost } from './StoryboardNodeBody';
import { NO_IMAGE_FOR_VIDEO, type ShotGenerationPlan } from './storyboardGeneration';

const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function storyboard(payload: unknown): StoryboardNode {
  const node = createStoryboardNode('plugin-1', { x: 0, y: 0 });
  return { ...node, data: { ...node.data, payload: payload as JsonValue } };
}

const imageNode = { id: 'image-1', type: 'image', title: '图', position: { x: 0, y: 0 }, z_index: 0,
  data: { current_version_id: 'v1', generation_draft: null, active_run_id: null, display: { fit: 'contain', free_resize: false } } } as CanvasNode;
const videoNode = { ...imageNode, id: 'video-1', type: 'video' } as CanvasNode;
const imageVersion = { version_id: 'v1', kind: 'image', path: 'a.png', mime_type: 'image/png', bytes: 1,
  created_at: '', sha256: '', origin: { kind: 'user_edit' } } as CanvasContentVersion;

function Harness({ initial, overrides = {}, onNode }: {
  initial: StoryboardNode; overrides?: Partial<StoryboardHost>; onNode?: (node: StoryboardNode) => void;
}) {
  const [node, setNode] = useState(initial);
  const host: StoryboardHost = {
    projectId: 'canvas-test',
    findNode: id => [imageNode, videoNode].find(item => item.id === id),
    resolveVersion: id => (id === 'v1' ? imageVersion : undefined),
    updateNode: (_id, updater) => setNode(current => {
      const next = updater(current);
      if (!isStoryboardNode(next)) throw new Error('节点类型被改了');
      onNode?.(next);
      return next;
    }),
    recordHistory: vi.fn(),
    selectNode: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  };
  return <StoryboardNodeBody node={node} host={host} />;
}

function openEditor() {
  fireEvent.doubleClick(screen.getByText(/镜 ·/));
  return screen.getByRole('dialog');
}

it('显示镜头数、总时长与每镜摘要', () => {
  render(<Harness initial={storyboard({ shots: [
    { id: 'a', shot_size: '中景', camera: '推', duration_s: 4, visual: '倒茶' },
    { id: 'b', duration_s: 6 },
  ] })} />);
  expect(screen.getByText('2 镜 · 10 秒')).toBeInTheDocument();
  expect(screen.getByText('中景 · 推 · 4 秒')).toBeInTheDocument();
  expect(screen.getByText('倒茶')).toBeInTheDocument();
  expect(screen.getByText('未填写画面')).toBeInTheDocument();
});

it('空分镜提示双击添加', () => {
  render(<Harness initial={storyboard({})} />);
  expect(screen.getByText('0 镜 · 0 秒')).toBeInTheDocument();
  expect(screen.getByText('双击添加镜头')).toBeInTheDocument();
});

it('载荷里的标记只当文本显示', () => {
  const html = '<img src=x onerror="window.pwned=1"><b>粗</b>';
  const { container } = render(<Harness initial={storyboard({
    entities: [{ id: 'e1', name: html, description: html }],
    shots: [{ id: 'a', visual: html, shot_size: html, scene: html, entity_ids: ['e1'] }],
  })} />);
  expect(screen.getByText(html)).toBeInTheDocument();
  expect(container.querySelector('img, b, script')).toBeNull();
  const dialog = openEditor();
  expect(dialog.querySelector('img, b, script')).toBeNull();
  expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith('.test.tsx')) continue;
    expect(source, path).not.toContain('dangerouslySetInnerHTML');
    expect(source, path).not.toContain('innerHTML');
  }
});

it('绑定的节点不存在或类型不符时当作没有绑定', () => {
  const selectNode = vi.fn();
  const { container } = render(<Harness overrides={{ selectNode }} initial={storyboard({ shots: [
    { id: 'ok', visual: '有图', image_node_id: 'image-1' },
    { id: 'wrong', visual: '绑到了视频', image_node_id: 'video-1' },
    { id: 'gone', visual: '节点没了', image_node_id: 'deleted' },
  ] })} />);
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('/versions/v1/media'));
  fireEvent.click(screen.getByText('绑到了视频'));
  fireEvent.click(screen.getByText('节点没了'));
  expect(selectNode).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('有图'));
  expect(selectNode).toHaveBeenCalledWith('image-1');
});

it('宿主插件只用宿主插件接口，不碰沙箱、批准与消息通道', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith('.test.tsx')) continue;
    const hosts = [...source.matchAll(/from '@\/plugin-host\/([^']+)'/g)].map(match => match[1]);
    expect(hosts.filter(name => name !== 'hostPlugins'), path).toEqual([]);
  }
});

it('在弹窗里添加、填写、复制、排序与删除镜头', () => {
  let latest: StoryboardNode | null = null;
  const recordHistory = vi.fn();
  render(<Harness initial={storyboard({})} overrides={{ recordHistory }} onNode={node => { latest = node; }} />);
  const dialog = openEditor();
  fireEvent.click(within(dialog).getByRole('button', { name: '添加镜头' }));
  fireEvent.change(within(dialog).getByLabelText('画面'), { target: { value: '推门' } });
  fireEvent.change(within(dialog).getByLabelText('画面'), { target: { value: '推门进屋' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '近景' }));
  // 添加一步、连续输入一步、点预设仍在同一次输入里。
  expect(recordHistory).toHaveBeenCalledTimes(2);
  fireEvent.click(within(dialog).getByRole('button', { name: '添加镜头' }));
  fireEvent.change(within(dialog).getByLabelText('画面'), { target: { value: '坐下' } });
  let shots = storyboardPayloadOf(latest!).shots;
  expect(shots.map(shot => [shot.visual, shot.shot_size])).toEqual([['推门进屋', '近景'], ['坐下', '']]);

  const list = within(dialog).getByRole('list', { name: '镜头' });
  fireEvent.keyDown(within(list).getByRole('button', { name: '镜头 02 操作' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '上移' }));
  shots = storyboardPayloadOf(latest!).shots;
  expect(shots.map(shot => shot.visual)).toEqual(['坐下', '推门进屋']);

  fireEvent.keyDown(within(list).getByRole('button', { name: '镜头 01 操作' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
  expect(storyboardPayloadOf(latest!).shots.map(shot => shot.visual)).toEqual(['推门进屋']);
});

it('添加角色并在镜头里勾选', () => {
  let latest: StoryboardNode | null = null;
  render(<Harness initial={storyboard({ shots: [{ id: 'a' }] })} onNode={node => { latest = node; }} />);
  const dialog = openEditor();
  fireEvent.mouseDown(within(dialog).getByRole('tab', { name: '角色与场景' }), { button: 0 });
  fireEvent.click(within(dialog).getByRole('button', { name: '添加' }));
  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '阿青' } });
  fireEvent.change(within(dialog).getByLabelText('风格前缀'), { target: { value: '水墨' } });
  fireEvent.mouseDown(within(dialog).getByRole('tab', { name: '镜头' }), { button: 0 });
  fireEvent.click(within(dialog).getByRole('button', { name: '阿青' }));
  const payload = storyboardPayloadOf(latest!);
  expect(payload.style_prefix).toBe('水墨');
  expect(payload.entities.map(entity => entity.name)).toEqual(['阿青']);
  expect(payload.shots[0].entity_ids).toEqual([payload.entities[0].id]);
});

it('超过载荷上限时不写入并提示一句话', () => {
  const reportError = vi.fn();
  const onNode = vi.fn();
  const heavy = normalizeStoryboardPayload({
    shots: Array.from({ length: STORYBOARD_MAX_SHOTS - 1 }, (_, index) => ({ id: `s${index}`, visual: '画'.repeat(700) })),
  });
  render(<Harness initial={storyboard(heavy)} overrides={{ reportError }} onNode={onNode} />);
  const dialog = openEditor();
  fireEvent.change(within(dialog).getByLabelText('出图提示词'), { target: { value: '图'.repeat(4000) } });
  expect(reportError).toHaveBeenCalledWith(STORYBOARD_TOO_LARGE);
  expect(onNode).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------- 批量生成的确认弹窗

function fakePlan(kind: 'image' | 'video', shotIds: readonly string[], count: number, cost: number | null): ShotGenerationPlan {
  const items = shotIds.map((shotId, index) => ({
    shotId, label: String(index + 1).padStart(2, '0'), nodeId: `${kind}-${shotId}`, create: null, connections: [], cost,
    draft: { mode: kind, prompt: '', input_policy: 'all_connected' as const, model: 'seedream-5', params: { n: count }, updated_at: '' },
  }));
  return {
    storyboardNodeId: 'plugin-1', kind, items, skipped: [], models: ['seedream-5'],
    unpricedCount: cost === null ? items.length : 0,
    totalCost: cost === null ? null : items.reduce((sum, item) => sum + (item.cost ?? 0) * count, 0),
  };
}

const THREE_SHOTS = { shots: [{ id: 'a', visual: '一' }, { id: 'b', visual: '二' }, { id: 'c', visual: '三' }] };

it('确认弹窗显示的镜头数、模型与花费来自同一份计划，确认时提交的就是这一份', () => {
  const planShots = vi.fn((_node: string, shotIds: readonly string[], kind: 'image' | 'video', count: number) => fakePlan(kind, shotIds, count, 0.22));
  const runShots = vi.fn(async () => undefined);
  render(<Harness initial={storyboard(THREE_SHOTS)} overrides={{ planShots, runShots }} />);
  const dialog = openEditor();
  fireEvent.click(within(dialog).getByRole('button', { name: '生成图片…' }));
  const confirm = screen.getByRole('alertdialog');
  expect(planShots).toHaveBeenLastCalledWith('plugin-1', ['a', 'b', 'c'], 'image', 1);  // 没勾选：全部还没出图的镜头
  expect(within(confirm).getByText('3 个（01、02、03）')).toBeInTheDocument();
  expect(within(confirm).getByText('seedream-5')).toBeInTheDocument();
  expect(within(confirm).getByTestId('storyboard-plan-cost')).toHaveTextContent('0.66¥');
  expect(runShots).not.toHaveBeenCalled();
  // 改成每镜 2 张：重新算计划，花费跟着变，提交的是新的这一份。
  fireEvent.click(within(confirm).getByRole('radio', { name: '2 张' }));
  expect(within(confirm).getByTestId('storyboard-plan-cost')).toHaveTextContent('1.32¥');
  fireEvent.click(within(confirm).getByRole('button', { name: '生成 3 个' }));
  expect(runShots).toHaveBeenCalledTimes(1);
  expect(runShots).toHaveBeenCalledWith(planShots.mock.results.at(-1)!.value);
  expect(planShots.mock.calls.at(-1)).toEqual(['plugin-1', ['a', 'b', 'c'], 'image', 2]);
});

it('模型没有价格时写未计价，不写 0', () => {
  const planShots = vi.fn((_node: string, shotIds: readonly string[], kind: 'image' | 'video', count: number) => fakePlan(kind, shotIds, count, null));
  render(<Harness initial={storyboard(THREE_SHOTS)} overrides={{ planShots, runShots: vi.fn(async () => undefined) }} />);
  fireEvent.click(within(openEditor()).getByRole('button', { name: '生成图片…' }));
  const cost = within(screen.getByRole('alertdialog')).getByTestId('storyboard-plan-cost');
  expect(cost).toHaveTextContent('未计价');
  expect(cost.textContent).not.toMatch(/0/);
});

it('取消确认不提交；只勾选的镜头进入计划', () => {
  const planShots = vi.fn((_node: string, shotIds: readonly string[], kind: 'image' | 'video', count: number) => fakePlan(kind, shotIds, count, 0.22));
  const runShots = vi.fn(async () => undefined);
  render(<Harness initial={storyboard(THREE_SHOTS)} overrides={{ planShots, runShots }} />);
  const dialog = openEditor();
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '选择镜头 02' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '生成图片…' }));
  expect(planShots).toHaveBeenLastCalledWith('plugin-1', ['b'], 'image', 1);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消' }));
  expect(runShots).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('没有图的镜头不能出视频，并写明原因', () => {
  const planShots = vi.fn(() => ({ ...fakePlan('video', [], 1, 0.5), skipped: [{ shotId: 'a', label: '01', reason: NO_IMAGE_FOR_VIDEO }] }));
  render(<Harness initial={storyboard({ shots: [{ id: 'a', visual: '一' }] })} overrides={{ planShots, runShots: vi.fn(async () => undefined) }} />);
  const dialog = openEditor();
  expect(within(dialog).getByRole('button', { name: '出视频' })).toBeDisabled();
  expect(within(dialog).getByText(NO_IMAGE_FOR_VIDEO)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: '出图' })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '生成视频…' }));
  const confirm = screen.getByRole('alertdialog');
  expect(within(confirm).getByText('0 个')).toBeInTheDocument();
  expect(within(confirm).getByRole('button', { name: '生成 0 个' })).toBeDisabled();
});

it('有图的镜头可以出视频，状态点跟着节点走', () => {
  const planShots = vi.fn((_node: string, shotIds: readonly string[], kind: 'image' | 'video', count: number) => fakePlan(kind, shotIds, count, 0.5));
  render(<Harness initial={storyboard({ shots: [{ id: 'a', visual: '一', image_node_id: 'image-1' }, { id: 'b', visual: '二' }] })}
    overrides={{ planShots, runShots: vi.fn(async () => undefined) }} />);
  expect(screen.getAllByRole('img', { name: '图片已完成' })).toHaveLength(1);
  expect(screen.getAllByRole('img', { name: '图片未生成' })).toHaveLength(1);
  const dialog = openEditor();
  expect(within(dialog).getByRole('button', { name: '出视频' })).toBeEnabled();
  expect(within(dialog).getByRole('button', { name: '重新出图' })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '生成视频…' }));
  expect(planShots).toHaveBeenLastCalledWith('plugin-1', ['a'], 'video', 1);  // 只有有图的那一镜
});

it('节点高度随镜头数变化，手动改过高度后不再自动调整', () => {
  let latest: StoryboardNode | null = null;
  const { unmount } = render(<Harness initial={storyboard({})} onNode={node => { latest = node; }} />);
  fireEvent.click(within(openEditor()).getByRole('button', { name: '添加镜头' }));
  expect(latest!.size?.height).toBe(storyboardAutoHeight(1));
  unmount();
  const resized = { ...storyboard({}), size: { width: 420, height: 400 } };
  render(<Harness initial={resized} onNode={node => { latest = node; }} />);
  fireEvent.click(within(openEditor()).getByRole('button', { name: '添加镜头' }));
  expect(latest!.size?.height).toBe(400);
  expect([0, 3, 40].map(storyboardAutoHeight)).toEqual([176, 192, 480]);
});

it('镜头可以改绑到画布上另一个已有内容的视频节点', () => {
  let latest: StoryboardNode | null = null;
  const videos = [
    { ...videoNode, id: 'video-old', title: '01 视频（旧）', data: { ...videoNode.data, current_version_id: 'v-old' } },
    { ...videoNode, id: 'video-new', title: '01 视频', data: { ...videoNode.data, current_version_id: 'v-new' } },
    { ...videoNode, id: 'video-empty', title: '空视频', data: { ...videoNode.data, current_version_id: null } },
  ] as CanvasNode[];
  const versions: Record<string, CanvasContentVersion> = {
    'v-old': { ...imageVersion, version_id: 'v-old', kind: 'video' } as CanvasContentVersion,
    'v-new': { ...imageVersion, version_id: 'v-new', kind: 'video' } as CanvasContentVersion,
  };
  render(<Harness initial={storyboard({ shots: [{ id: 'a', visual: '一', video_node_id: 'video-new' }] })}
    overrides={{
      listNodes: () => videos, findNode: id => videos.find(node => node.id === id),
      resolveVersion: id => (id ? versions[id] : undefined),
    }} onNode={node => { latest = node; }} />);
  const dialog = openEditor();
  const select = within(dialog).getByRole('combobox', { name: '本镜视频' });
  expect(select).toHaveTextContent('01 视频');
  fireEvent.keyDown(select, { key: 'Enter' });
  const options = screen.getAllByRole('option').map(option => option.textContent);
  expect(options).toEqual(['未绑定', '01 视频（旧）', '01 视频']);  // 没有内容的节点不在可选项里
  fireEvent.click(screen.getByRole('option', { name: '01 视频（旧）' }));
  expect(storyboardPayloadOf(latest!).shots[0].video_node_id).toBe('video-old');
});
