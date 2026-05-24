import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { KeysPage } from './Keys';

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

describe('KeysPage', () => {
  it('renders empty state when no keys', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    });
    render(<KeysPage />);
    await waitFor(() =>
      expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument(),
    );
  });

  it('lists keys with default badge', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [
          {
            alias: 'lov',
            provider: 'lovart',
            access_key: 'ak...xx',
            secret_key: null,
            capabilities: ['portrait'],
            models: [],
            notes: '',
            created_at: 'x',
            is_default: true,
          },
        ],
        default_alias: 'lov',
      }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText('lov')).toBeInTheDocument());
    expect(screen.getByText('默认')).toBeInTheDocument();
  });
});
