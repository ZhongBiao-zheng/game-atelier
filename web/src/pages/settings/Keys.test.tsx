import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { KeysPage } from './Keys';
import { KeyForm } from './KeyForm';

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

describe('KeyForm', () => {
  it('creates an official provider key with only API Key required', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'ark-test' }),
    });
    globalThis.fetch = fetchMock as any;
    const onCreated = vi.fn();

    render(<KeyForm onCreated={onCreated} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('别名（唯一）'), { target: { value: 'volcengine' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      alias: 'volcengine',
      provider: 'seedream',
      access_key: 'ark-test',
      secret_key: null,
    });
    expect(body.base_url).toBeNull();
  });

  it('creates a custom provider key with base URL and API Key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'sk-custom' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('别名（唯一）'), { target: { value: 'custom-image' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://ark.cn-beijing.volces.com/api/v3' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-custom' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      alias: 'custom-image',
      provider: 'custom',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      access_key: 'sk-custom',
    });
  });

  it('creates a key with custom model names and ids', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'ark-test' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('别名（唯一）'), { target: { value: 'volcengine' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
    fireEvent.change(screen.getByLabelText('模型名称 1'), { target: { value: '图片 5.0 Lite' } });
    fireEvent.change(screen.getByLabelText('模型 ID 1'), { target: { value: 'doubao-seedream-5-0-260128' } });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型名称 2'), { target: { value: '图片 4.7' } });
    fireEvent.change(screen.getByLabelText('模型 ID 2'), { target: { value: 'doubao-seedream-4-5-251128' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.models).toEqual([
      { name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' },
      { name: '图片 4.7', id: 'doubao-seedream-4-5-251128' },
    ]);
  });
});
