import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { App } from './App';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App onboarding gate', () => {
  it('opens the home page when API keys have not been added yet', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'needs_first_key',
          data_root: '/tmp/workflow',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: 'add_key',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('作品集首页')).toBeInTheDocument();
    });
    expect(screen.queryByText(/还没有 API Key/)).not.toBeInTheDocument();
  });

  it('opens the app shell at 1024px width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ready',
          data_root: '/tmp/workflow',
          uv_path: null,
          venv_python: null,
          platform: 'darwin',
          next_action: 'open_app',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('作品集首页')).toBeInTheDocument();
    });
    expect(screen.getByText('Atelier')).toBeInTheDocument();
    expect(screen.queryByText(/请在桌面浏览器打开/)).not.toBeInTheDocument();
  });
});
