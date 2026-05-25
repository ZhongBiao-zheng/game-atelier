import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Home } from './Home';

beforeEach(() => {
  globalThis.fetch = vi.fn() as any;
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
  it('shows hero title and italic tagline', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    renderHome();
    expect(screen.getByText('Atelier')).toBeInTheDocument();
    expect(screen.getByText(/一间安静的暖色画廊/)).toBeInTheDocument();
  });

  it('shows skeleton during LOADING', () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}));
    const { container } = renderHome();
    expect(container.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
  });

  it('shows EMPTY copy when 0 characters', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/工坊还空着/)).toBeInTheDocument();
    });
  });

  it('renders masonry images on SUCCESS', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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
    });
    const { container } = renderHome();
    await waitFor(() => {
      expect(container.querySelectorAll('img').length).toBe(1);
    });
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('characters%2Fchar-a%2Fportrait%2Fa.png');
  });

  it('shows ERROR state on fetch failure', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/暂时拿不到图片/)).toBeInTheDocument();
    });
  });
});
