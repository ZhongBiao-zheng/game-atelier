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

it('新用户默认 Agent，三种模式共用输入壳，保留 Agent 草稿并在刷新时恢复手动切换的模式', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [], skills: [], models: [] }))));
  const first = render(<Page />);
  expect(screen.getByLabelText('选择生成模式')).toHaveTextContent('Agent');
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
  pickMode('图片');
  first.unmount();
  render(<Page />);
  expect(screen.getByLabelText('选择生成模式')).toHaveTextContent('图片');
});

it('首页只在发送时新建会话，收件后跳到创作台并恢复同一会话', async () => {
  updateStudioView({ inputMode: 'agent', activeSessionId: 'old' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  const created = { session_id: 'new', revision: 1, status: 'idle', model: 'chat', model_alias: 'fake',
    title: '新对话', pending_approvals: [], turns: [], messages: [] };
  const preferences = { auto_models: true, preferred_models: [{ alias: 'art', model: 'image-model' }] };
  const calls = vi.fn(async (path: string, init?: RequestInit) => {
    let result: unknown = {};
    if (path.endsWith('/models')) result = { models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] };
    if (path.endsWith('/skills')) result = { skills: [] };
    if (path.endsWith('/sessions')) result = init?.method === 'POST' ? created : { sessions: [{ session_id: 'old' }] };
    if (path.endsWith('/sessions/old')) result = { ...created, session_id: 'old', ...preferences };
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
  const creates = calls.mock.calls.filter(([path, init]) => path.endsWith('/sessions') && init?.method === 'POST');
  expect(creates).toHaveLength(1);
  expect(JSON.parse(String(creates[0][1]?.body))).toMatchObject(preferences);
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

it('首页与创作台共用当前对话的生成偏好，切页或刷新保留自动与手选名单', async () => {
  const target = '/api/studio/agent/sessions/current';
  const manual = { alias: 'fake', model: 'art' };
  let active = { session_id: 'current', revision: 1, title: '当前对话', status: 'idle',
    model_alias: 'fake', model: 'chat', auto_models: false, preferred_models: [manual],
    creation_mode: 'all', permission_mode: 'auto', pending_approvals: [], turns: [], messages: [] };
  updateStudioView({ inputMode: 'agent', activeSessionId: 'current' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  let release!: () => void;
  const firstSave = new Promise<void>(resolve => { release = resolve; });
  const writes: unknown[] = [];
  const requests = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === target && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      writes.push(patch);
      if (writes.length === 1) await firstSave;
      active = { ...active, ...patch, revision: active.revision + 1 };
      return Response.json(active);
    }
    if (path === target) return Response.json(active);
    if (path.endsWith('/sessions')) return Response.json({ sessions: [active, { session_id: 'other' }] });
    if (path.endsWith('/generation-models')) return Response.json({ models: [
      { ...manual, kind: 'image', name: '手选模型', provider: 'openai' },
      { alias: 'fake', model: 'other-art', kind: 'image', name: '另一模型', provider: 'openai' },
    ] });
    if (path.endsWith('/agent/models')) return Response.json({ models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] });
    return Response.json({ skills: [], models: [] });
  });
  vi.stubGlobal('fetch', requests);
  async function openPreferences() {
    const button = screen.getByRole('button', { name: '模型偏好' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    return screen.getByRole('switch', { name: '自动选择模型' });
  }
  const home = render(<Page home />);
  expect(await openPreferences()).not.toBeChecked();
  expect(screen.getByRole('option', { name: /手选模型/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(writes).toEqual([{ auto_models: true }]));
  expect(screen.getByRole('switch')).toBeChecked();
  home.unmount();
  const studio = render(<Page />);
  await act(async () => { release(); });
  expect(await openPreferences()).toBeChecked();
  expect(screen.queryByText(/模型偏好里没选/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
  expect(screen.getByRole('option', { name: /手选模型/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('option', { name: /另一模型/ }));
  await waitFor(() => expect(active.preferred_models).toEqual([manual, { alias: 'fake', model: 'other-art' }]));
  studio.unmount();
  const refreshed = render(<Page home />);
  expect(await openPreferences()).not.toBeChecked();
  expect(screen.getByRole('option', { name: /另一模型/ })).toHaveAttribute('aria-selected', 'true');
  refreshed.unmount();
  render(<Page />);
  expect(await openPreferences()).not.toBeChecked();
  expect(screen.getByRole('option', { name: /手选模型/ })).toHaveAttribute('aria-selected', 'true');
  expect(requests.mock.calls.filter(([, init]) => init?.method === 'PATCH').every(([path]) => path === target)).toBe(true);
  expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each([
  { status: 'running', errorCode: 'SESSION_BUSY', httpStatus: 409, usesDraft: true },
  { status: 'awaiting_approval', errorCode: 'SESSION_BUSY', httpStatus: 409, usesDraft: true },
  { status: 'idle', errorCode: 'UNAVAILABLE', httpStatus: 503, usesDraft: false },
])('首页修改偏好时处理 $status 的 $errorCode', async ({ status, errorCode, httpStatus, usesDraft }) => {
  updateStudioView({ inputMode: 'agent', activeSessionId: 'old' });
  localStorage.setItem('canvas-agent-model', JSON.stringify({ alias: 'fake', model: 'chat' }));
  const old = { session_id: 'old', revision: 4, status, title: '旧对话', model_alias: 'fake', model: 'chat',
    auto_models: false, preferred_models: [{ alias: 'images', model: 'art' }], turns: [], messages: [], pending_approvals: [] };
  let respond!: () => void;
  const reply = new Promise<void>(resolve => { respond = resolve; });
  const calls = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/old') && init?.method === 'PATCH') {
      await reply;
      return Response.json({ error: { code: errorCode, message: '测试错误' } }, { status: httpStatus });
    }
    if (path.endsWith('/old')) return Response.json(old);
    if (path.endsWith('/sessions')) return Response.json({ sessions: [old] });
    if (path.endsWith('/agent/models')) return Response.json({ models: [{ alias: 'fake', model: 'chat', name: 'Chat' }], errors: [] });
    return Response.json({ skills: [], models: [] });
  });
  vi.stubGlobal('fetch', calls);
  const home = render(<Page home />);
  const picker = () => screen.getByRole('button', { name: '模型偏好' });
  await waitFor(() => expect(picker()).toBeEnabled());
  fireEvent.click(picker());
  const toggle = screen.getByRole('switch', { name: '自动选择模型' });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(calls.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  if (usesDraft) {
    home.unmount();
    render(<Page />);
    await act(async () => { respond(); });
    await waitFor(() => expect(readStudioView().activeSessionId).toBeNull());
    await waitFor(() => expect(picker()).toBeEnabled());
    fireEvent.click(picker());
    expect(screen.getByRole('switch')).toBeChecked();
    expect(JSON.parse(localStorage.getItem('canvas-agent-creation')!)).toMatchObject({
      auto_models: true, preferred_models: old.preferred_models,
    });
  } else {
    await act(async () => { respond(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('测试错误');
    expect(readStudioView().activeSessionId).toBe('old');
    expect(toggle).not.toBeChecked();
  }
  expect(calls.mock.calls.some(([,init]) => init?.method === 'POST')).toBe(false);
});
