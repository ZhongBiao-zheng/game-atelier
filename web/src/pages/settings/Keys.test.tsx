import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { KeysPage } from './Keys';

const mockKey = {
  alias: 'lov',
  provider: 'lovart',
  access_key: 'ak...xx',
  secret_key: null,
  capabilities: ['portrait'],
  models: [],
  notes: '',
  created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
  is_default: true,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KeysPage', () => {
  it('renders empty state when no keys', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    });
    render(<KeysPage />);
    await waitFor(() =>
      expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument(),
    );
  });

  it('renders a key card with alias and provider', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [mockKey], default_alias: 'lov' }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText('lov')).toBeInTheDocument());
    expect(screen.getByText('lovart')).toBeInTheDocument();
    expect(screen.getByText('ak...xx')).toBeInTheDocument();
  });

  it('renders brass ★ with aria-label for default key', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [mockKey], default_alias: 'lov' }),
    });
    render(<KeysPage />);
    await waitFor(() =>
      expect(screen.getByLabelText('默认 Key')).toBeInTheDocument(),
    );
  });

  it('non-default key does not show ★', async () => {
    const nonDefault = { ...mockKey, alias: 'other', is_default: false };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [nonDefault], default_alias: 'lov' }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText('other')).toBeInTheDocument());
    expect(screen.queryByLabelText('默认 Key')).not.toBeInTheDocument();
  });

  it('delete button triggers window.prompt confirmation', async () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(null));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [mockKey], default_alias: 'lov' }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByLabelText('删除 lov')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('删除 lov'));
    expect(window.prompt).toHaveBeenCalledWith('输入 "lov" 确认删除');
  });

  it('delete aborts when prompt returns wrong alias', async () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('wrong'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [mockKey], default_alias: 'lov' }),
      });
    (globalThis.fetch as ReturnType<typeof vi.fn>) = fetchMock;
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByLabelText('删除 lov')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('删除 lov'));
    // fetch should NOT have been called for DELETE
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial listKeys
  });

  it('empty state shows + 新建 Key button', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument());
    expect(screen.getAllByText('+ 新建 Key').length).toBeGreaterThan(0);
  });
});
