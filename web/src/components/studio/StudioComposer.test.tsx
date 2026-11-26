import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { StudioComposer, useStudioComposer } from './StudioComposer';
import { readStudioView, updateStudioView } from '@/pages/studioDraft';

function Page({ home = false }: { home?: boolean }) {
  const state = useStudioComposer(home);
  return <StudioComposer state={state} onSubmit={vi.fn()} onToggleAssetPanel={vi.fn()} />;
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

function pickMode(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '选择生成模式' }));
  fireEvent.click(screen.getByRole('option', { name }));
}

function typeAgent(text: string) {
  const field = screen.getByRole('textbox', { name: 'Agent 消息' });
  field.textContent = text;
  fireEvent.input(field);
}

it('三种模式共用输入壳，保留 Agent 草稿并在刷新时恢复生成模式', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [], skills: [], models: [] }))));
  const first = render(<Page />);
  expect(screen.getByLabelText('选择生成模式')).toHaveTextContent('图片');
  fireEvent.click(screen.getByLabelText('选择生成模式'));
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Agent', '图片', '视频']);
  fireEvent.click(screen.getByRole('option', { name: 'Agent' }));
  expect(screen.queryByLabelText('选择厂商')).toBeNull();
  const track = screen.getByLabelText('选择生成模式').parentElement!.parentElement!;
  expect(Array.from(track.querySelectorAll('button')).map(btn => btn.getAttribute('aria-label') ?? btn.textContent))
    .toEqual(['选择生成模式', '选择模型', '创作模式', '模型偏好', '权限模式：Auto', '选择 Skill', '打开创作资产']);
  typeAgent('未发送的草稿');
  pickMode('视频');
  pickMode('Agent');
  expect(screen.getByRole('textbox')).toHaveTextContent('未发送的草稿');
  first.unmount();
  render(<Page />);
  expect(screen.getByLabelText('选择生成模式')).toHaveTextContent('Agent');
});

it('首页只在发送时新建会话，收件后跳到创作台并恢复同一会话', async () => {
  updateStudioView({ inputMode: 'agent', activeSessionId: 'old' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  const created = { session_id: 'new', revision: 1, status: 'idle', model: 'chat', model_alias: 'fake',
    title: '新对话', pending_approvals: [], turns: [], messages: [] };
  const calls = vi.fn(async (path: string, init?: RequestInit) => {
    let result: unknown = {};
    if (path.endsWith('/models')) result = { models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] };
    if (path.endsWith('/skills')) result = { skills: [] };
    if (path.endsWith('/sessions')) result = init?.method === 'POST' ? created : { sessions: [{ session_id: 'old' }] };
    if (path.endsWith('/messages')) result = { ...created, status: 'running', revision: 2 };
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal('fetch', calls);
  const location = memoryLocation({ path: '/', record: true });
  render(<Router hook={location.hook}><Page home /></Router>);
  typeAgent('设计灯笼');
  await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('发送'));
  await waitFor(() => expect(readStudioView()).toEqual({ inputMode: 'agent', activeSessionId: 'new' }));
  await waitFor(() => expect(location.history?.at(-1)).toBe('/studio'));
  const messages = calls.mock.calls.filter(([path]) => path.endsWith('/messages'));
  expect(messages).toHaveLength(1);
  expect(messages[0][0]).toBe('/api/studio/agent/sessions/new/messages');
});

it('能力探测结束后在当前页面移除不能调用工具的对话模型', async () => {
  updateStudioView({ inputMode: 'agent' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  let finish!: (response: Response) => void;
  const verified = new Promise<Response>(resolve => { finish = resolve; });
  const requests = vi.fn(async (path: string) => {
    if (path.endsWith('/models?wait=true')) return verified;
    if (path.endsWith('/agent/models')) return Response.json({ refresh_pending: true,
      models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] });
    return Response.json({ skills: [], sessions: [], models: [] });
  });
  vi.stubGlobal('fetch', requests);
  render(<Page home />);
  typeAgent('试一下');
  await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled());
  await act(async () => { finish(Response.json({ models: [], errors: [], refresh_pending: false })); });
  await waitFor(() => expect(screen.getByLabelText('发送')).toBeDisabled());
  expect(screen.queryByText('Chat')).toBeNull();
  expect(requests.mock.calls.filter(([path]) => path.includes('/agent/models'))).toHaveLength(2);
});

it('恢复目标会话时等待列表，即使已拿到模型也不会向新会话发送', async () => {
  updateStudioView({ inputMode: 'agent', activeSessionId: 'previous' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  let restore!: (response: Response) => void;
  const sessions = new Promise<Response>(resolve => { restore = resolve; });
  const requests = vi.fn(async (path: string) => {
    if (path.endsWith('/sessions')) return sessions;
    if (path.endsWith('/models')) return new Response(JSON.stringify({ models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] }));
    if (path.endsWith('/previous')) return new Response(JSON.stringify({ session_id: 'previous', model: 'chat', model_alias: 'fake',
      permission_mode: 'review', turns: [], messages: [], pending_approvals: [], revision: 1, status: 'idle' }));
    return new Response(JSON.stringify({ skills: [], models: [] }));
  });
  vi.stubGlobal('fetch', requests);
  render(<Page />);
  typeAgent('继续修改');
  await screen.findByText('Chat');
  expect(screen.getByLabelText('发送')).toBeDisabled();
  restore(new Response(JSON.stringify({ sessions: [{ session_id: 'previous' }] })));
  await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled());
  expect(requests.mock.calls.filter(([path]) => path.endsWith('/messages'))).toHaveLength(0);
});

it('Agent 参考图片复用图片堆叠和引用编号', () => {
  updateStudioView({ inputMode: 'agent' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [], sessions: [], models: [] }))));
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  render(<Page />);
  const files = Array.from({ length: 17 }, (_, i) => new File(['x'], `图${i}.png`, { type: 'image/png' }));
  const input = document.querySelector('input[accept="image/*"]')!;
  fireEvent.change(input, { target: { files: [new File([], 'v.mp4', { type: 'video/mp4' }), ...files] } });
  typeAgent('使用 @图2');
  expect(screen.getByRole('textbox')).toHaveTextContent('使用 @图2');
  expect(new Set(vi.mocked(URL.createObjectURL).mock.calls.map(([file]) => (file as File).name))).toEqual(new Set(files.slice(0, 16).map(file => file.name)));
  expect(screen.queryByLabelText('引用资产')).toBeNull();
});

it('首页 Agent 输入栏只保留模式、对话模型、出图模型和技能', () => {
  updateStudioView({ inputMode: 'agent' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [], sessions: [], models: [], errors: [] }))));
  render(<Page home />);
  const track = screen.getByLabelText('选择生成模式').parentElement!.parentElement!;
  expect(Array.from(track.querySelectorAll('button')).map(btn => btn.getAttribute('aria-label') ?? btn.textContent))
    .toEqual(['选择生成模式', '选择模型', '模型偏好', '选择 Skill', '打开创作资产']);
  expect(screen.queryByLabelText('创作模式')).toBeNull();
  expect(screen.queryByLabelText(/权限模式/)).toBeNull();
});
