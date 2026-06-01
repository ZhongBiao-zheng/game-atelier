import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('highlights 出图 tab on /studio', () => {
    renderAt('/studio');
    const tab = screen.getByText('出图');
    expect(tab.className).toContain('bg-[rgba(36,35,33,0.68)]');
  });

  it('highlights 工坊 tab on /character/foo', () => {
    renderAt('/character/foo');
    const tab = screen.getByText('工坊');
    expect(tab.className).toContain('bg-[rgba(36,35,33,0.68)]');
  });

  it('routes character image URLs into the image detail pane', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener = vi.fn();
      close = vi.fn();
      onerror: (() => void) | null = null;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ image_storage_root: '/tmp/game-ui-ai-workflow' }) };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '2026-05-29T00:00:00Z' }) };
      }
      if (url === '/api/characters') {
        return { ok: true, json: async () => [{ id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null }] };
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
            prompt: '路由详情 prompt',
            submitted_at: '2026-05-29T00:00:00Z',
            model: 'gpt-image-2',
            params: { n: 1 },
            seed: null,
            output_paths: ['/tmp/game-ui-ai-workflow/characters/cao-cao/promo/kv.png'],
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

    renderAt('/character/cao-cao/promo/job-promo-1/%2Ftmp%2Fgame-ui-ai-workflow%2Fcharacters%2Fcao-cao%2Fpromo%2Fkv.png');

    expect(await screen.findByDisplayValue('路由详情 prompt')).toBeInTheDocument();
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('出图').className).not.toContain('bg-[rgba(36,35,33,0.68)]');
    expect(screen.getByText('工坊').className).not.toContain('bg-[rgba(36,35,33,0.68)]');
    expect(screen.getByText('主页').className).toContain('bg-[rgba(36,35,33,0.68)]');
  });

  it('active tab keeps size and uses liquid glass styling', () => {
    renderAt('/');
    const tab = screen.getByText('主页');
    expect(tab.className).toContain('h-10');
    expect(tab.className).toContain('rounded-full');
    expect(tab.className).toContain('backdrop-blur-2xl');
    expect(tab.className).toContain('[box-shadow:inset_0_1px_0');
  });

  it('settings icon turns primary on /settings', () => {
    renderAt('/settings');
    const link = screen.getByLabelText('设置');
    expect(link.className).toContain('text-primary');
  });
});
