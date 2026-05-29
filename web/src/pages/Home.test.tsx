import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Home } from './Home';

beforeEach(() => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({ ok: true, json: async () => [] } as any);
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

function renderNavigableHome() {
  const location = memoryLocation({ path: '/', record: true });
  const view = render(
    <Router hook={location.hook}>
      <Home />
    </Router>,
  );
  return { ...view, location };
}

describe('Home', () => {
  it('shows TapNow-style studio prompt on top', async () => {
    renderHome();
    expect(screen.getByText('描述你想生成的图片')).toBeInTheDocument();
    expect(screen.getByText('作品展示')).toBeInTheDocument();
  });

  it('uses the responsive prompt shell on the home page', () => {
    renderHome();

    expect(screen.getByTestId('studio-prompt-shell')).toHaveClass(
      'min-h-[174px]',
      'h-auto',
      'pt-[14px]',
      'px-4',
      'pb-4',
    );
  });

  it('shows skeleton during LOADING', () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
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
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
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
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.reject(new Error('boom'));
    }) as any;
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/暂时拿不到图片/)).toBeInTheDocument();
    });
  });

  it('opens compact prompt menus downward on the home page', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'seedream',
            keys: [{
              alias: 'seedream',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'Doubao', id: 'doubao' }],
              notes: '',
              created_at: '2026-05-27T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
    }) as any;
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('top-full');
  });

  it('anchors compact prompt popovers to their selected trigger on the home page', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'seedream',
            keys: [{
              alias: 'seedream',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'Doubao', id: 'doubao' }],
              notes: '',
              created_at: '2026-05-27T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
    }) as any;

    renderHome();

    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('absolute', 'left-0', 'top-full');
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).not.toHaveClass('sm:left-40');

    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByTestId('size-popover')).toHaveClass('absolute', 'left-0', 'top-full');
    expect(screen.getByTestId('size-popover')).not.toHaveClass('sm:left-96');
  });

  it('does not show persisted studio generation rounds on the home page', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'seedream',
            keys: [{
              alias: 'seedream',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'Doubao', id: 'doubao' }],
              notes: '',
              created_at: '2026-05-27T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-studio-1',
            character_id: 'seedream',
            prompt: '首页不该展示的出图信息',
            submitted_at: '2026-05-27T01:00:00Z',
            model: 'doubao',
            params: {},
            seed: null,
            output_paths: ['/tmp/studio/job-studio-1/v1.png'],
            status: 'done',
            error: null,
            kind: 'image',
            namespace: 'studio',
            alias: 'seedream',
            provider: 'seedream',
          }],
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
    }) as any;

    renderHome();

    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/api/keys');
    });
    expect(screen.queryByRole('img', { name: '首页不该展示的出图信息' })).not.toBeInTheDocument();
  });

  it('creates a studio job from the home prompt and navigates to studio', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'seedream',
            keys: [{
              alias: 'seedream',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'Doubao', id: 'doubao' }],
              notes: '',
              created_at: '2026-05-27T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ job_id: 'job-home-1', status: 'pending', submitted_at: '2026-05-27T01:00:00Z' }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
    });
    globalThis.fetch = fetchMock as any;
    const { location } = renderNavigableHome();

    await screen.findByText('火山引擎');
    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '首页提交跳转' } });
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    await waitFor(() => expect(location.history).toContain('/studio'));
  });
});
