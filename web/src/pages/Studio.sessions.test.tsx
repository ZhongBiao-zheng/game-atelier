import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Studio } from './Studio';
import * as connection from '@/api/connection';
import { createTestEventStream } from '@/test/eventStream';
import { clearStudioDraft, DEFAULT_STUDIO_SESSION_ID, readStudioView, updateStudioView } from './studioDraft';

const base = '/api/studio/agent/sessions';
const ordinary = 'session-mixed-studio';
const created = 'session-first-submit';

function session(id: string, title: string, running = false) {
  const mixed = id === ordinary;
  return { session_id: id, title, revision: 1, status: running ? 'running' : 'idle', created_at: '2026-01-01',
    model: 'chat', model_alias: 'local', pending_approvals: [], permission_mode: 'auto',
    turns: mixed ? [{ turn_id: 'turn-art', status: running ? 'running' : 'idle', attachment_ids: [], asset_ids: [], steps: [] }] : [],
    messages: mixed ? ['配个背景', '适合松绿\n→ 再试落日'].map((text, i) => ({
      role: i ? 'assistant' : 'user', created_at: new Date(Date.now() - 60000).toISOString(), text, message_id: 'm' + i, turn_id: 'turn-art',
    })) : [],
  };
}

function job(id: string, prompt: string, sid?: string, turn?: string) {
  return { job_id: id, kind: 'image', namespace: 'studio', status: 'done', prompt, model: 'gpt-image-2', alias: 'local',
    submitted_at: '2025-01-02T00:00:00Z', params: {}, output_paths: ['studio/' + id + '/v1.png'],
    studio_agent_session_id: sid, studio_agent_turn_id: turn };
}

function server(running = false) {
  const sessions = [session(DEFAULT_STUDIO_SESSION_ID, '默认会话'), session(ordinary, '山色', running)];
  let finish!: () => void;
  const post = new Promise<void>(resolve => { finish = resolve; });
  const requests = vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown = {};
    if (url === base && init?.method === 'POST') {
      const next = session(created, JSON.parse(String(init.body)).title);
      sessions.push(next);
      data = next;
    } else if (url === base) data = { sessions };
    else if (url === base + '/' + ordinary + '/jobs') data = { jobs: [
      job('manual', '第一幅草图', ordinary), job('art', '林间版画', ordinary, 'turn-art'),
    ] };
    else if (url === base + '/' + DEFAULT_STUDIO_SESSION_ID + '/jobs') data = { jobs: [job('legacy', '无归属字段的旧图')] };
    else if (url.endsWith('/jobs') && url.startsWith(base)) data = { jobs: [] };
    else if (sessions.some(item => url === base + '/' + item.session_id)) data = sessions.find(item => url.endsWith(item.session_id));
    else if (url.endsWith('/cancel')) data = session(ordinary, '山色');
    else if (url.endsWith('/usage')) data = { requests: 0 };
    else if (url.endsWith('/keys')) data = { keys: [{ alias: 'local', provider: 'openai', models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }] }] };
    else if (url.endsWith('/agent/models')) data = { models: [{ alias: 'local', model: 'chat', name: 'Chat' }], errors: [] };
    else if (url.endsWith('/models') || url.endsWith('/generation-models')) data = { models: [] };
    else if (url.endsWith('/skills')) data = { skills: [] };
    else if (url.endsWith('/favorites')) data = { paths: ['studio/art/v1.png'] };
    else if (url.endsWith('/hidden')) data = { paths: [] };
    else if (url === '/api/studio/jobs') {
      await post;
      const body = JSON.parse(String(init?.body));
      data = { ...job('new', body.prompt, body.studio_agent_session_id), status: 'pending', submitted_at: new Date().toISOString(), output_paths: [] };
    }
    return new Response(JSON.stringify(data));
  });
  vi.stubGlobal('fetch', requests);
  return { requests, finish };
}

function mount(compact = false) {
  const loc = memoryLocation({ path: compact ? '/' : '/studio', record: true });
  render(<Router hook={loc.hook}><Studio compact={compact} /></Router>);
  return loc;
}
function enter(text: string) {
  const el = screen.getByRole('textbox', { name: '生图 prompt' });
  el.textContent = text;
  fireEvent.input(el);
}
function choose(mode: string) {
  fireEvent.click(screen.getByLabelText('选择生成模式'));
  fireEvent.click(screen.getByRole('option', { name: mode }));
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); clearStudioDraft(); });
afterEach(() => vi.unstubAllGlobals());

it('切换会话隔离历史；列表固定默认项，标出运行并可在统一输入框停止', async () => {
  const { requests } = server(true);
  mount();
  expect(await screen.findByText('无归属字段的旧图')).toBeVisible();
  fireEvent.click(screen.getByLabelText('切换对话'));
  const menu = within(screen.getByLabelText('对话列表'));
  expect(menu.getAllByRole('button').slice(0, 2).map(b => b.textContent)).toEqual(['新建对话', '默认会话']);
  expect(menu.queryByLabelText('删除对话 默认会话')).toBeNull();
  expect(menu.getByLabelText('运行中')).toBeVisible();
  fireEvent.click(menu.getByText('山色'));
  expect(await screen.findByText('配个背景')).toBeVisible();
  expect(screen.queryByText('无归属字段的旧图')).toBeNull();
  choose('Agent');
  fireEvent.click(await screen.findByRole('button', { name: '停止' }));
  expect(await screen.findByRole('button', { name: '发送' })).toBeVisible();
  expect(requests.mock.calls.some(([url]) => url === base + '/' + ordinary + '/cancel')).toBe(true);
});

it('手动与 Agent 按提交时间混排；搜索、追问回填和乐观手动轮次共享时间线', async () => {
  const { finish } = server();
  updateStudioView({ activeSessionId: ordinary });
  mount();
  const suggestion = await screen.findByRole('button', { name: '再试落日' });
  expect(screen.getByText('第一幅草图').compareDocumentPosition(screen.getByText('配个背景')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByLabelText('搜索'));
  const search = screen.getByLabelText('按提示词搜索出图记录');
  fireEvent.change(search, { target: { value: '松绿' } });
  expect(screen.getByText('配个背景')).toBeVisible();
  expect(screen.queryByText('第一幅草图')).toBeNull();
  expect(suggestion).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '再试落日' }));
  expect(screen.getByLabelText('Agent 消息')).toHaveTextContent('再试落日');
  expect(screen.getByLabelText('Agent 消息')).toHaveFocus();
  choose('图片');
  enter('等待提交的手动轮次');
  fireEvent.click(screen.getByLabelText('提交生成'));
  expect(await screen.findByText('等待提交的手动轮次')).toBeVisible();
  expect(screen.queryByText('继续探索')).toBeNull();
  await act(async () => finish());
  expect(screen.queryByText('继续探索')).toBeNull();
});

it('空草稿首次手动生成先用提示词前 40 字建会话，随后携带 ID 发任务', async () => {
  const { requests, finish } = server();
  mount();
  await screen.findByText('无归属字段的旧图');
  fireEvent.click(screen.getByLabelText('新建对话'));
  expect(screen.getByText('今天想一起创作什么？')).toBeVisible();
  const posts = () => requests.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts().some(([url]) => url === base)).toBe(false);
  enter('山🌄'.repeat(25));
  fireEvent.click(screen.getByLabelText('提交生成'));
  await waitFor(() => expect(posts().map(([url]) => url)).toEqual([base, '/api/studio/jobs']));
  expect(JSON.parse(String(posts()[0][1]?.body)).title).toBe('山🌄'.repeat(20));
  expect(JSON.parse(String(posts()[1][1]?.body)).studio_agent_session_id).toBe(created);
  await act(async () => finish());
});

it('从首页手动提交后返回默认会话', async () => {
  const { requests, finish } = server();
  updateStudioView({ activeSessionId: ordinary });
  const loc = mount(true);
  enter('首页参考图');
  await waitFor(() => expect(screen.getByLabelText('提交生成')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('提交生成'));
  await act(async () => finish());
  const call = requests.mock.calls.find(([url]) => url === '/api/studio/jobs');
  expect(JSON.parse(String(call?.[1]?.body)).studio_agent_session_id).toBe(DEFAULT_STUDIO_SESSION_ID);
  expect(readStudioView().activeSessionId).toBe(DEFAULT_STUDIO_SESSION_ID);
  expect(loc.history?.at(-1)).toBe('/studio');
});

it('时间、生成模式、喜欢和任务提示词均以整轮为筛选单位', async () => {
  server();
  updateStudioView({ activeSessionId: ordinary });
  mount();
  await screen.findByText('继续探索');
  const turn = () => screen.queryByText('配个背景');
  const manual = () => screen.queryByText('第一幅草图');
  const toggle = (label: string) => fireEvent.click(screen.getByLabelText(label, { exact: true }));
  const pick = (label: string) => fireEvent.click(screen.getByRole('option', { name: label }));
  toggle('时间筛选');
  pick('最近一周');
  expect(turn()).toBeVisible();
  expect(manual()).toBeNull();
  pick('全部');
  toggle('时间筛选');
  toggle('生成模式筛选');
  pick('图片');
  expect(turn()).toBeNull();
  expect(manual()).toBeVisible();
  pick('Agent');
  expect(turn()).toBeVisible();
  expect(manual()).toBeVisible();
  pick('图片');
  pick('Agent');
  toggle('生成模式筛选');
  toggle('操作类型筛选');
  pick('喜欢');
  expect(turn()).toBeVisible();
  expect(manual()).toBeNull();
  expect(screen.queryByText('继续探索')).toBeNull();
  pick('喜欢');
  toggle('操作类型筛选');
  toggle('搜索');
  fireEvent.change(screen.getByLabelText('按提示词搜索出图记录'), { target: { value: '林间版画' } });
  expect(turn()).toBeVisible();
  expect(manual()).toBeNull();
});

it('旧会话的慢响应不能替换已切换到的会话任务', async () => {
  const { requests } = server();
  const respond = requests.getMockImplementation()!;
  let resolveOld!: (response: Response) => void;
  const slow = new Promise<Response>(resolve => { resolveOld = resolve; });
  requests.mockImplementation((url, init) => url === base + '/' + DEFAULT_STUDIO_SESSION_ID + '/jobs' ? slow : respond(url, init));
  mount();
  fireEvent.click(await screen.findByLabelText('切换对话'));
  fireEvent.click(await screen.findByRole('button', { name: '山色' }));
  expect(await screen.findByText('第一幅草图')).toBeVisible();
  await act(async () => resolveOld(new Response(JSON.stringify({ jobs: [job('late', '旧会话慢响应')] }))));
  expect(screen.queryByText('旧会话慢响应')).toBeNull();
  expect(screen.getByText('第一幅草图')).toBeVisible();
});

it('滚动时保留实际输入焦点，已卸载的弹窗焦点不会持续撑开输入壳', async () => {
  server();
  mount();
  await screen.findByText('无归属字段的旧图');
  const scroll = screen.getByTestId('studio-history-scroll');
  const editor = screen.getByLabelText('生图 prompt');
  const shell = screen.getByTestId('studio-prompt-shell');
  scroll.scrollTop = -200;
  act(() => editor.focus());
  fireEvent.scroll(scroll);
  expect(shell).toHaveClass('min-h-[174px]');
  act(() => editor.blur());
  // 临时按钮代表随弹窗卸载的焦点目标，移除 DOM 节点不会触发 React 的 blur。
  const temporaryButton = document.createElement('button');
  shell.appendChild(temporaryButton);
  act(() => temporaryButton.focus());
  temporaryButton.remove();
  expect(document.activeElement).toBe(document.body);
  fireEvent.scroll(scroll);
  expect(shell).toHaveClass('min-h-0');
});

it('首屏与切换各拉一次任务，普通会话更新不拉；生成完成与 SSE 重连补查', async () => {
  const ready = { phase: 'ready' as const, generation: 1, editing: true, message: null };
  const state = vi.spyOn(connection, 'useConnectionState').mockReturnValue(ready);
  try {
    const { requests } = server();
    const events = createTestEventStream();
    const respond = requests.getMockImplementation()!;
    let revision = 1;
    let completed = 1;
    requests.mockImplementation(async (url, init) => {
      if (url === '/events') return events.open();
      const response = await respond(url, init);
      if (url !== base + '/' + ordinary) return response;
      const details = await response.json();
      details.revision = revision;
      details.turns[0].steps = Array.from({ length: completed }, (_, i) => ({
        step_id: 'gen-' + i, tool: 'run_generations', summary: '提交生成', status: 'completed',
      }));
      return Response.json(details);
    });
    const count = (id: string) => requests.mock.calls.filter(([url]) => url === base + '/' + id + '/jobs').length;
    mount();
    await screen.findByText('无归属字段的旧图');
    await act(async () => {});
    expect(count(DEFAULT_STUDIO_SESSION_ID)).toBe(1);
    fireEvent.click(screen.getByLabelText('切换对话'));
    fireEvent.click(await screen.findByRole('button', { name: '山色' }));
    await screen.findByText('配个背景');
    expect(count(ordinary)).toBe(1);

    const update = () => act(async () => events.emit('studio-agent', { kind: 'session', session_id: ordinary }));
    revision++;
    await update();
    expect(count(ordinary)).toBe(1);
    revision++;
    completed++;
    await update();
    expect(count(ordinary)).toBe(2);

    ready.generation++;
    // Studio itself rerenders on a session update and reconnects to the new generation.
    await update();
    await waitFor(() => expect(count(ordinary)).toBe(3));
    expect(count(DEFAULT_STUDIO_SESSION_ID)).toBe(1);
  } finally {
    state.mockRestore();
  }
});
