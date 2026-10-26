import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import type { useSSE as UseSSE } from '@/hooks/useSSE';
import { AppShell } from './AppShell';
import { markAnnouncementsSeen } from '@/lib/announcements';

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
