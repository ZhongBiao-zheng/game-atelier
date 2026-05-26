import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Home } from './Home';

beforeEach(() => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
  }) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderHome() {
  const { hook } = memoryLocation({ path: '/', static: true });
  return render(
    <Router hook={hook}>
      <Home />
    </Router>,
  );
}

describe('Home', () => {
  it('shows TapNow-style studio prompt on top', async () => {
    renderHome();
    expect(screen.getByText('描述你想生成的图片')).toBeInTheDocument();
    expect(screen.getByText('作品展示')).toBeInTheDocument();
  });

  it('shows skeleton during LOADING', () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
      }
      return new Promise(() => {});
    }) as any;
    const { container } = renderHome();
    expect(container.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
  });

  it('shows EMPTY copy when 0 characters', async () => {
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/工坊还空着/)).toBeInTheDocument();
    });
  });

  it('renders masonry images on SUCCESS', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          items: [
            {
              character_id: 'char-a',
              asset_slot: 'portrait',
              filename: 'a.png',
              path: 'characters/char-a/portrait/a.png',
              mtime: 0,
            },
          ],
        }),
      } as any);
    }) as any;
    const { container } = renderHome();
    await waitFor(() => {
      expect(container.querySelectorAll('img').length).toBe(1);
    });
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('characters%2Fchar-a%2Fportrait%2Fa.png');
  });

  it('shows ERROR state on fetch failure', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
      }
      return Promise.reject(new Error('boom'));
    }) as any;
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/暂时拿不到图片/)).toBeInTheDocument();
    });
  });
});
