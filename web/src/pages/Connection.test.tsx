import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionPage } from './Connection';

const grant = { grant_id: 'g1', name: 'Codex 角色助手', project_ids: ['p1'], capabilities: ['read'], expires_at: '2099-01-01T00:00:00Z', credential_path: '/private/credentials/g1.json' };
function server(existing = false) {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects') return new Response(JSON.stringify({ projects: [{ id: 'p1', name: '测试项目' }], assignments: {} }));
    if (url === '/api/canvas/project-options') return new Response(JSON.stringify([{ project_id: 'canvas-one', name: '测试画布' }]));
    if (url === '/api/connection/agent-grants' && init?.method === 'POST') return new Response(JSON.stringify(grant));
    if (url === '/api/connection/agent-grants/g1') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ grants: existing ? [grant] : [], python: '/opt/venv/bin/python' }));
  });
  vi.stubGlobal('fetch', network); return network;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('local Agent authorization UI', () => {
  it('connects with one click using every project, canvas and capability', async () => {
    const network = server(); render(<ConnectionPage />);
    const connect = await screen.findByRole('button', { name: '连接本机 Agent' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect); await screen.findByText(new RegExp(grant.credential_path));
    const call = network.mock.calls.find(([url, init]) => url.endsWith('agent-grants') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: '本机 Agent', project_ids: ['p1'], canvas_project_ids: ['canvas-one'], capabilities: ['read', 'edit_documents', 'create_targets', 'prepare_generation', 'execute_generation', 'canvas_read', 'canvas_edit', 'canvas_generate'], days: 30 });
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });
  it('lets the user narrow scope and capabilities through the custom form', async () => {
    const network = server(); render(<ConnectionPage />);
    await screen.findByRole('button', { name: '连接本机 Agent' });
    fireEvent.click(screen.getByRole('button', { name: '自定义' }));
    const create = screen.getByRole('button', { name: '创建授权' }); expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: grant.name } });
    fireEvent.click(await screen.findByLabelText('测试画布'));
    fireEvent.click(screen.getByLabelText('直接执行生成（终端确认即批准，不经页面）'));
    fireEvent.click(create); await screen.findByText(new RegExp(grant.credential_path));
    const call = network.mock.calls.find(([url, init]) => url.endsWith('agent-grants') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: grant.name, project_ids: ['p1'], canvas_project_ids: [], capabilities: ['read', 'edit_documents', 'create_targets', 'prepare_generation', 'canvas_read', 'canvas_edit', 'canvas_generate'], days: 30 });
  });
  it('copies the registration command with interpreter and credential path, revokes only after confirmation', async () => {
    const network = server(true); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConnectionPage />); await screen.findByText(grant.name);
    fireEvent.click(screen.getByRole('button', { name: `复制 ${grant.name} 注册命令` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`claude mcp add --transport stdio --scope local game-atelier -- /opt/venv/bin/python -m character_workflow.mcp --credentials ${grant.credential_path}`));
    fireEvent.click(screen.getByRole('button', { name: `撤销 ${grant.name}` }));
    expect(network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: `撤销 ${grant.name}` }));
    await waitFor(() => expect(screen.queryByText(grant.name)).not.toBeInTheDocument());
  });
});

describe('site pairing UI', () => {
  const pairing = { pairing_code: 'PAIR-CODE-123456789012', origin: 'https://atelier.example', expires_at: '2099-01-01T00:05:00Z', instance_id: 'i1' };
  const siteSession = { session_id: 'site-1', kind: 'site', name: 'https://atelier.example', origin: 'https://atelier.example', expires_at: '2099-01-01T12:00:00Z' };
  function siteServer() {
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/connection/pairings') return new Response(JSON.stringify(pairing), { status: 201 });
      if (url === '/api/connection/sessions') return new Response(JSON.stringify({ sessions: [siteSession, { ...siteSession, session_id: 'local-1', kind: 'local', origin: null, name: '本地页面' }] }));
      if (url === '/api/connection/sessions/site-1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url === '/api/projects') return new Response(JSON.stringify({ projects: [], assignments: {} }));
      if (url === '/api/canvas/project-options') return new Response(JSON.stringify([]));
      return new Response(JSON.stringify({ grants: [], python: '/opt/venv/bin/python' }));
    });
    vi.stubGlobal('fetch', network); return network;
  }
  afterEach(() => { window.history.replaceState({}, '', '/'); });

  it('prefills the site origin from the link, generates a one-time code and lists only site sessions', async () => {
    window.history.replaceState({}, '', '/connection?site=https%3A%2F%2Fatelier.example');
    const network = siteServer(); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ConnectionPage />);
    expect(await screen.findByLabelText('网站地址')).toHaveValue('https://atelier.example');
    const list = await screen.findByRole('list', { name: '已连接的网站' });
    expect(list).toHaveTextContent('https://atelier.example'); expect(list).not.toHaveTextContent('本地页面');
    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }));
    expect(await screen.findByLabelText('配对码')).toHaveTextContent(pairing.pairing_code);
    const call = network.mock.calls.find(([url, init]) => url === '/api/connection/pairings' && init?.method === 'POST')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ origin: 'https://atelier.example' });
    fireEvent.click(screen.getByRole('button', { name: '复制配对码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(pairing.pairing_code));
    fireEvent.click(screen.getByRole('button', { name: '断开 https://atelier.example' }));
    await waitFor(() => expect(network.mock.calls.some(([url, init]) => url === '/api/connection/sessions/site-1' && init?.method === 'DELETE')).toBe(true));
  });
});
