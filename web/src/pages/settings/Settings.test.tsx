import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PreferencesPage as SettingsPage } from './PreferencesPage';

// These page tests exercise shell/settings behavior; gateway interactions have their own suite.
vi.mock('@/api/gateway', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/gateway')>(),
  fetchGatewayTasks: async () => [],
  fetchGatewayMembers: async () => ({ members: [], unavailable_routes: [] }),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (url === '/api/onboarding/status') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'ready',
          data_root: '/Users/me/game-atelier',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: '',
        }),
      } as Response);
    }
    if (url === '/api/connection/agent') {
      return Promise.resolve({ ok: true, json: async () => ({ enabled: false, connections: {} }) } as Response);
    }
    if (url === '/api/connection/sessions') {
      return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) } as Response);
    }
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ keys: [], default_alias: null }),
      } as Response);
    }
    if (url === '/api/data-root') {
      const switched = init?.method === 'POST';
      return Promise.resolve({
        ok: true,
        json: async () => ({
          data_root: switched ? '/Users/me/new-root' : '/Users/me/game-atelier',
          move: { phase: switched ? 'done' : 'idle', mode: switched ? 'switch' : null, target: null,
            total_bytes: 0, copied_bytes: 0, error: null, detail: null },
        }),
      } as Response);
    }
    if (url === '/api/folder-picker') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ path: '/Users/me/new-root' }),
      } as Response);
    }
    if (url === '/api/profile') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ display_name: '老王' }),
      } as Response);
    }
    if (url === '/api/projects') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          projects: [{ id: 'p1', slug: 'maipai', name: '买牌三国', created_at: '2026-01-01T00:00:00Z' }],
          assignments: {},
        }),
      } as Response);
    }
    if (typeof url === 'string' && url.startsWith('/api/team-libraries')) {
      return Promise.resolve({ ok: true, json: async () => [] } as Response);
    }
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ image_storage_root: '/Users/me/game-atelier', show_canvas_on_home: false }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsPage', () => {
  it('shows and updates the project storage data root', async () => {
    render(<SettingsPage />);

    const path = await screen.findByLabelText('数据目录');
    await waitFor(() => expect(path).toHaveTextContent('/Users/me/game-atelier'));
    const rootSection = within(path.closest('section') as HTMLElement);
    const download = screen.getByRole('link', { name: '导出诊断日志' });
    expect(download).toHaveAttribute('href', '/api/diagnostics/export');
    expect(download).toHaveAttribute('download');

    // 选完文件夹直接更换（目标已是 Atelier 数据目录时服务端直接切换），不再有「保存」这一步。
    fireEvent.click(rootSection.getByRole('button', { name: /更换文件夹/ }));
    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/data-root',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/Users/me/new-root' }),
        }),
      );
    });
    await waitFor(() => expect(path).toHaveTextContent('/Users/me/new-root'));
    expect(await rootSection.findByText('已切换')).toBeInTheDocument();
  });

  it('renders the show-canvas-on-home switch and posts the toggle', async () => {
    render(<SettingsPage />);

    const toggle = await screen.findByRole('switch', { name: '首页展示画布出图' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    // 乐观切换立即生效
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ show_canvas_on_home: true }),
        }),
      );
    });
  });

  it('rolls the switch back when the config update fails', async () => {
    const baseFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500 } as Response);
      }
      return baseFetch(url, init);
    }));
    render(<SettingsPage />);

    const toggle = await screen.findByRole('switch', { name: '首页展示画布出图' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });
});
