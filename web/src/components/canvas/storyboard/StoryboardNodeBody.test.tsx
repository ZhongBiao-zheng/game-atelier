import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';

import {
  STORYBOARD_MAX_SHOTS, STORYBOARD_TOO_LARGE, createStoryboardNode, isStoryboardNode, normalizeStoryboardPayload,
  storyboardPayloadOf, type StoryboardNode,
} from '@/lib/canvasStoryboard';
import type { CanvasContentVersion, CanvasNode, JsonValue } from '@/schema/canvas';

import { StoryboardNodeBody, type StoryboardHost } from './StoryboardNodeBody';

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

it('不依赖插件注册表、批准与沙箱', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith('.test.tsx')) continue;
    expect(source, path).not.toContain('plugin-host');
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
