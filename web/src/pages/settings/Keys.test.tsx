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

  it('shows success feedback without revealing the created key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [], default_alias: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ secret_revealed: 'sk-created-secret' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          keys: [{ ...mockKey, alias: 'seedream', provider: 'seedream', access_key: 'sk...ret' }],
          default_alias: null,
        }),
      });
    globalThis.fetch = fetchMock as any;

    render(<KeysPage />);

    await waitFor(() => expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('+ 新建 Key')[0]);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-created-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByText('创建成功')).toBeInTheDocument());
    expect(screen.queryByText('新 Key 已创建')).not.toBeInTheDocument();
    expect(screen.queryByText('sk-created-secret')).not.toBeInTheDocument();
  });

  it('shows compact key card fields without provider metadata clutter', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{
          ...mockKey,
          alias: 'seedream-main',
          provider: 'seedream',
          base_url: 'https://ark.cn-beijing.volces.com/api/v3',
          homepage_url: 'https://www.volcengine.com',
          docs_url: 'https://www.volcengine.com/docs',
          modalities: ['image'],
          models: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }],
        }],
        default_alias: null,
      }),
    });

    render(<KeysPage />);

    await waitFor(() => expect(screen.getByText('seedream-main')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'https://www.volcengine.com' })).toHaveAttribute('href', 'https://www.volcengine.com');
    expect(screen.queryByText('image')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '文档' })).not.toBeInTheDocument();
    expect(screen.queryByText('1 个模型')).not.toBeInTheDocument();
  });

  it('falls back to API request URL when homepage is empty', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{
          ...mockKey,
          base_url: 'https://api.openai-hk.com',
          homepage_url: null,
        }],
        default_alias: null,
      }),
    });

    render(<KeysPage />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'https://api.openai-hk.com' })).toBeInTheDocument());
  });

  it('opens an edit form and PATCHes key updates without resending an unchanged masked secret', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          keys: [{
            ...mockKey,
            alias: 'openai-hk',
            provider: 'custom',
            base_url: 'https://api.openai-hk.com',
            access_key: 'sk-...old',
            homepage_url: null,
            models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
            routing_scope: 'classified',
            routing_category: 'gpt_image',
            routing_hints: ['gpt-image'],
          }],
          default_alias: null,
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ alias: 'openai-hk' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [], default_alias: null }),
      });
    globalThis.fetch = fetchMock as any;

    render(<KeysPage />);

    fireEvent.click(await screen.findByLabelText('编辑 openai-hk'));
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://api.openai-hk.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/keys/openai-hk', expect.objectContaining({ method: 'PATCH' })));
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.base_url).toBe('https://api.openai-hk.com/v1');
    expect(body.access_key).toBeUndefined();
    expect(await screen.findByText('已更新')).toBeInTheDocument();
  });
});

describe('KeyForm', () => {
  it('shows the streamlined official provider fields', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

    expect(screen.getByLabelText('供应商选择')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('模型名称 1')).toBeInTheDocument();
    expect(screen.queryByLabelText('供应商名称')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API 请求地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Secret Key/)).not.toBeInTheDocument();
    expect(screen.queryByText('图种能力')).not.toBeInTheDocument();
  });

  it('creates an official provider key with only API Key required', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'ark-test' }),
    });
    globalThis.fetch = fetchMock as any;
    const onCreated = vi.fn();

    render(<KeyForm onCreated={onCreated} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      alias: 'seedream',
      provider: 'seedream',
      access_key: 'ark-test',
      secret_key: null,
    });
    expect(body.base_url).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });

  it('creates a custom provider key with base URL and API Key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'sk-custom' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'custom-image' } });
    fireEvent.change(screen.getByLabelText('官网链接'), { target: { value: 'https://example.com' } });
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
      homepage_url: 'https://example.com',
      notes: '',
    });
  });

  it('labels custom provider as a named configuration that supports multiple instances', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });

    expect(screen.getByLabelText('配置名称')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：openrouter-image-main')).toBeInTheDocument();
    expect(screen.queryByLabelText('备注')).not.toBeInTheDocument();
    expect(screen.getByText('自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。')).toBeInTheDocument();
  });

  it('creates a third-party image provider with structured metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'ark-test' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      alias: 'seedream',
      provider: 'seedream',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      access_key: 'ark-test',
      homepage_url: 'https://www.volcengine.com',
      modalities: ['image'],
      notes: '',
    });
  });

  it('creates a custom classified key with routing metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'zz-secret' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'zz-gpt' } });
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://ai.t8star.org' } });
    fireEvent.change(screen.getByLabelText('路由范围'), { target: { value: 'classified' } });
    fireEvent.change(screen.getByLabelText('路由类别'), { target: { value: 'gpt_image' } });
    fireEvent.change(screen.getByLabelText('模型命中词'), { target: { value: 'gpt-image, gpt_image, gptimage' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'zz-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      alias: 'zz-gpt',
      provider: 'custom',
      base_url: 'https://ai.t8star.org',
      access_key: 'zz-secret',
      routing_scope: 'classified',
      routing_category: 'gpt_image',
      routing_hints: ['gpt-image', 'gpt_image', 'gptimage'],
    });
  });

  it('visibly distinguishes model alias from model id', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

    expect(screen.getByText('模型别名')).toBeInTheDocument();
    expect(screen.getByText('模型 ID')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('给人看的名字，例如：图片 5.0')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('请求里使用的 ID，例如：doubao-seedream-5-0-260128')).toBeInTheDocument();
  });

  it('shows API request URL examples instead of account-password style copy', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });

    expect(screen.getByLabelText('API 请求地址')).toHaveAttribute(
      'placeholder',
      '例如：https://api.openai-hk.com 或 https://ark.cn-beijing.volces.com/api/v3',
    );
    expect(screen.getByText('请求时会自动拼接图片接口；根域名会补 /v1/images/generations，填完整路径也会直接使用。')).toBeInTheDocument();
  });

  it('validates the custom API request URL from the test button', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: '测试' }));
    expect(screen.getByText('请输入完整的 HTTP(S) API 请求地址')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '测试' }));
    expect(screen.getByText('地址格式可用')).toBeInTheDocument();
  });

  it('creates a key with custom model names and ids', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'ark-test' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
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
