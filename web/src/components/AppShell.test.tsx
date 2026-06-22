import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  document.documentElement.classList.remove('light');
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
    expect(screen.getByText('出图')).toHaveAttribute('aria-current', 'page');
  });

  it('highlights 工坊 tab on /character/foo', () => {
    renderAt('/character/foo');
    expect(screen.getByText('工坊')).toHaveAttribute('aria-current', 'page');
  });

  it('routes character image URLs into the image detail pane', async () => {
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

    renderAt('/character/cao-cao/promo/job-promo-1/%2Ftmp%2Fgame-atelier%2Fcharacters%2Fcao-cao%2Fpromo%2Fkv.png');

    expect(await screen.findByDisplayValue('路由详情 prompt')).toBeInTheDocument();
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('出图')).not.toHaveAttribute('aria-current');
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
