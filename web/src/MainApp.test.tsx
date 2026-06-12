import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { MainApp } from './MainApp';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MainApp', () => {
  it('defaults the workshop to the active character', async () => {
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
        return { ok: true, json: async () => ({ active_id: 'cao-cao', updated_at: '2026-05-29T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ projects: [], assignments: {} }) };
      }
      if (url === '/api/jobs') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<MainApp />);

    expect(await screen.findByText('曹操')).toBeInTheDocument();
    // 侧栏的「曹操」可能先于选中 effect 出现，等空状态消失再断言（语义不变，去竞态）
    await waitFor(() =>
      expect(screen.queryByText('请在左栏选择角色')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/jobs'));
  });

  it('falls back to the first character of the first project when no active character', async () => {
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
        return { ok: true, json: async () => ({ active_id: null, updated_at: '2026-06-12T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [
            { id: 'zhang-fei', name: '张飞', status: 'idle', latest_job_id: null },
            { id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null },
          ],
        };
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
      if (url === '/api/jobs') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<MainApp />);

    // 列表序首位是未分类的张飞，但兜底应按左栏顺序选第一个项目的第一个角色：曹操
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '曹操' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByRole('button', { name: '张飞' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('请在左栏选择角色')).not.toBeInTheDocument();
  });

  it('falls back when the active pointer references a deleted character', async () => {
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
        return { ok: true, json: async () => ({ active_id: 'ghost', updated_at: '2026-06-12T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return {
          ok: true,
          json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }],
        };
      }
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ projects: [], assignments: {} }) };
      }
      if (url === '/api/jobs') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<MainApp />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '曹操' })).toHaveAttribute('aria-pressed', 'true'),
    );
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
        return { ok: true, json: async () => ({ projects: [], assignments: {} }) };
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
            seed: null,
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
});
