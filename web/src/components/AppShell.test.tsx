import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AppShell } from './AppShell';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem('atelier:theme');
  window.localStorage.removeItem('atelier:changelog-seen');
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
  it('renders Atelier logo on every route', () => {
    renderAt('/studio');
    expect(screen.getByText('Atelier')).toBeInTheDocument();
  });

  it('hides the brand subtitle until there is room for it', () => {
    renderAt('/');
    expect(screen.getByText('· 工作流').className).toContain('hidden');
    expect(screen.getByText('· 工作流').className).toContain('sm:inline');
  });

  it('highlights 创作台 tab on /studio', () => {
    renderAt('/studio');
    expect(screen.getByText('创作台')).toHaveAttribute('aria-current', 'page');
  });

  it('highlights 工坊 tab on /workshop/p1/ui', () => {
    renderAt('/workshop/p1/ui');
    expect(screen.getByText('工坊')).toHaveAttribute('aria-current', 'page');
  });

  it('restores a folder filter deep link inside the stable project shell', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (path === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
            assignments: {},
          }),
        };
      }
      if (path === '/api/characters') return { ok: true, json: async () => [] };
      if (path === '/api/projects/p1/folders') {
        return {
          ok: true,
          json: async () => ({ folders: [{
            id: 'folder-summer', name: '夏日版本', note: '', created_at: '',
            items: [{ kind: 'ui_screen', asset_id: 'home', scheme_id: 'v1' }],
          }] }),
        };
      }
      if (path === '/api/projects/p1/ui-schemes') {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [{ id: 'v1', name: 'V1', created_at: '' }],
          }),
        };
      }
      if (path.startsWith('/api/projects/p1/workspaces')) {
        return {
          ok: true,
          json: async () => ({
            project_id: 'p1', art: { characters: 0, canonical: 0, stale: 0 },
            ui: {
              scheme_id: 'v1',
              anchors: {}, anchors_approved: 0, style_status: 'missing', has_ui_style: false,
              screen_map_status: 'draft', screens: 1, versions: 0, canonical: 0, stale: 0,
              screen_items: [{ screen_id: 'home', name: '主界面', category: '', priority: '', status: 'planned', dependency: '', purpose: '', brief_summary: '' }],
              next_action: '', next_command: '',
            },
            video: { productions: 0, shots: 0, selected_shots: 0, exports: 0, next_action: '' },
          }),
        };
      }
      if (path === '/api/projects/p1/videos') {
        return { ok: true, json: async () => ({ productions: [] }) };
      }
      if (path === '/api/gallery/screens?project=p1&scheme=v1') {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    renderAt('/workshop/p1/folders/folder-summer/ui');

    expect(await screen.findByDisplayValue('夏日版本')).toBeInTheDocument();
    expect(screen.getByText('V1 · 主界面')).toBeInTheDocument();
    const breadcrumbs = screen.getByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumbs).getByText('文件夹')).toBeInTheDocument();
    expect(within(breadcrumbs).getByText('夏日版本')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '夏日版本' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '项目首页' })).not.toHaveAttribute('aria-current');
    expect(within(screen.getByRole('navigation', { name: '文件夹视图' })).getByRole('link', { name: 'UI' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('keeps the project shell on an image deep link and returns through the URL', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '2026-05-29T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return { ok: true, json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }] };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '2026-08-20T00:00:00Z' }],
            assignments: { 'cao-cao': 'p1' },
          }),
        };
      }
      if (url === '/api/jobs/job-promo-1') {
        return {
          ok: true,
          json: async () => ({
            job_id: 'job-promo-1',
            character_id: 'cao-cao',
            prompt: '路由详情 prompt',
            submitted_at: '2026-05-29T00:00:00Z',
            model: 'gpt-image-2',
            params: { n: 1 },
            output_paths: ['/tmp/game-atelier/characters/cao-cao/promo/kv.png'],
            status: 'done',
            error: null,
            asset_slot: 'promo',
            kind: 'image',
            namespace: 'character',
          }),
        };
      }
      if (url === '/api/jobs') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const location = memoryLocation({
      path: '/workshop/p1/art/characters/cao-cao/promo/job-promo-1/%2Ftmp%2Fgame-atelier%2Fcharacters%2Fcao-cao%2Fpromo%2Fkv.png',
      static: false,
      record: true,
    });
    render(
      <Router hook={location.hook}>
        <AppShell />
      </Router>,
    );

    expect(await screen.findByDisplayValue('路由详情 prompt')).toBeInTheDocument();
    const breadcrumbs = screen.getByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumbs).getByRole('link', { name: '全部项目' })).toHaveAttribute('href', '/workshop');
    expect(within(breadcrumbs).getByRole('link', { name: '项目一' })).toHaveAttribute(
      'href', '/workshop/p1/overview',
    );
    expect(screen.getByRole('navigation', { name: '项目工作区' })).toBeInTheDocument();
    expect(screen.queryByText('返回工坊')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(location.history.at(-1)).toBe(
      '/workshop/p1/art/characters/cao-cao/promo',
    ));
  });

  it('redirects a character deep link to its owning project', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null }) };
      }
      if (url === '/api/characters') {
        return { ok: true, json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }] };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [
              { id: 'p1', slug: 'one', name: '项目一', created_at: '2026-08-20T00:00:00Z' },
              { id: 'p2', slug: 'two', name: '项目二', created_at: '2026-08-20T00:00:00Z' },
            ],
            assignments: { 'cao-cao': 'p2' },
          }),
        };
      }
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }));

    const encodedPath = '%2Ftmp%2Fgame-atelier%2Fcharacters%2Fcao-cao%2Fpromo%2Fkv.png';
    const location = memoryLocation({
      path: `/workshop/p1/art/characters/cao-cao/promo/job-promo-1/${encodedPath}?fromFolder=summer&fromView=art`,
      static: false,
      record: true,
    });
    render(
      <Router hook={location.hook}>
        <AppShell />
      </Router>,
    );

    await waitFor(() => expect(location.history.at(-1)).toBe(
      `/workshop/p2/art/characters/cao-cao/promo/job-promo-1/${encodedPath}?fromFolder=summer&fromView=art`,
    ));
    expect(location.history).toHaveLength(1);
  });

  it('redirects an unassigned image deep link to the character owning project', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/characters') {
        return { ok: true, json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }] };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p2', slug: 'two', name: '项目二', created_at: '2026-08-20T00:00:00Z' }],
            assignments: { 'cao-cao': 'p2' },
          }),
        };
      }
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }));

    const encodedPath = '%2Ftmp%2Fgame-atelier%2Fcharacters%2Fcao-cao%2Fpromo%2Fkv.png';
    const location = memoryLocation({
      path: `/workshop/unassigned/characters/cao-cao/promo/job-promo-1/${encodedPath}`,
      static: false,
      record: true,
    });
    render(
      <Router hook={location.hook}>
        <AppShell />
      </Router>,
    );

    await waitFor(() => expect(location.history.at(-1)).toBe(
      `/workshop/p2/art/characters/cao-cao/promo/job-promo-1/${encodedPath}`,
    ));
    expect(location.history).toHaveLength(1);
  });

  it('restores the project route from mobile workspace history and a fresh mount', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/characters') {
        return { ok: true, json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }] };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '2026-08-20T00:00:00Z' }],
            assignments: { 'cao-cao': 'p1' },
          }),
        };
      }
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      if (url === '/api/experience?project=p1') {
        return {
          ok: true,
          json: async () => ({
            project: { id: 'p1', slug: 'one', name: '项目一', created_at: '2026-08-20T00:00:00Z', character_count: 1 },
            worldview_md: '',
          }),
        };
      }
      if (url === '/api/projects/p1/ui-schemes') {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [{ id: 'v1', name: 'V1', created_at: '' }],
          }),
        };
      }
      if (String(url).startsWith('/api/projects/p1/workspaces')) {
        return {
          ok: true,
          json: async () => ({
            project_id: 'p1',
            art: { characters: 1, canonical: 0, stale: 0 },
            ui: {
              scheme_id: 'v1',
              anchors: { gdd: 'missing', prd: 'missing', interaction: 'missing' },
              anchors_approved: 0,
              style_status: 'missing',
              has_ui_style: false,
              screen_map_status: 'missing',
              screens: 0,
              versions: 0,
              canonical: 0,
              stale: 0,
              screen_items: [],
              next_action: '建立 UI 锚点',
              next_command: '/game-atelier:ui',
            },
            video: { productions: 0, shots: 0, selected_shots: 0, exports: 0, next_action: '建立视频企划' },
          }),
        };
      }
      if (url === '/api/gallery/screens?project=p1&scheme=v1') {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      if (url === '/api/projects/p1/ui-schemes/v1/screens/canonical') {
        return { ok: true, json: async () => ({ screens: {} }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const artPath = '/workshop/p1/art/characters/cao-cao/promo';
    const location = memoryLocation({ path: artPath, static: false, record: true });
    const view = render(
      <Router hook={location.hook}>
        <AppShell />
      </Router>,
    );

    expect(await screen.findByRole('navigation', { name: '项目工作区' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: '项目工作区' })).getByRole('link', { name: /UI/ }));
    await waitFor(() => expect(location.history.at(-1)).toBe('/workshop/p1/ui/v1'));

    // 浏览器 Back 会把 URL 恢复到上一项；页面只依赖 URL，因此对象与工作区同时恢复。
    act(() => location.navigate(artPath));
    await waitFor(() => expect(
      within(screen.getByRole('navigation', { name: '项目工作区' })).getByRole('link', { name: /美术/ }),
    ).toHaveAttribute('aria-current', 'page'));
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('曹操')).toBeInTheDocument();

    view.unmount();
    render(
      <Router hook={memoryLocation({ path: artPath, static: true }).hook}>
        <AppShell />
      </Router>,
    );
    expect(await screen.findByRole('navigation', { name: '项目工作区' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('曹操')).toBeInTheDocument();
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('创作台')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('工坊')).not.toHaveAttribute('aria-current');
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

  it('settings icon turns primary on /settings', () => {
    renderAt('/settings');
    const link = screen.getByLabelText('设置');
    expect(link.className).toContain('text-primary');
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
});
