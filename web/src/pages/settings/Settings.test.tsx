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
        json: async () => ({ data_root: '/Users/me/character-workflow' }),
      } as Response);
    }
    if (url === '/api/folder-picker') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ path: '/Users/me/character-workflow' }),
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

    const input = await screen.findByLabelText('数据目录');
    expect(input).toHaveValue('/Users/me/game-atelier');

    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
    await waitFor(() => expect(input).toHaveValue('/Users/me/character-workflow'));
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/onboarding/data-root',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/Users/me/character-workflow' }),
        }),
      );
    });
    expect(await screen.findByText('项目存放地址已更新，API Key 已重新读取新目录。')).toBeInTheDocument();
  });
});
