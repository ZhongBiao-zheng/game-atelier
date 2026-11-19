import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { hoverHint } from '@/test/hint';

import { AgentSection } from './AgentSection';

const CLIENTS = [
  { id: 'claude-code', mode: 'copy', path: null, written: false, snippet: 'claude mcp add -s user atelier -- /py -m character_workflow.mcp --client claude-code', warning: null },
  { id: 'codex', mode: 'write', path: '/custom/codex/config.toml', written: false, snippet: '[mcp_servers.game-atelier]', warning: null },
  { id: 'cursor', mode: 'write', path: '/home/biao/.cursor/mcp.json', written: false, snippet: '{"mcpServers":{}}', warning: null },
  { id: 'claude-desktop', mode: 'write', path: '/home/Claude/claude_desktop_config.json', written: true, snippet: '{}', warning: null },
  { id: 'trae', mode: 'copy', path: null, written: false, snippet: '{"mcpServers":{"atelier":{}}}', warning: '安装路径含空格，TRAE 无法启动' },
  { id: 'workbuddy', mode: 'copy', path: null, written: false, snippet: '{}', warning: null },
];

function server(initial: { enabled: boolean; connections: Record<string, string> }, failEnable = false) {
  let state = { ...initial, credential_path: '/data/connections/agent.json', clients: CLIENTS, tools: [{ name: 'canvas_list_projects', billable: false }, { name: 'canvas_run', billable: true }] };
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/connection/agent/client-config') {
      const { client } = JSON.parse(String(init?.body)) as { client: string };
      state = { ...state, clients: state.clients.map(row => row.id === client ? { ...row, written: true } : row) };
      return new Response(JSON.stringify(state));
    }
    expect(url).toBe('/api/connection/agent');
    if (init?.method === 'PUT') {
      if (failEnable) {
        state = { ...state, enabled: true };
        return new Response(JSON.stringify({ error: { code: 'CODEX_CONFIG_INVALID', message: '无法读取 config.toml' } }), { status: 500 });
      }
      state = { ...state, enabled: true };
    }
    if (init?.method === 'DELETE') state = { ...state, enabled: false, connections: {} };
    return new Response(JSON.stringify(state));
  });
  vi.stubGlobal('fetch', network); return network;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('Agent connection setting', () => {
  it('turns on with one switch and waits for an agent', async () => {
    const network = server({ enabled: false, connections: {} });
    render(<AgentSection />);
    const toggle = await screen.findByRole('switch', { name: '允许 Agent 操作本机' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('关闭后');
    expect(screen.queryByRole('region', { name: '可用工具' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('0 个已连接');
    expect(screen.getAllByText('等待连接')).toHaveLength(6);
    expect(network.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
  });

  it('shows connected hosts and turns off', async () => {
    const network = server({ enabled: true, connections: { codex: '2026-10-14T06:35:00Z' } });
    render(<AgentSection />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 个已连接'));
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByText(/已连接 ·/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '允许 Agent 操作本机' }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('reports a Codex config failure and follows the server state', async () => {
    server({ enabled: false, connections: {} }, true);
    render(<AgentSection />);
    const toggle = await screen.findByRole('switch', { name: '允许 Agent 操作本机' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('config.toml');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows an error instead of crashing when the server returns another shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))));
    render(<AgentSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('返回格式不对');
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

it('writes a client config with one click and copies the snippet', async () => {
  const network = server({ enabled: true, connections: {} });
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<AgentSection />);
  const cursor = await screen.findByRole('region', { name: 'Cursor' });
  expect(within(cursor).getByText('~/.cursor/')).toBeInTheDocument();
  expect(within(cursor).getByText('mcp.json')).toBeInTheDocument();
  fireEvent.click(within(cursor).getByRole('button', { name: '写入配置' }));
  // 写入后是状态文字，不再是按钮。
  await waitFor(() => expect(within(cursor).getByText('已写入')).toBeInTheDocument());
  expect(within(cursor).queryByRole('button', { name: /写入/ })).not.toBeInTheDocument();
  expect(network.mock.calls.some(([url]) => url === '/api/connection/agent/client-config')).toBe(true);
  const trae = screen.getByRole('region', { name: 'TRAE' });
  expect(within(trae).queryByRole('button', { name: '写入配置' })).not.toBeInTheDocument();
  expect(within(trae).getByRole('note')).toHaveTextContent('安装路径含空格，TRAE 无法启动');
  expect(within(screen.getByRole('region', { name: 'WorkBuddy' })).getByText('粘贴到 连接器 › 自定义连接器')).toBeInTheDocument();
  fireEvent.click(within(trae).getByRole('button', { name: '复制配置' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"mcpServers":{"atelier":{}}}'));
  expect(await within(trae).findByRole('button', { name: '已复制' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Claude Code' })).getByRole('button', { name: '复制命令' })).toBeInTheDocument();
});

it('使用服务端路径与工具列表，标注计费工具并保留授权文案', async () => {
  server({ enabled: true, connections: {} });
  render(<AgentSection />);
  expect(await screen.findByText('/custom/codex/')).toBeInTheDocument();
  expect(screen.getByText('config.toml')).toBeInTheDocument();
  const toggle = screen.getByRole('button', { name: /可用工具/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('canvas_run')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(await hoverHint(screen.getByText('canvas_run').parentElement!)).toHaveTextContent('计费工具');
  expect(screen.getByText('计费工具需先获得你的授权')).toBeInTheDocument();
  expect(screen.getByText('canvas_list_projects')).toBeInTheDocument();
});

it('shortens config paths to ~ and keeps the file name whole', async () => {
  const { shortPath } = await import('./AgentClientCard');
  expect(shortPath('/Users/biao/.codex/config.toml')).toEqual({ dir: '~/.codex/', name: 'config.toml' });
  expect(shortPath('C:\\Users\\biao\\.cursor\\mcp.json')).toEqual({ dir: '~\\.cursor\\', name: 'mcp.json' });
  expect(shortPath('/opt/atelier/config.toml')).toEqual({ dir: '/opt/atelier/', name: 'config.toml' });
});
