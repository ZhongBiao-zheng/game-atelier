import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MainApp } from './MainApp';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MainApp', () => {
  it('uses the project directory as the URL-stable workshop landing', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
            assignments: {},
          }),
        };
      }
      if (url === '/api/jobs') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<MainApp />);

    expect(await screen.findByRole('heading', { name: '全部项目' })).toBeInTheDocument();
    expect(screen.getByText('每个项目保存自己的世界观、文件夹与美术、UI、视频资产。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开项目导航' })).not.toBeInTheDocument();
    expect(screen.queryByText(/未归档|未分类/)).not.toBeInTheDocument();
    expect(screen.queryByText('请在左栏选择角色')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/jobs');
  });

  it('opens a routed image detail directly', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '2026-05-29T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
            assignments: {},
          }),
        };
      }
      if (url === '/api/jobs/job-promo-1') {
        return {
          ok: true,
          json: async () => ({
            job_id: 'job-promo-1',
            character_id: 'cao-cao',
            prompt: '曹操美宣详情 prompt',
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
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(
      <MainApp
        routedCharacterId="cao-cao"
        routedAssetSlot="promo"
        routedImageDetail={{
          jobId: 'job-promo-1',
          path: '/tmp/game-atelier/characters/cao-cao/promo/kv.png',
        }}
      />,
    );

    expect(await screen.findByDisplayValue('曹操美宣详情 prompt')).toBeInTheDocument();
    expect(screen.getByText('返回画廊')).toBeInTheDocument();
  });

  it('uses the project sidebar as the only workspace navigation', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: 'cao-cao' }) };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'sanguo', name: '三国', created_at: '2026-06-01T00:00:00Z' }],
            assignments: { 'cao-cao': 'p1' },
          }),
        };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }) as any);

    render(
      <MainApp
        routedProjectId="p1"
        routedWorkspace="art"
        routedCharacterId="cao-cao"
      />,
    );

    expect(await screen.findByRole('link', { name: '角色与皮肤' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'UI 方案与页面' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '视频企划' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '项目工作区' })).not.toBeInTheDocument();
  });

  it('opens and closes the mobile project roster with focus return', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null }) };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
            assignments: {},
          }),
        };
      }
      if (String(url).includes('/api/experience?')) {
        return {
          ok: true,
          json: async () => ({
            project: { id: 'p1', slug: 'one', name: '项目一', created_at: '' },
            worldview_md: '',
          }),
        };
      }
      if (String(url).startsWith('/api/projects/p1/gallery')) {
        return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
      }
      if (url === '/api/characters') return { ok: true, json: async () => [] };
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }) as any);

    render(<MainApp routedProjectId="p1" routedWorkspace="overview" />);

    const trigger = await screen.findByRole('button', { name: '打开项目导航' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const close = screen.getByRole('button', { name: '关闭', hidden: true });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows a recoverable state for an invalid project URL', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ projects: [], assignments: {} }) };
      }
      if (url === '/api/characters') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }) as any);

    render(<MainApp routedProjectId="missing" routedWorkspace="overview" />);

    expect(await screen.findByRole('heading', { name: '找不到这个项目' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回全部项目' })).toHaveAttribute('href', '/workshop');
    expect(screen.queryByRole('button', { name: '打开项目导航' })).not.toBeInTheDocument();
  });

  it('shows the same project hierarchy inside the mobile drawer', async () => {
    class TestEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    }

    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-atelier' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: 'cao-cao' }) };
      }
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'sanguo', name: '三国', created_at: '2026-06-01T00:00:00Z' }],
            assignments: { 'cao-cao': 'p1' },
          }),
        };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/jobs') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }) as any);

    render(
      <MainApp routedProjectId="p1" routedWorkspace="art" routedCharacterId="cao-cao" />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '打开项目导航' }));
    const nav = await screen.findByRole('navigation', { name: '三国 项目导航' });
    expect(nav).toHaveTextContent('项目首页');
    expect(nav).toHaveTextContent('文件夹');
    expect(nav).toHaveTextContent('资产库');
    expect(screen.getByRole('button', { name: '曹操', hidden: true })).toBeInTheDocument();
  });
});
