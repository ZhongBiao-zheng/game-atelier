import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { hoverHint } from '@/test/hint';

import lockFixture from '../../../../plugins/sprite-sheet/package/manifest.lock.json';
import type { PluginEntry } from '@/schema/plugins';
import { PluginsPage } from './PluginsPage';

const manifest = lockFixture as unknown as NonNullable<PluginEntry['manifest']>;
const sprite = (patch: Partial<PluginEntry> = {}): PluginEntry => ({
  id: 'sprite-sheet', availability: 'ok', reason: null, enabled: false,
  manifest: { ...manifest, app_version: { min: manifest.app_version.min, max: null } }, ...patch,
});

function server(initial: PluginEntry[], fail?: { status: number; detail: unknown }) {
  let plugins = initial;
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    const action = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(url);
    if (action && init?.method === 'POST') {
      if (fail) return new Response(JSON.stringify({ detail: fail.detail }), { status: fail.status });
      plugins = plugins.map(item => item.id === action[1] ? { ...item, enabled: action[2] === 'enable' } : item);
    } else {
      expect(url).toBe('/api/plugins');
    }
    return new Response(JSON.stringify({ app_version: '5.137.0', plugins }));
  });
  vi.stubGlobal('fetch', network);
  return network;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('设置页「插件」', () => {
  it('列出插件并用开关启停', async () => {
    const network = server([sprite()]);
    render(<PluginsPage />);
    const row = within(await screen.findByRole('list', { name: '插件' })).getByRole('listitem');
    expect(within(row).getByRole('heading')).toHaveTextContent('精灵表调整');
    expect(row).toHaveTextContent(manifest.version);
    expect(row).toHaveTextContent(manifest.description);
    const toggle = within(row).getByRole('switch', { name: '启用精灵表调整' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(network.mock.calls.some(([url, init]) => url === '/api/plugins/sprite-sheet/enable' && init?.method === 'POST')).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('版本不兼容时显示原因并禁用开关', async () => {
    server([sprite({ availability: 'incompatible', reason: '需要 Atelier 9.0.0 以上' })]);
    render(<PluginsPage />);
    expect(await screen.findByText('需要 Atelier 9.0.0 以上')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('清单读不出时只显示「无法读取」，原因放在提示里，不影响其他插件', async () => {
    server([{ id: 'broken', availability: 'invalid', reason: 'name: Field required', enabled: false, manifest: null }, sprite()]);
    render(<PluginsPage />);
    const rows = within(await screen.findByRole('list', { name: '插件' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('heading')).toHaveTextContent('broken');
    expect(within(rows[0]).getByRole('switch')).toBeDisabled();
    expect(await hoverHint(within(rows[0]).getByText('无法读取'))).toHaveTextContent('name: Field required');
    expect(within(rows[1]).getByRole('switch')).toBeEnabled();
  });

  it('没有插件时显示空状态', async () => {
    server([]);
    render(<PluginsPage />);
    expect(await screen.findByText('暂无插件')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '插件' })).not.toBeInTheDocument();
  });

  it('启用失败时报错并以服务端状态为准', async () => {
    server([sprite()], { status: 409, detail: { message: '需要 Atelier 9.0.0 以上', code: 'PLUGIN_UNAVAILABLE' } });
    render(<PluginsPage />);
    const toggle = await screen.findByRole('switch', { name: '启用精灵表调整' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('需要 Atelier 9.0.0 以上');
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('返回格式不对时提示重启服务', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plugins: 'nope' }))));
    render(<PluginsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('返回格式不对');
  });
});
