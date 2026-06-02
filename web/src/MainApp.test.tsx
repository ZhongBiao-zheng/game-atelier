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
    expect(screen.queryByText('请在左栏选择角色')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/jobs'));
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
