import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { hoverHint } from '@/test/hint';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import type { useSSE as UseSSE } from '@/hooks/useSSE';
import { AppShell } from './AppShell';
import { markAnnouncementsSeen } from '@/lib/announcements';
import type { UpdateState } from '@/api/update';

type SSEOptions = NonNullable<Parameters<typeof UseSSE>[0]>;
const sseCalls = vi.hoisted(() => [] as Array<SSEOptions | undefined>);
const connection = vi.hoisted(() => ({ forceReady: false }));

// 默认沿用 test/setup 的连接 mock；个别用例把连接态强制成 ready，让 useSSE 真的去连 /events。
vi.mock('@/api/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/connection')>();
  return {
    ...actual,
    connectionFetch: (input: string, init?: RequestInit) => init ? fetch(input, init) : fetch(input),
    useConnectionState: () => {
      const state = actual.useConnectionState();
      return connection.forceReady ? { ...state, phase: 'ready' as const, generation: 1 } : state;
    },
  };
});

vi.mock('@/hooks/useSSE', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/useSSE')>();
  return {
    ...actual,
    useSSE: (options?: SSEOptions) => {
      sseCalls.push(options);
      return actual.useSSE(options);
    },
  };
});

// These page tests exercise shell/settings behavior; gateway interactions have their own suite.
vi.mock('@/api/gateway', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/gateway')>(),
  fetchGatewayTasks: async () => [],
  fetchGatewayMembers: async () => ({ members: [], unavailable_routes: [] }),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }));
  // 模型公告是模态弹窗，弹出时外壳整体 aria-hidden；外壳测试按已读起步。
  markAnnouncementsSeen();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sseCalls.splice(0);
  connection.forceReady = false;
  window.localStorage.removeItem('atelier:team-reminded');
  window.localStorage.removeItem('atelier:theme');
  window.localStorage.removeItem('atelier:changelog-seen');
  window.localStorage.removeItem('atelier:announcements-seen');
  document.documentElement.classList.remove('light');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

function renderAt(path: string) {
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <Router hook={hook}>
      <AppShell />
    </Router>,
  );
}

describe('AppShell', () => {
  it('renders the provider add route inside the console', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) } as Response);
    renderAt('/settings/providers/new');
    expect(await screen.findByRole('heading', { name: '添加' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '供应商' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Tuzi/ })).toBeInTheDocument();
  });
  it('renders Atelier logo on every route', () => {
    renderAt('/studio');
    expect(screen.getByText('Atelier')).toBeInTheDocument();
  });

  it('highlights 创作台 tab on /studio', () => {
    renderAt('/studio');
    expect(screen.getByText('创作台')).toHaveAttribute('aria-current', 'page');
  });

  it('shows only current navigation and highlights 画布', () => {
    renderAt('/canvas');
    const nav = screen.getByRole('navigation');
    const labels = within(nav).getAllByRole('link').map(link => link.textContent);
    expect(labels).toEqual(['主页', '创作台', '画布']);
    expect(screen.getByText('画布')).toHaveAttribute('aria-current', 'page');
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('创作台')).not.toHaveAttribute('aria-current');
    expect(screen.queryByText('工坊')).toBeNull();
    expect(screen.getByText('主页')).toHaveAttribute('aria-current', 'page');
  });

  it('active tab keeps size; the sliding pill carries the liquid glass', () => {
    renderAt('/');
    const tab = screen.getByText('主页');
    expect(tab.className).toContain('h-10');
    expect(tab.className).toContain('rounded-full');
    // 玻璃质感移到 magic-move 滑动药丸：active tab 内渲染共享 layoutId 的玻璃元素
    const pill = screen.getByTestId('nav-active-indicator');
    expect(pill.className).toContain('bg-glass');
    expect(pill.className).toContain('backdrop-blur-glass');
    expect(pill.className).toContain('border-input');
    expect(pill.className).toContain('nav-active-ring');
  });

  it('settings icon is selected with neutral color on /settings', () => {
    renderAt('/settings');
    const link = screen.getByLabelText('设置');
    expect(link.className).toContain('text-foreground');
  });

  it('theme toggle sits left of settings and flips html class + localStorage', () => {
    // 点击会 flush 微任务，Home 的 gallery fetch 必须给到合法形状（{} 会让 items.length 炸）
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(url).startsWith('/api/gallery/recent') ? { items: [] } : {}),
    })));
    renderAt('/');
    const toggle = screen.getByLabelText('切换到浅色主题');
    const settings = screen.getByLabelText('设置');
    expect(toggle.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(window.localStorage.getItem('atelier:theme')).toBe('light');

    fireEvent.click(screen.getByLabelText('切换到深色主题'));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(window.localStorage.getItem('atelier:theme')).toBe('dark');
  });

  it('hosts the team share reminder on the shell SSE connection', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(url) === '/api/gateway'
        ? { enabled: true, port: 5180, keys: [], status: { running: false, addresses: [] } }
        : String(url) === '/api/gateway/options' ? { models: [], aliases: [] }
        : String(url) === '/api/profile' ? { display_name: '我' } : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/settings/gateway');
    const profileCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/profile').length;
    await waitFor(() => expect(profileCalls()).toBeGreaterThan(0));

    const hosts = sseCalls.filter(options => options?.onTeamLibraryChanged);
    expect(hosts.length).toBeGreaterThan(0);
    const shell = hosts.at(-1)!;
    expect(shell.onConnect).toBeInstanceOf(Function);
    act(() => shell.onGatewayTask?.({
      task_id: 'gateway-live', kind: 'text', key_name: '网关同事', route_id: 'text-model',
      member_alias: 'Local', member_trail: ['Local'], phase: null, status: 'running',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      prompt: null, n: 0, outputs: 0, output_types: [], error: null,
    }));
    expect(screen.getByText('网关同事')).toBeInTheDocument();

    act(() => {
      shell.onTeamLibraryChanged?.({
        library_id: 'lib_a', asset_id: 'ta_1', kind: 'generation', author: '阿岚',
        change: 'added', title: '雨夜城门', status: 'ready', mime_type: 'image/png',
      });
    });
    expect(await screen.findByText('雨夜城门')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复刻' })).toBeInTheDocument();

    const before = profileCalls();
    act(() => { shell.onConnect?.(); });
    await waitFor(() => expect(profileCalls()).toBe(before + 1));
  });

  it('opens exactly one /events stream for the whole shell', async () => {
    connection.forceReady = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/events') {
        return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return { ok: true, json: async () => (String(url) === '/api/profile' ? { display_name: '我' } : {}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = renderAt('/settings');
    const eventStreams = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/events').length;

    await waitFor(() => expect(eventStreams()).toBe(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(eventStreams()).toBe(1);
    view.unmount();
  });
});

// The updater owns one polling loop across shell and settings, including reload recovery.
describe('in-app update controls', () => {
  const readyUpdate: UpdateState = { runtime_mode: 'bundle', current: '5.129.0', status: 'ready', to: '5.130.0',
    maintenance: false, waiting: 0, phase: 'idle', service_mode: false };
  beforeEach(() => {
    sessionStorage.removeItem('atelier:pending-update');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.removeItem('atelier:pending-update');
    vi.restoreAllMocks();
  });
  function updateServer({ state = readyUpdate, applyStatus = 202, result = null as unknown } = {}) {
    const network = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/connection/status') return new Response(JSON.stringify({ service: 'game-atelier', instance_id: 'old' }));
      if (input === '/api/update/apply') return new Response(JSON.stringify(applyStatus === 202 ? { update_id: 'update-one' } : { detail: '正在更新' }), { status: applyStatus });
      if (input.startsWith('/api/update/result')) return new Response(JSON.stringify(result));
      if (input === '/api/update/cancel') return new Response(JSON.stringify({ status: 'cancelled' }));
      if (input === '/api/update/check' && init?.method === 'POST') return new Response(JSON.stringify({ ...state, status: 'checking' }));
      return new Response(JSON.stringify(state));
    });
    vi.stubGlobal('fetch', network);
    return network;
  }
  async function renderUpdater(mode: 'source' | 'bundle' = 'bundle', latest: string | null = null) {
    const { UpdateProvider, UpdateButton, UpdateSettings } = await import('./UpdateControl');
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<UpdateProvider runtimeMode={mode} latestRelease={latest}><UpdateButton /><UpdateSettings /></UpdateProvider>); });
    return view;
  }
  async function startUpdate() {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })); });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '更新' })); });
  }
  it('shows the ready bundle button and preserves the legacy release link', async () => {
    updateServer();
    const view = await renderUpdater();
    expect(await hoverHint(screen.getByRole('button', { name: '更新' }))).toHaveTextContent('更新到 5.130.0');
    view.unmount();
    updateServer({ state: { ...readyUpdate, runtime_mode: 'legacy_bundle' } });
    await renderUpdater('bundle', '5.130.0');
    expect(screen.getByRole('link', { name: '有新版本 5.130.0' })).toHaveAttribute('href', 'https://github.com/ZhongBiao-zheng/game-atelier/releases/tag/v5.130.0');
  });
  it('source mode opens changelog without starting an update', async () => {
    const network = updateServer({ state: { ...readyUpdate, runtime_mode: 'source' } });
    const show = vi.fn();
    window.addEventListener('atelier:open-changelog', show);
    await renderUpdater('source', '5.130.0');
    fireEvent.click(screen.getByRole('button', { name: '新版本 5.130.0' }));
    expect(show).toHaveBeenCalledOnce();
    expect(network.mock.calls.some(([path]) => path === '/api/update/apply')).toBe(false);
    window.removeEventListener('atelier:open-changelog', show);
  });
  it('shows a 409 reason without entering recovery', async () => {
    updateServer({ applyStatus: 409 });
    await renderUpdater();
    await startUpdate();
    expect(screen.getByRole('alert')).toHaveTextContent('正在更新');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
  });
  it('waits after 202, allows cancellation, and does not include job waiting in the restart budget', async () => {
    updateServer({ state: { ...readyUpdate, waiting: 2, waiting_counts: { jobs: 1, approvals: 1 } } });
    await renderUpdater();
    await startUpdate();
    expect(screen.getByRole('dialog')).toHaveTextContent('等待 2 个任务完成');
    expect(screen.getByRole('dialog')).toHaveTextContent('1 个 Agent 操作待确认');
    expect(JSON.parse(sessionStorage.getItem('atelier:pending-update')!).restartAt).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
    expect(screen.getByRole('dialog')).toHaveTextContent('等待 2 个任务完成');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消更新' })); });
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('restores cancellation when a transient probe failure resolves to the same waiting transaction', async () => {
    const network = updateServer({ state: { ...readyUpdate, update_id: 'update-one', phase: 'waiting',
      maintenance: true, waiting: 1, waiting_counts: { approvals: 1 } } });
    await renderUpdater();
    await startUpdate();
    const respond = network.getMockImplementation()!;
    let failProbe = true;
    network.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/connection/status' && failProbe) {
        failProbe = false;
        throw new Error('temporary timeout');
      }
      return respond(path, init);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('dialog')).toHaveTextContent('正在重启');
    expect(screen.queryByRole('button', { name: '取消更新' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('dialog')).toHaveTextContent('1 个 Agent 操作待确认');
    expect(JSON.parse(sessionStorage.getItem('atelier:pending-update')!).restartAt).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消更新' })); });
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('reloads on a new instance without requiring an observed disconnect, then waits for its result', async () => {
    const { updateNavigation } = await import('@/api/update');
    const reload = vi.spyOn(updateNavigation, 'reload').mockImplementation(() => {});
    const network = updateServer();
    const view = await renderUpdater();
    await startUpdate();
    network.mockImplementation(async (path: string) => new Response(JSON.stringify(path === '/api/connection/status'
      ? { service: 'game-atelier', instance_id: 'new' }
      : path.startsWith('/api/update/result') ? null : readyUpdate)));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem('atelier:pending-update')!).instance).toBe('new');
    view.unmount();
    await renderUpdater();
    expect(screen.getByRole('dialog')).toHaveTextContent('正在重启');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    network.mockImplementation(async (path: string) => new Response(JSON.stringify(path === '/api/connection/status'
      ? { service: 'game-atelier', instance_id: 'new' }
      : path.startsWith('/api/update/result') ? { update_id: 'update-one', status: 'failed', reason: '新版未启动，已恢复旧版' } : readyUpdate)));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('alert')).toHaveTextContent('新版未启动，已恢复旧版');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
  });
  it('shows blocked reason and supports an explicit recheck', async () => {
    const network = updateServer({ state: { ...readyUpdate, status: 'blocked', reason: '系统拒绝运行新版' } });
    await renderUpdater();
    expect(screen.queryByRole('button', { name: '更新' })).not.toBeInTheDocument();
    expect(screen.getByText('系统拒绝运行新版')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新检查' })); });
    expect(network.mock.calls.some(([path, init]) => path === '/api/update/check' && init?.method === 'POST')).toBe(true);
    expect(screen.getByText('正在检查…')).toBeInTheDocument();
  });
  it.each([false, true])('uses the %s service-mode restart budget, then clears persisted progress', async service => {
    updateServer();
    sessionStorage.setItem('atelier:pending-update', JSON.stringify({ id: 'update-one', instance: 'old', to: '5.130.0', service,
      restartAt: Date.now() - (service ? 6 : 4) * 60_000 }));
    await renderUpdater();
    expect(screen.getByRole('dialog')).toHaveTextContent('正在重启');
    await act(async () => { await vi.advanceTimersByTimeAsync(62_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('服务没有自动恢复，请双击启动器');
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
  });
  it('clears successful results silently after page reload', async () => {
    updateServer({ result: { update_id: 'update-one', status: 'succeeded' } });
    sessionStorage.setItem('atelier:pending-update', JSON.stringify({ id: 'update-one', instance: 'old', to: '5.130.0', service: false, restartAt: Date.now() }));
    await renderUpdater();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('atelier:pending-update')).toBeNull();
  });
});
