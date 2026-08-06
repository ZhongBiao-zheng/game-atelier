import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SettingsPage } from './Settings';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/onboarding/status') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'ready',
          data_root: '/Users/me/game-atelier',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: '',
        }),
      } as Response);
    }
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ keys: [], default_alias: null }),
      } as Response);
    }
    if (url === '/api/onboarding/data-root') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ data_root: '/Users/me/new-root' }),
      } as Response);
    }
    if (url === '/api/folder-picker') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ path: '/Users/me/new-root' }),
      } as Response);
    }
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ image_storage_root: '/Users/me/game-atelier', show_studio_on_home: false }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsPage', () => {
  it('shows and updates the project storage data root', async () => {
    render(<SettingsPage />);

    const path = await screen.findByLabelText('数据目录');
    expect(path).toHaveTextContent('/Users/me/game-atelier');
    // 保存按需浮现：路径未变更时不出现
    expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /更换文件夹/ }));
    await waitFor(() => expect(path).toHaveTextContent('/Users/me/new-root'));
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/onboarding/data-root',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/Users/me/new-root' }),
        }),
      );
    });
    expect(await screen.findByText('项目存放地址已更新，API Key 已重新读取新目录。')).toBeInTheDocument();
  });

  it('renders the show-studio-on-home switch and posts the toggle', async () => {
    render(<SettingsPage />);

    const toggle = await screen.findByRole('switch', { name: '展示 Studio 出图' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    // 乐观切换立即生效
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ show_studio_on_home: true }),
        }),
      );
    });
  });

  it('rolls the switch back when the config update fails', async () => {
    const baseFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500 } as Response);
      }
      return baseFetch(url, init);
    }));
    render(<SettingsPage />);

    const toggle = await screen.findByRole('switch', { name: '展示 Studio 出图' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });
});
