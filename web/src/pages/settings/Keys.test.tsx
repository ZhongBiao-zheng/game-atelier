import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

import { KeysPage } from './Keys';
import { KeyForm } from './KeyForm';

const mockKey = {
  alias: 'lov',
  provider: 'openai',
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
      expect(screen.getByText(/还没有配置供应商/)).toBeInTheDocument(),
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

  it('shows the official vendor name (中文) as the card title for known providers', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{ ...mockKey, alias: 'seedream', provider: 'seedream' }],
        default_alias: 'seedream',
      }),
    });
    render(<KeysPage />);
    // provider=seedream → 标题显示官方中文名「火山引擎」，alias 作为小标签保留
    await waitFor(() => expect(screen.getByText('火山引擎')).toBeInTheDocument());
    expect(screen.getByText('seedream')).toBeInTheDocument();
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

  it('empty state shows + 新建供应商 button', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText(/还没有配置供应商/)).toBeInTheDocument());
    expect(screen.getAllByText('+ 新建供应商').length).toBeGreaterThan(0);
  });

  it('shows success feedback without revealing the created key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [], default_alias: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ alias: 'seedream' }),
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

    await waitFor(() => expect(screen.getByText(/还没有配置供应商/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('+ 新建供应商')[0]);
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
      json: async () => ({ alias: 'seedream' }),
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
      json: async () => ({ alias: 'custom-image' }),
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

  it('creates a Volcengine provider with image and conversation models', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alias: 'seedream' }),
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
      modalities: ['image', 'llm'],
      notes: '',
    });
    expect(body.models).toContainEqual({
      name: '豆包 Seed 1.8',
      id: 'doubao-seed-1-8-251228',
      modality: 'text',
      protocol: 'openai-chat',
      input_modalities: ['text'],
    });
  });

  it('creates an OpenAI provider with image and conversation models', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alias: 'openai' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.modalities).toEqual(['image', 'llm']);
    expect(body.models).toContainEqual({
      name: 'GPT 5',
      id: 'gpt-5',
      modality: 'text',
      protocol: 'openai-responses',
      input_modalities: ['text'],
    });
  });

  it('routing UI is gone: no 路由范围/分类专用 controls on custom provider', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    expect(screen.queryByLabelText('路由范围')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('路由类别')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模型命中词')).not.toBeInTheDocument();
  });

  it('tags per-model modality on a custom key and derives key-level modalities', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alias: 'zz-mixed' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'zz-mixed' } });
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://api.example.com' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'zz-secret' } });
    fireEvent.change(screen.getByLabelText('模型名称 1'), { target: { value: 'GPT Image 2' } });
    fireEvent.change(screen.getByLabelText('模型 ID 1'), { target: { value: 'gpt-image-2' } });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型名称 2'), { target: { value: 'Sora 2' } });
    fireEvent.change(screen.getByLabelText('模型 ID 2'), { target: { value: 'sora-2' } });
    fireEvent.click(within(screen.getByLabelText('模型分类 2')).getByRole('button', { name: '视频' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // protocol 随模型一起提交（手填行没有上游标注 → null，由后端按启发式兜底）
    expect(body.models).toEqual([
      { name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image', protocol: null, input_modalities: [] },
      { name: 'Sora 2', id: 'sora-2', modality: 'video', protocol: null, input_modalities: [] },
    ]);
    expect(body.modalities).toEqual(['image', 'video']);
    expect(body.routing_scope).toBeUndefined();
  });

  it('visibly distinguishes model alias from model id', () => {
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

    expect(screen.getByText('模型别名')).toBeInTheDocument();
    expect(screen.getByText('模型 ID')).toBeInTheDocument();
    expect(screen.getByText('分类 / 输入')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('给人看的名字，例如：图片 5.0')).toHaveLength(2);
    expect(screen.getAllByPlaceholderText('请求里使用的 ID，例如：doubao-seedream-5-0-260128')).toHaveLength(2);
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
      json: async () => ({ alias: 'seedream' }),
    });
    globalThis.fetch = fetchMock as any;

    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
    fireEvent.click(screen.getByRole('button', { name: '删除模型 2' }));
    fireEvent.change(screen.getByLabelText('模型名称 1'), { target: { value: '图片 5.0 Lite' } });
    fireEvent.change(screen.getByLabelText('模型 ID 1'), { target: { value: 'doubao-seedream-5-0-260128' } });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型名称 2'), { target: { value: '图片 4.7' } });
    fireEvent.change(screen.getByLabelText('模型 ID 2'), { target: { value: 'doubao-seedream-4-5-251128' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.models).toEqual([
      { name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128', modality: 'image', protocol: null, input_modalities: [] },
      { name: '图片 4.7', id: 'doubao-seedream-4-5-251128', modality: 'image', protocol: null, input_modalities: [] },
    ]);
  });

  it('edit mode hides the provider picker and titles by preset label', () => {
    render(
      <KeyForm
        mode="edit"
        initial={{ alias: 'seedream', provider: 'seedream', access_key: 'ak...xx', models: [] }}
        onCreated={() => {}}
        onCancel={() => {}}
        submitLabel="保存修改"
      />,
    );
    // 编辑态不渲染供应商选择轨道 / 移动端下拉——避免误导性 hover
    expect(screen.queryByRole('group', { name: '供应商列表' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('供应商选择')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('编辑 火山引擎');
  });

  it('edit mode titles a custom provider by its config alias, not OpenAI', () => {
    render(
      <KeyForm
        mode="edit"
        initial={{ alias: 'my-openrouter', provider: 'custom', base_url: 'https://x.test', access_key: 'sk...zz', models: [] }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('编辑 my-openrouter');
  });

  it('persists a custom provider billing group', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ alias: 'Tuzi' }) });
    globalThis.fetch = fetchMock as any;
    render(
      <KeyForm
        mode="edit"
        initial={{
          alias: 'Tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com',
          billing_group: 'default', access_key: 'sk...zz', models: [],
        }}
        onCreated={() => {}}
        onCancel={() => {}}
        submitLabel="保存修改"
      />,
    );

    expect(screen.getByLabelText('计费分组（可选）')).toHaveValue('default');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.billing_group).toBe('default');
  });

  it('edit mode locks existing models to a read-only category badge; new rows stay editable', () => {
    render(
      <KeyForm
        mode="edit"
        initial={{
          alias: 'zz', provider: 'custom', base_url: 'https://x.test', access_key: 'sk...zz',
          models: [{ name: 'Sora 2', id: 'sora-2', modality: 'video' }],
        }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    // 已存模型：分类是只读徽标（无切换按钮），显示「视频」
    const locked = screen.getByLabelText('模型分类 1');
    expect(within(locked).queryByRole('button')).not.toBeInTheDocument();
    expect(within(locked).getByText('视频')).toBeInTheDocument();
    // 新增行：分类仍可切换（图片/视频两个按钮）——撞 id 也不冻结，因为锁按行而非 id
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const fresh = screen.getByLabelText('模型分类 2');
    expect(within(fresh).getByRole('button', { name: '图片' })).toBeInTheDocument();
    expect(within(fresh).getByRole('button', { name: '视频' })).toBeInTheDocument();
  });

  it('editing an existing model id keeps its category locked (no unlock-by-edit)', () => {
    render(
      <KeyForm
        mode="edit"
        initial={{
          alias: 'zz', provider: 'custom', base_url: 'https://x.test', access_key: 'sk...zz',
          models: [{ name: 'Sora 2', id: 'sora-2', modality: 'video' }],
        }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('模型 ID 1'), { target: { value: 'sora-2-renamed' } });
    expect(within(screen.getByLabelText('模型分类 1')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('edit mode eye toggle reveals the stored plaintext via GET /reveal', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_key: 'sk-full-plaintext-revealed' }),
    });
    globalThis.fetch = fetchMock as any;

    render(
      <KeyForm
        mode="edit"
        initial={{ alias: 'zz', provider: 'custom', base_url: 'https://x.test', access_key: 'sk...zz', models: [] }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/keys/zz/reveal'));
    await waitFor(() => expect(input.value).toBe('sk-full-plaintext-revealed'));
    expect(input.type).toBe('text');
  });
});

/* —— 模型选择器：上游 78 个模型里 61 个是对话/语音/搜索类，选择器的价值全在「怎么把噪音
   压下去而不骗人」。下面每条都对应一个曾经真错过的行为。 —— */
describe('KeyForm 模型选择器', () => {
  type Row = {
    id: string;
    name?: string;
    modality?: 'image' | 'video';
    category?: 'image' | 'video' | 'unknown' | 'excluded';
    protocol?: string | null;
  };

  /** 拼一份 /api/keys/models-preview 响应（后端契约：models + total + excluded）。 */
  const previewBody = (rows: Row[], meta: { total?: number; excluded?: number } = {}) => ({
    models: rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      modality: r.modality ?? null,
      category: r.category ?? r.modality ?? 'unknown',
      protocol: r.protocol ?? null,
    })),
    total: meta.total ?? rows.length,
    excluded: meta.excluded ?? 0,
  });

  const previewCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/keys/models-preview'));
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
    JSON.parse(fetchMock.mock.calls.find(([u]) => u === url)![1].body);

  /** 按 URL 路由 fetch；preview 队列按调用顺序取，用尽后重复最后一份。 */
  const mockFetch = (...previews: ReturnType<typeof previewBody>[]) => {
    const queue = [...previews];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/keys/models-preview')) {
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        return { ok: true, json: async () => next };
      }
      return { ok: true, json: async () => ({ alias: 'zz' }) };
    });
    globalThis.fetch = fetchMock as any;
    return fetchMock;
  };

  /** 打开选择器。用 custom 供应商——模型行是空白的，不会被 preset 默认模型预勾干扰断言。 */
  const openPicker = async (...previews: ReturnType<typeof previewBody>[]) => {
    const fetchMock = mockFetch(...previews);
    render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'zz' } });
    fireEvent.change(screen.getByLabelText('API 请求地址'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-zz' } });
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await screen.findByRole('button', { name: '返回表单' });
    return fetchMock;
  };

  it('头部报出上游总数与被过滤条数，并给出「显示全部」逃生舱', async () => {
    await openPicker(previewBody(
      [{ id: 'seedream-5.0-pro', modality: 'image' }, { id: 'seedance-2.0', modality: 'video' }],
      { total: 78, excluded: 61 },
    ));

    expect(screen.getByText(/上游 78 个/)).toBeInTheDocument();
    expect(screen.getByText('已过滤 61 个不可生成模型')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示全部' })).toBeInTheDocument();
  });

  it('一条都没过滤时不显示过滤这段噪音', async () => {
    await openPicker(previewBody([{ id: 'seedream-5.0-pro', modality: 'image' }], { total: 1, excluded: 0 }));

    expect(screen.queryByText(/已过滤/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '显示全部' })).not.toBeInTheDocument();
  });

  it('「显示全部」带 include_all 重拉，且不清掉已勾选项', async () => {
    const fetchMock = await openPicker(
      previewBody([{ id: 'seedance-2.0', modality: 'video' }], { total: 3, excluded: 2 }),
      previewBody([
        { id: 'seedance-2.0', modality: 'video' },
        { id: 'glm-4.7', category: 'excluded' },
        { id: 'tts-1', category: 'excluded' },
      ], { total: 3, excluded: 0 }),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /seedance-2\.0/ }));
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }));

    await waitFor(() => expect(screen.getByText('已显示全部，含不可生成模型')).toBeInTheDocument());
    expect(JSON.parse(previewCalls(fetchMock)[0][1].body).include_all).toBe(false);
    expect(JSON.parse(previewCalls(fetchMock)[1][1].body).include_all).toBe(true);
    // 「不可生成」这一档只在全量态出现；重拉不该把刚点完的勾清掉
    expect(screen.getByRole('button', { name: '不可生成 2' })).toBeInTheDocument();
    expect(screen.getByText('已选 1 个模型')).toBeInTheDocument();
  });

  it('未识别模型必须显式二选一，不静默按图片入库', async () => {
    const fetchMock = await openPicker(previewBody([{ id: 'glm-4.7', category: 'unknown' }], { total: 1 }));

    fireEvent.click(screen.getByRole('checkbox', { name: /glm-4\.7/ }));
    // 手滑勾中一个聊天模型：不指定分类就不许放行（旧行为是静默变图片模型，出图时把
    // 它的 id 发给 /images/generations）
    expect(screen.getByRole('button', { name: '启用所选（1）' })).toBeDisabled();
    expect(screen.getByText('1 个未识别模型待指定分类')).toBeInTheDocument();

    const pick = screen.getByRole('group', { name: '分类 glm-4.7' });
    fireEvent.click(within(pick).getByRole('button', { name: '视频' }));
    // 二选一按钮不能被 label 激活行为顺带把勾选切掉（所以行不再整个包在 label 里）
    expect(screen.getByRole('checkbox', { name: /glm-4\.7/ })).toBeChecked();
    expect(screen.getByRole('button', { name: '启用所选（1）' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '启用所选（1）' }));

    // 落到表单后分类仍可改（picker 加进来的行不被 _locked 冻结）
    expect(within(screen.getByLabelText('模型分类 1')).getByRole('button', { name: '图片' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/keys')).toBe(true));
    expect(bodyOf(fetchMock, '/api/keys').models).toEqual([
      { name: 'glm-4.7', id: 'glm-4.7', modality: 'video', protocol: null, input_modalities: [] },
    ]);
  });

  it('「未识别」档按 category 判，不再叫「其他」', async () => {
    await openPicker(previewBody(
      [{ id: 'seedream-5.0-pro', modality: 'image' }, { id: 'mystery-model', category: 'unknown' }],
      { total: 2 },
    ));

    expect(screen.getByRole('button', { name: '未识别 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^其他/ })).not.toBeInTheDocument();
  });

  it('全选只吃当前筛选结果，清空一键归零', async () => {
    await openPicker(previewBody([
      { id: 'seedream-5.0-pro', modality: 'image' },
      { id: 'seedance-2.0', modality: 'video' },
      { id: 'veo-3.1', modality: 'video' },
    ], { total: 3 }));

    fireEvent.click(screen.getByRole('button', { name: '视频 2' }));
    fireEvent.click(screen.getByRole('button', { name: '全选当前 2 个' }));
    // 只勾中两个视频，图片模型没被带上
    expect(screen.getByText('已选 2 个模型')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /seedance-2\.0/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    expect(screen.getByText('已选 0 个模型')).toBeInTheDocument();
  });

  it('chip 计数跟随搜索词（否则搜完列表剩 2 行、chip 还写全部 4）', async () => {
    await openPicker(previewBody([
      { id: 'seedream-5.0-pro', modality: 'image' },
      { id: 'seedream-5.0-lite', modality: 'image' },
      { id: 'seedance-2.0', modality: 'video' },
      { id: 'mystery-model', category: 'unknown' },
    ], { total: 4 }));

    expect(screen.getByRole('button', { name: '全部 4' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: 'seedream' } });

    expect(screen.getByRole('button', { name: '全部 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '图片 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '视频 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '未识别 0' })).toBeInTheDocument();
  });

  it('重拉列表修好已启用模型的 protocol，但不覆盖手改过的模型别名', async () => {
    const fetchMock = mockFetch(previewBody(
      [{ id: 'seedream-5.0-pro', name: 'Seedream 5.0 Pro', modality: 'image', protocol: 'ark' }],
      { total: 1 },
    ));
    render(
      <KeyForm
        mode="edit"
        initial={{
          alias: 'tokendance', provider: 'tokendance', access_key: 'ak...xx',
          base_url: 'https://tokendance.space/gateway/v1',
          // protocol 存空 → 出图会打错端点；「重拉一次列表来修协议」必须真的修得动
          models: [{ name: '主力出图', id: 'seedream-5.0-pro', modality: 'image', protocol: null }],
        }}
        onCreated={() => {}}
        onCancel={() => {}}
        submitLabel="保存修改"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await screen.findByRole('button', { name: '返回表单' });
    // 已启用的模型自动预勾，直接「启用所选」即可回写
    expect(screen.getByRole('checkbox', { name: /seedream-5\.0-pro/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '启用所选（1）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/keys/tokendance')).toBe(true));
    expect(bodyOf(fetchMock, '/api/keys/tokendance').models).toEqual([
      { name: '主力出图', id: 'seedream-5.0-pro', modality: 'image', protocol: 'ark', input_modalities: [] },
    ]);
  });
});
