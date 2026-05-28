import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { FirstRunConfig } from './FirstRunConfig';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/home') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ home: '/Users/me' }),
      } as Response);
    }
    if (url === '/api/folder-picker') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ path: '/Users/me/game-ui-ai-workflow' }),
      } as Response);
    }
    if (url === '/api/onboarding/data-root') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ data_root: '/Users/me/game-ui-ai-workflow' }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  }));
});

describe('FirstRunConfig', () => {
  it('applies the selected project folder through the data-root API', async () => {
    const onSaved = vi.fn();
    render(<FirstRunConfig onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /选择项目文件夹/ }));
    await waitFor(() => {
      expect(screen.getByText('/Users/me/game-ui-ai-workflow')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));

    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/onboarding/data-root',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/Users/me/game-ui-ai-workflow' }),
        }),
      );
    });
    expect(onSaved).toHaveBeenCalledWith('/Users/me/game-ui-ai-workflow');
  });
});
