import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentSection } from './AgentSection';

function server(initial: { enabled: boolean; connections: Record<string, string> }, failEnable = false) {
  let state = initial;
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/connection/agent');
    if (init?.method === 'PUT') {
      if (failEnable) {
        state = { ...state, enabled: true };
        return new Response(JSON.stringify({ error: { code: 'CODEX_CONFIG_INVALID', message: '无法读取 config.toml' } }), { status: 500 });
      }
      state = { ...state, enabled: true };
    }
    if (init?.method === 'DELETE') state = { enabled: false, connections: {} };
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
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('等待 Agent 连接');
    expect(network.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
  });

  it('shows connected hosts and turns off', async () => {
    const network = server({ enabled: true, connections: { codex: '2026-10-14T06:35:00Z' } });
    render(<AgentSection />);
    expect(await screen.findByRole('status')).toHaveTextContent(/已连接 · Codex/);
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
