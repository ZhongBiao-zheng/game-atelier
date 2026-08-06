import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Home } from './Home';

/** contentEditable prompt 编辑器没有 .value：落 textContent + input 事件等效键入。 */
function typePrompt(editor: Element, value: string) {
  editor.textContent = value;
  fireEvent.input(editor);
}

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
              job_id: 'job-portrait-1',
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

  it('links gallery images to the matching image detail route', async () => {
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
              asset_slot: 'promo',
              filename: 'kv.png',
              path: 'characters/char-a/promo/kv.png',
              job_id: 'job-promo-1',
              mtime: 0,
            },
          ],
        }),
      } as any);
    }) as any;
    const { container } = renderHome();
    await waitFor(() => {
      expect(container.querySelector('img')).toBeInTheDocument();
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/character/char-a/promo/job-promo-1/characters%2Fchar-a%2Fpromo%2Fkv.png',
    );
  });

  it('links studio-sourced gallery items to the studio page', async () => {
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
              character_id: null,
              asset_slot: null,
              source: 'studio',
              filename: 'v1.png',
              path: 'studio/job-x/v1.png',
              job_id: 'job-x',
              mtime: 0,
            },
          ],
        }),
      } as any);
    }) as any;
    const { container } = renderHome();
    await waitFor(() => {
      expect(container.querySelector('img')).toBeInTheDocument();
    });
    const link = screen.getByRole('link', { name: '查看出图页' });
    expect(link.getAttribute('href')).toBe('/studio');
  });

  it('documents the gallery source as recent character asset files', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({ ok: true, json: async () => ({ keys: [], default_alias: null }) } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
    });
    globalThis.fetch = fetchMock as any;
    renderHome();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/gallery/recent?limit=24');
    });
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
    const providerBtn = await screen.findByRole('button', { name: /选择厂商/ });
    // 厂商按钮在 /api/keys 加载完前 disabled（visibleProviders 为空）：点击 disabled
    // 按钮是 no-op、弹窗不开。必须等它启用再点（CI 慢环境下不等必现）。
    await waitFor(() => expect(providerBtn).toBeEnabled());
    fireEvent.click(providerBtn);
    // 弹窗 portal 后定位走 inline fixed：向下弹 = 设 top。
    const panel = await screen.findByRole('listbox', { name: '选择厂商列表' });
    expect(panel).toHaveAttribute('data-toolbar-popover');
    expect(panel.style.top).not.toBe('');
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

    const providerBtn = await screen.findByRole('button', { name: /选择厂商/ });
    // 厂商按钮在 /api/keys 加载完前 disabled（visibleProviders 为空）：点击 disabled
    // 按钮是 no-op、弹窗不开。必须等它启用再点（CI 慢环境下不等必现）。
    await waitFor(() => expect(providerBtn).toBeEnabled());
    fireEvent.click(providerBtn);
    const providerPanel = await screen.findByRole('listbox', { name: '选择厂商列表' });
    expect(providerPanel).toHaveAttribute('data-toolbar-popover');
    expect(providerPanel.style.top).not.toBe('');

    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    const sizePanel = await screen.findByTestId('size-popover');
    expect(sizePanel).toHaveAttribute('data-toolbar-popover');
    expect(sizePanel.style.top).not.toBe('');
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
    typePrompt(screen.getByLabelText('生图 prompt'), '首页提交跳转');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    await waitFor(() => expect(location.history).toContain('/studio'));
  });
});
