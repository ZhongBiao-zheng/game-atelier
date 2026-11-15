import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import { listStoryboardParseModels, parseStoryboardSegment, planStoryboardParse } from '@/api/canvasStoryboard';
import { ApiError } from '@/api/http';
import { normalizeStoryboardPayload, type StoryboardPayload } from '@/lib/canvasStoryboard';
import type { CanvasContentVersion, CanvasNode } from '@/schema/canvas';

import type { StoryboardHost } from './StoryboardNodeBody';
import { StoryboardScript } from './StoryboardScript';

vi.mock('@/api/canvasStoryboard', () => ({
  listStoryboardParseModels: vi.fn(),
  planStoryboardParse: vi.fn(),
  parseStoryboardSegment: vi.fn(),
}));

const models = vi.mocked(listStoryboardParseModels);
const plan = vi.mocked(planStoryboardParse);
const parse = vi.mocked(parseStoryboardSegment);

const textNode = (id: string, title: string) => ({ id, type: 'text', title, position: { x: 0, y: 0 }, z_index: 0,
  data: { current_version_id: `v-${id}`, generation_draft: null, active_run_id: null, display: { scale: 'sm' } } }) as CanvasNode;
const nodes = [textNode('text-1', '第一集'), textNode('text-2', '第二集'), textNode('text-empty', '空白')];
const texts: Record<string, string> = { 'v-text-1': '第一场 茶馆\n阿青进门。', 'v-text-2': '第二场 街道', 'v-text-empty': '  ' };

function result(index: number, count: number, visual: string, overrides = {}) {
  return {
    segment_index: index, segment_count: count, notices: [],
    entities: [{ kind: 'character' as const, name: '阿青', description: '青色短袄' }],
    shots: [{ scene: '', shot_size: '中景', camera: '', duration_s: 4, visual, dialogue: '', image_prompt: '', video_prompt: '', entities: ['阿青'] }],
    usage: { input_tokens: 900, output_tokens: 400, cost_cny: null, job_id: `job-${index}` },
    ...overrides,
  };
}

function Harness({ initial, host = {}, onPayload, onWritten = () => undefined }: {
  initial: unknown; host?: Partial<StoryboardHost>; onPayload?: (payload: StoryboardPayload) => void; onWritten?: () => void;
}) {
  const [payload, setPayload] = useState(() => normalizeStoryboardPayload(initial));
  const fullHost: StoryboardHost = {
    projectId: 'canvas-test', findNode: id => nodes.find(node => node.id === id), listNodes: () => nodes,
    resolveVersion: id => (id && id in texts ? { version_id: id, kind: 'text', text: texts[id] } as CanvasContentVersion : undefined),
    updateNode: vi.fn(), recordHistory: vi.fn(), selectNode: vi.fn(), reportError: vi.fn(), savePendingEdits: vi.fn(async () => undefined),
    ...host,
  };
  return <StoryboardScript payload={payload} host={fullHost} onWritten={onWritten}
    change={next => { setPayload(next); onPayload?.(next); return true; }} />;
}

beforeEach(() => {
  window.localStorage.clear();
  models.mockReset().mockResolvedValue({ models: [
    { alias: 'chat', model_id: 'writer', name: '写手', max_cost_cny: null },
    { alias: 'chat', model_id: 'pro', name: '高级', max_cost_cny: 0.12 },
  ] });
  plan.mockReset().mockResolvedValue({ total_chars: 12, segments: [{ index: 0, chars: 12, preview: '第一场' }] });
  parse.mockReset();
});

const runButton = () => screen.findByRole('button', { name: /解析.*消耗对话额度/ });

it('列出剧本来源与对话模型，没有价格时写未计价', async () => {
  render(<Harness initial={{ script_node_ids: ['text-1', 'text-empty', 'ghost'] }} />);
  expect(await screen.findByText('未计价')).toBeInTheDocument();
  expect(screen.getByText('第一集')).toBeInTheDocument();
  expect(screen.getByText('12 字')).toBeInTheDocument();
  expect(screen.queryByText('空白')).toBeNull();  // 没内容的文本节点不算来源
  expect(await runButton()).toBeEnabled();
  expect(parse).not.toHaveBeenCalled();
});

it('没有剧本来源时不能解析', async () => {
  render(<Harness initial={{}} />);
  expect(await runButton()).toBeDisabled();
  expect(screen.getByText('选择放着剧本的文本节点')).toBeInTheDocument();
});

it('一次点击只解析一段：先保存，再预览，点写入才进分镜', async () => {
  parse.mockResolvedValue(result(0, 1, '进门'));
  const savePendingEdits = vi.fn(async () => undefined);
  const onPayload = vi.fn();
  const onWritten = vi.fn();
  render(<Harness initial={{ script_node_ids: ['text-1'], style_prefix: '水墨' }} host={{ savePendingEdits }}
    onPayload={onPayload} onWritten={onWritten} />);
  fireEvent.click(await runButton());
  expect(await screen.findByText(/1 镜 · 4 秒 · 新增条目 1/)).toBeInTheDocument();
  expect(savePendingEdits).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledWith('canvas-test', {
    script_node_ids: ['text-1'], segment_index: 0, segment_count: 1, alias: 'chat', model_id: 'writer',
    entities: [], style_prefix: '水墨',
  });
  expect(screen.getByText('1 次调用 · 1300 tokens · 未计价')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: '解析出的镜头' })).getByText('进门')).toBeInTheDocument();
  expect(onPayload).not.toHaveBeenCalled();  // 预览阶段不写分镜
  expect(screen.queryByRole('button', { name: /解析/ })).toBeNull();  // 全部段解析完，不再有解析按钮
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  const written = onPayload.mock.calls.at(-1)![0] as StoryboardPayload;
  expect(written.shots.map(shot => shot.visual)).toEqual(['进门']);
  expect(written.entities.map(entity => entity.name)).toEqual(['阿青']);
  expect(written.shots[0].entity_ids).toEqual([written.entities[0].id]);
  expect(onWritten).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(1);
});

it('长剧本逐段解析：每段各点一次，前面得到的条目带给后一段', async () => {
  plan.mockResolvedValue({ total_chars: 20000, segments: [0, 1, 2].map(index => ({ index, chars: 7000, preview: '' })) });
  parse.mockResolvedValueOnce(result(0, 3, '一')).mockResolvedValueOnce(result(1, 3, '二', { entities: [] }));
  render(<Harness initial={{ script_node_ids: ['text-1'] }} />);
  fireEvent.click(await runButton());
  const second = await screen.findByRole('button', { name: '解析第 2 / 3 段（消耗对话额度）' });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/已解析 1 \/ 3 段 · 1 镜/)).toBeInTheDocument();
  fireEvent.click(second);
  await screen.findByRole('button', { name: '解析第 3 / 3 段（消耗对话额度）' });
  expect(plan).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(parse.mock.calls[1][1]).toMatchObject({
    segment_index: 1, segment_count: 3, entities: [{ kind: 'character', name: '阿青', description: '青色短袄' }],
  });
  expect(screen.getByText(/已解析 2 \/ 3 段 · 2 镜/)).toBeInTheDocument();
});

it('失败时显示原因与详情，不自动重试，已解析的段保留', async () => {
  plan.mockResolvedValue({ total_chars: 16000, segments: [0, 1].map(index => ({ index, chars: 8000, preview: '' })) });
  parse.mockResolvedValueOnce(result(0, 2, '一')).mockRejectedValueOnce(new ApiError('解析剧本失败', {
    status: 502, reason: '对话模型响应超时，可以缩短内容或换一个更快的模型后再试', raw: 'Read timed out. (read timeout=180)',
  }));
  render(<Harness initial={{ script_node_ids: ['text-1'] }} />);
  fireEvent.click(await runButton());
  fireEvent.click(await screen.findByRole('button', { name: '解析第 2 / 2 段（消耗对话额度）' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('对话模型响应超时');
  expect(alert).toHaveTextContent('Read timed out');
  expect(parse).toHaveBeenCalledTimes(2);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(parse).toHaveBeenCalledTimes(2);  // 没有自动重试
  expect(screen.getByText(/已解析 1 \/ 2 段 · 1 镜/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '解析第 2 / 2 段（消耗对话额度）' })).toBeEnabled();
});

it('剧本在解析途中变了就从头来', async () => {
  parse.mockRejectedValue(new ApiError('解析剧本失败', { status: 409, reason: '剧本已变化，请重新开始解析' }));
  render(<Harness initial={{ script_node_ids: ['text-1'] }} />);
  fireEvent.click(await runButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('剧本已变化');
  expect(await screen.findByRole('button', { name: '解析（消耗对话额度）' })).toBeEnabled();
  expect(screen.queryByRole('region', { name: '解析结果' })).toBeNull();
});

it('已有镜头时默认追加，可以改成替换', async () => {
  parse.mockResolvedValue(result(0, 1, '新'));
  const onPayload = vi.fn();
  const initial = { script_node_ids: ['text-1'], shots: [{ id: 'old', visual: '旧' }] };
  const { unmount } = render(<Harness initial={initial} onPayload={onPayload} />);
  fireEvent.click(await runButton());
  fireEvent.click(await screen.findByRole('button', { name: '写入' }));
  expect((onPayload.mock.calls.at(-1)![0] as StoryboardPayload).shots.map(shot => shot.visual)).toEqual(['旧', '新']);
  unmount();
  render(<Harness initial={initial} onPayload={onPayload} />);
  fireEvent.click(await runButton());
  await screen.findByRole('button', { name: '写入' });
  fireEvent.click(screen.getByRole('radio', { name: '替换' }));
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  expect((onPayload.mock.calls.at(-1)![0] as StoryboardPayload).shots.map(shot => shot.visual)).toEqual(['新']);
});

it('放弃预览不写分镜', async () => {
  parse.mockResolvedValue(result(0, 1, '新'));
  const onPayload = vi.fn();
  render(<Harness initial={{ script_node_ids: ['text-1'] }} onPayload={onPayload} />);
  fireEvent.click(await runButton());
  fireEvent.click(await screen.findByRole('button', { name: '放弃' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '解析结果' })).toBeNull());
  expect(onPayload).not.toHaveBeenCalled();
});

it('记住上次用的对话模型', async () => {
  window.localStorage.setItem('atelier.storyboard-parse-model', 'chat\u0000pro');
  render(<Harness initial={{ script_node_ids: ['text-1'] }} />);
  expect(await screen.findByText('每段最多约 0.12¥')).toBeInTheDocument();
});
