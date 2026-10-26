import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { App } from './App';

// Authentication and retained drafts are exercised by LocalConnectionGate.test.tsx.
vi.mock('@/components/LocalConnectionGate', () => ({
  LocalConnectionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  sessionStorage.removeItem('atelier:pending-update');
  vi.stubGlobal('fetch', vi.fn());
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  sessionStorage.removeItem('atelier:pending-update');
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App onboarding gate', () => {
  it('keeps update recovery beyond 30 seconds and follows a rollback instance before onboarding is ready', async () => {
    vi.useFakeTimers();
    const { updateNavigation } = await import('@/api/update');
    const reload = vi.spyOn(updateNavigation, 'reload').mockImplementation(() => {});
    sessionStorage.setItem('atelier:pending-update', JSON.stringify({ id: 'update-one', instance: 'candidate', to: '5.130.0', service: false, restartAt: Date.now() }));
    let instance = 'candidate';
    const network = vi.fn(async (path: string) => path === '/api/connection/status'
      ? new Response(JSON.stringify({ service: 'game-atelier', instance_id: instance }))
      : new Response(JSON.stringify({ detail: '正在准备新版' }), { status: 503 }));
    vi.stubGlobal('fetch', network);
    const { act } = await import('@testing-library/react');
    await act(async () => { render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(screen.getByText('正在重启…')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    instance = 'rollback';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem('atelier:pending-update')!).instance).toBe('rollback');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).toHaveBeenCalledOnce();
  });
  it('applies the persisted update recovery deadline before onboarding completes', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('atelier:pending-update', JSON.stringify({ id: 'update-one', instance: 'candidate', to: '5.130.0', service: false, restartAt: Date.now() - 301_000 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: '正在准备新版' }), { status: 503 })));
    const { act } = await import('@testing-library/react');
    await act(async () => { render(<App />); });
    expect(screen.getByText('服务没有自动恢复，请双击启动器')).toBeInTheDocument();
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
  });
  it('retries onboarding while a newly started update instance is still initializing', async () => {
    vi.useFakeTimers();
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ready', items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '正在准备新版' }), { status: 503 }));
    vi.stubGlobal('fetch', network);
    const { act } = await import('@testing-library/react');
    await act(async () => { render(<App />); });
    expect(screen.getByText('加载中…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByLabelText('作品集首页')).toBeInTheDocument();
  });
  it('shows a release link for bundle updates', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ready', runtime_mode: 'bundle',
        update: { latest: '9.0.0', update_available: true }, items: [] }),
    });
    render(<App />);
    for (const link of await screen.findAllByText('有新版本 9.0.0')) {
      expect(link).toHaveAttribute(
        'href', 'https://github.com/ZhongBiao-zheng/game-atelier/releases/tag/v9.0.0',
      );
    }
  });

  it('opens the home page when API keys have not been added yet', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'needs_first_key',
          data_root: '/tmp/workflow',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: 'add_key',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('作品集首页')).toBeInTheDocument();
    });
    expect(screen.queryByText(/还没有 API Key/)).not.toBeInTheDocument();
  });

  it('opens the app shell at 1024px width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ready',
          data_root: '/tmp/workflow',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: 'open_app',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('作品集首页')).toBeInTheDocument();
    });
    expect(screen.getByText('Atelier')).toBeInTheDocument();
    expect(screen.queryByText(/请在桌面浏览器打开/)).not.toBeInTheDocument();
  });
});
