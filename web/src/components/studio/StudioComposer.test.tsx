import { beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { StudioComposer, useStudioComposer } from './StudioComposer';
import { readStudioView, updateStudioView } from '@/pages/studioDraft';

function Page({ home = false }: { home?: boolean }) {
  const state = useStudioComposer(home);
  return <StudioComposer state={state}><span>生成参数</span></StudioComposer>;
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

it('默认显示创作输入，Agent 隐藏生成参数，刷新恢复输入模式', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const first = render(<Page />);
  expect(screen.getByText('生成参数')).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
  expect(screen.queryByText('生成参数')).toBeNull();
  expect(screen.getByRole('button', { name: '创作设置' })).toBeVisible();
  fireEvent.change(screen.getByPlaceholderText('输入想法或上传参考，和 Agent 一起创作'), { target: { value: '未发送的草稿' } });
  fireEvent.click(screen.getByRole('radio', { name: '创作' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
  expect(screen.getByPlaceholderText('输入想法或上传参考，和 Agent 一起创作')).toHaveValue('未发送的草稿');
  first.unmount();
  render(<Page />);
  expect(screen.getByPlaceholderText('输入想法或上传参考，和 Agent 一起创作')).toBeVisible();
});

it('首页只在发送时新建会话，收件后跳到创作台并恢复同一会话', async () => {
  updateStudioView({ mode: 'agent', activeSessionId: 'old' });
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
  expect(screen.getByText('生成参数')).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
  fireEvent.change(screen.getByPlaceholderText('输入想法或上传参考，和 Agent 一起创作'), { target: { value: '设计灯笼' } });
  await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('发送'));
  await waitFor(() => expect(readStudioView()).toEqual({ mode: 'agent', activeSessionId: 'new' }));
  await waitFor(() => expect(location.history?.at(-1)).toBe('/studio'));
  const messages = calls.mock.calls.filter(([path]) => path.endsWith('/messages'));
  expect(messages).toHaveLength(1);
  expect(messages[0][0]).toBe('/api/studio/agent/sessions/new/messages');
});
