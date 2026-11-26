import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as desktopShell from '@/lib/desktopShell';

import { App } from './App';
import { updateStudioView } from './pages/studioDraft';

// Authentication and retained drafts are exercised by LocalConnectionGate.test.tsx.
vi.mock('@/components/LocalConnectionGate', () => ({
  LocalConnectionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  sessionStorage.removeItem('atelier:pending-update');
  // 首页输入框默认 Agent 会拉对话模型；这里的 fetch 桩只回 {}，固定成图片模式。
  updateStudioView({ inputMode: 'image' });
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
  it.each([true, false])('offers diagnostics only when the service responds (online=%s)', async online => {
    vi.useFakeTimers();
    const openLog = vi.fn();
    vi.spyOn(desktopShell, 'shellLogOpener').mockReturnValue(openLog);
    const network = vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ detail: '供应商配置版本无法识别' }), { status: 409 });
    });
    vi.stubGlobal('fetch', network);
    await act(async () => { render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByRole('alert')).toHaveTextContent(online ? '供应商配置版本无法识别' : '连不上 Cobrush 服务');
    const download = screen.queryByRole('link', { name: '导出诊断日志' });
    if (online) {
      expect(download).toHaveAttribute('href', '/api/diagnostics/export');
      expect(download).toHaveAttribute('download');
    } else expect(download).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    expect(openLog).toHaveBeenCalledOnce();
    const calls = network.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(network).toHaveBeenCalledTimes(calls + 1);
  });

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
    expect(screen.getByText('重启中…')).toBeInTheDocument();
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
    expect(screen.getByText('Cobrush 没有自动恢复，请重新打开 Cobrush')).toBeInTheDocument();
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
  });
  it('retries onboarding while a newly started update instance is still initializing', async () => {
    vi.useFakeTimers();
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ready', items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '正在准备新版' }), { status: 503 }));
    vi.stubGlobal('fetch', network);
    const { act } = await import('@testing-library/react');
    await act(async () => { render(<App />); });
    expect(screen.getByText('启动中…')).toBeInTheDocument();
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

  it('shows the connect-a-model step before any key is added', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/onboarding/status'
      ? new Response(JSON.stringify({ status: 'needs_first_key', data_root: '/tmp/workflow', uv_path: null,
        venv_python: null, platform: 'darwin', next_action: 'add_key', onboarding_skipped: false }))
      : new Response(JSON.stringify({}), { status: 404 })));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '连接一个模型' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /步/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument();
    expect(screen.queryByLabelText('作品集首页')).not.toBeInTheDocument();
  });

  it('asks where to keep data first, then moves on to connecting a model', async () => {
    let confirmed = false;
    const network = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/folder-picker') return new Response(JSON.stringify({ path: 'D:\\Art' }));
      if (path === '/api/onboarding/data-root') {
        expect(JSON.parse(String(init?.body))).toEqual({ path: 'D:\\Art' });
        return new Response(JSON.stringify({ data_root: 'C:\\Users\\a\\game-atelier',
          move: { phase: 'copying', mode: 'copy', target: 'D:\\Art\\Cobrush', total_bytes: 1, copied_bytes: 0, error: null, detail: null } }));
      }
      if (path === '/api/data-root') {
        confirmed = true;
        return new Response(JSON.stringify({ data_root: 'D:\\Art\\Cobrush',
          move: { phase: 'done', mode: 'copy', target: 'D:\\Art\\Cobrush', total_bytes: 1, copied_bytes: 1, error: null, detail: null } }));
      }
      if (path === '/api/onboarding/status') {
        return new Response(JSON.stringify({ status: confirmed ? 'needs_first_key' : 'needs_data_root',
          data_root: 'C:\\Users\\a\\game-atelier', platform: 'win32', next_action: '', onboarding_skipped: false }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', network);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '选择存放位置' })).toBeInTheDocument();
    expect(screen.getByLabelText('存放位置')).toHaveValue('C:\\Users\\a\\game-atelier');
    fireEvent.click(screen.getByRole('button', { name: '更改' }));
    await waitFor(() => expect(screen.getByLabelText('存放位置')).toHaveValue('D:\\Art'));
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByRole('heading', { name: '连接一个模型' }, { timeout: 3000 })).toBeInTheDocument();
    expect(network.mock.calls.map(([path]) => path)).toContain('/api/data-root');
  });

  it('opens the home page once the connect-a-model step was skipped', async () => {
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
          onboarding_skipped: true,
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
    expect(screen.getByText('Cobrush')).toBeInTheDocument();
    expect(screen.queryByText(/请在桌面浏览器打开/)).not.toBeInTheDocument();
  });
});
