import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Studio } from './Studio';

/** contentEditable prompt 编辑器没有 .value：落 textContent + input 事件等效键入。 */
function typePrompt(editor: Element, value: string) {
  editor.textContent = value;
  fireEvent.input(editor);
}

beforeEach(() => {
  localStorage.clear();
  (globalThis.URL as any).createObjectURL ??= vi.fn(() => 'blob:test');
  (globalThis.URL as any).revokeObjectURL ??= vi.fn();
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'volc',
          keys: [
            {
              alias: 'volc',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [
                { name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' },
                { name: '图片 4.7', id: 'doubao-seedream-4-5-251128' },
              ],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: true,
            },
            {
              alias: 'oa',
              provider: 'openai',
              access_key: 'sk...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: false,
            },
          ],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => [],
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  }) as any;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// jsdom 没有 EventSource —— 用可手动触发事件的 stub 测 SSE 定向更新。
class TestEventSource {
  static last: TestEventSource | null = null;
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    TestEventSource.last = this;
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close() {}
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
}

function renderStudio() {
  const { hook } = memoryLocation({ path: '/studio', static: true });
  return render(
    <Router hook={hook}>
      <Studio />
    </Router>,
  );
}

function mockCompletedBatchAndKeys() {
  const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'volc',
          keys: [{
            alias: 'volc',
            provider: 'seedream',
            access_key: 'ark...key',
            secret_key: null,
            capabilities: ['portrait'],
            models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
            notes: '',
            created_at: '2026-05-25T00:00:00Z',
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
          character_id: 'volc',
          prompt: '一个身披白床单的幽灵般的身影在上海某城市公园的儿童游乐场玩耍，她戴着太阳镜，没有眼。背景是万圣节夜森。',
          submitted_at: '2026-05-27T01:00:00Z',
          model: 'doubao-seedream-4-5-251128',
          params: {
            ratio: '4:3',
            resolution: '2K',
            size: '2304x1728',
            n: 2,
            estimated_cost_cny: 0.5,
            actual_cost_cny: 0.63,
            reference_images: ['/tmp/ref.png'],
          },
          output_paths: ['/tmp/studio/job-studio-1/v1.png', '/tmp/studio/job-studio-1/v2.png'],
          status: 'done',
          error: null,
          kind: 'image',
          namespace: 'studio',
          alias: 'volc',
          provider: 'seedream',
        }],
      } as any);
    }
    if (String(url).startsWith('/api/jobs/job-studio-1/image')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
    }
    if (String(url).startsWith('/api/raw')) {
      return Promise.resolve({
        ok: true,
        blob: async () => new Blob(['reference'], { type: 'image/png' }),
      } as any);
    }
    if (url === '/api/studio/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          job_id: 'job-studio-2',
          status: 'pending',
          submitted_at: '2026-05-27T02:00:00Z',
        }),
      } as any);
    }
    if (url === '/api/jobs/job-studio-2') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          job_id: 'job-studio-2',
          status: 'failed',
          submitted_at: '2026-05-27T02:00:00Z',
          output_paths: [],
          error: 'test stop',
        }),
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

function renderStudioWithCompletedBatch() {
  mockCompletedBatchAndKeys();
  return renderStudio();
}

describe('Studio', () => {
  it('renders prompt input on studio page', () => {
    renderStudio();
    expect(screen.getByLabelText('生图 prompt')).toBeInTheDocument();
  });

  it('uses the responsive prompt shell on the studio page', () => {
    renderStudio();

    expect(screen.getByTestId('studio-prompt-shell')).toHaveClass(
      'min-h-[174px]',
      'h-auto',
      'pt-[14px]',
      'px-4',
      'pb-4',
    );
  });

  it('shows no example prompt chips when no rounds', () => {
    renderStudio();
    expect(screen.queryByText(/试试/)).not.toBeInTheDocument();
    expect(screen.queryByText(/soft cotton low-angle/)).not.toBeInTheDocument();
  });

  it('disables submit when prompt empty', () => {
    renderStudio();
    const submit = screen.getByLabelText('提交生成');
    expect(submit).toBeDisabled();
  });

  it('Cmd+Enter submits the prompt', async () => {
    renderStudio();
    await screen.findByText('火山引擎');
    const textarea = screen.getByLabelText('生图 prompt');
    typePrompt(textarea, 'test prompt');
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        '/api/studio/jobs',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('submits selected provider alias, model, ratio, and resolution options', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [
              {
                alias: 'volc',
                provider: 'seedream',
                access_key: 'ark...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [
                  { name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' },
                  { name: '图片 4.7', id: 'doubao-seedream-4-5-251128' },
                ],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
              {
                alias: 'oa',
                provider: 'openai',
                access_key: 'sk...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: false,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    // 默认即 seedream(volc)——standard 族，保留比例 + 2K/4K 分辨率控件。
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '16:9' }));
    fireEvent.click(screen.getByRole('option', { name: /超清 4K/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择出图数量/ }));
    fireEvent.click(screen.getByRole('option', { name: '3' }));

    const textarea = screen.getByLabelText('生图 prompt');
    typePrompt(textarea, '广西南宁城市海报');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    expect(studioCall?.[1]).toBeDefined();
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body).toMatchObject({
      prompt: '广西南宁城市海报',
      alias: 'volc',
      model: 'doubao-seedream-5-0-260128',
      params: {
        ratio: '16:9',
        resolution: '4K',
        size: '4096x2304',
        n: 3,
        estimated_cost_cny: 0.66,
      },
    });
  });

  // 隐藏的控件不能写进 params：后端 openrouter_image 会把 params.resolution 原样当 API 参数发出去，
  // 在别的 key 上选过 4K 就会被带过来按 4K 计费。同理 quality —— 只有真有该档位的族才发。
  it('openrouter 图片只发比例 size，不带 resolution / quality', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'or',
            keys: [
              {
                alias: 'or',
                provider: 'openrouter',
                access_key: 'sk-or...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: 'Gemini 3 Pro Image', id: 'google/gemini-3-pro-image' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j-or', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    typePrompt(await screen.findByLabelText('生图 prompt'), '一张风景');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('1:1'); // OpenRouter 收 aspect_ratio 比例串，不是像素
    expect(body.params).not.toHaveProperty('resolution');
    expect(body.params).not.toHaveProperty('quality');
  });

  it('Tuzi 固定 4K Nano Banana 只发比例，不让默认 low 覆盖型号档位', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'tuzi',
            keys: [{
              alias: 'tuzi',
              provider: 'custom',
              access_key: 'sk-tuzi...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: 'Nano Banana Pro 4K', id: 'nano-banana-pro-4k' }],
              notes: '',
              created_at: '2026-08-29T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j-4k', status: 'pending', submitted_at: '2026-08-29T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    typePrompt(await screen.findByLabelText('生图 prompt'), '一张竖版角色海报');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.model).toBe('nano-banana-pro-4k');
    expect(body.params.size).toBe('1:1');
    expect(body.params).not.toHaveProperty('resolution');
    expect(body.params).not.toHaveProperty('quality');
  });

  it('renders image count control beside size and submits the selected count', async () => {
    renderStudio();

    const sizeButton = await screen.findByRole('button', { name: /选择比例和分辨率/ });
    const countButton = screen.getByRole('button', { name: /选择出图数量/ });
    expect(sizeButton.parentElement?.nextElementSibling).toBe(countButton.parentElement);

    fireEvent.click(countButton);
    expect(screen.getByRole('listbox', { name: '选择出图数量列表' })).toHaveAttribute('data-toolbar-popover');
    fireEvent.click(screen.getByRole('option', { name: '4' }));
    expect(countButton).toHaveTextContent('4 张');

    typePrompt(screen.getByLabelText('生图 prompt'), '四张草图');
    fireEvent.click(screen.getByLabelText('提交生成'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.n).toBe(4);
  });

  it('restores saved provider/model but resets ratio/count to defaults on mount', async () => {
    localStorage.setItem(
      'studio:selection',
      JSON.stringify({
        providerAlias: 'oa',
        model: 'gpt-image-2',
        ratio: '16:9',
        resolution: '2K',
        count: 3,
        quality: 'medium',
      }),
    );
    renderStudio();

    // 不做任何下拉操作，直接提交 —— provider/model 仍从 localStorage 恢复，
    // 但出图配置（ratio/数量/质量）每次启动回默认（飙哥指定），不再回填上次选择。
    const textarea = await screen.findByLabelText('生图 prompt');
    typePrompt(textarea, '恢复测试');
    fireEvent.click(screen.getByLabelText('提交生成'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.alias).toBe('oa');
    expect(body.model).toBe('gpt-image-2');
    // 配置回默认：1:1 / 1 张，而非 localStorage 里的 16:9 / 3
    expect(body.params.ratio).toBe('1:1');
    expect(body.params.n).toBe(1);
  });

  it('persists selection changes to localStorage', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择出图数量/ }));
    fireEvent.click(screen.getByRole('option', { name: '4' }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('studio:selection') ?? '{}');
      expect(saved.count).toBe(4);
      expect(saved.providerAlias).toBe('volc');
    });
  });

  it('submits the same pixel size shown in the size panel', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [
              {
                alias: 'volc',
                provider: 'seedream',
                access_key: 'ark...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
              {
                alias: 'oa',
                provider: 'openai',
                access_key: 'sk...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: false,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    await screen.findByRole('button', { name: /选择厂商/ });
    fireEvent.click(screen.getByRole('button', { name: /选择厂商/ }));
    fireEvent.click(screen.getByRole('option', { name: /oa/ }));
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '16:9' }));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(2048);
    expect(screen.getByLabelText('输出高度')).toHaveValue(1152);

    typePrompt(screen.getByLabelText('生图 prompt'), '宽幅海报');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('2048x1152');
  });

  // 2026-08-14 画师侧现象：打开工作室，模型是 seedream-5.0-pro，尺寸面板显示 2048×2048，
  // 点一下比例才跳回正确的 2150×2150 —— 期间出的图真按 2048² 出，白丢约 10% 像素。
  // 根因不是渲染时机，是「用值反推意图」：旧代码拿存档尺寸和**当前**标准尺寸比，不等就当
  // 用户手动改过。PR #40 把 pro 的 2K 从 2048² 撑到上限 2150² 之后，历史存档里那个曾经
  // 标准的 2048² 就被追认成手动选择。改成存 customSizeManual 标记，只认用户亲手改的。
  function mockProKeys() {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'td',
            keys: [
              {
                alias: 'td',
                provider: 'tokendance',
                access_key: 'sk...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: 'Seedream 5.0 Pro', id: 'seedream-5.0-pro' }],
                notes: '',
                created_at: '2026-08-14T00:00:00Z',
                is_default: true,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') return Promise.resolve({ ok: true, json: async () => [] } as any);
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-08-14T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;
    return fetchMock;
  }

  function saveProSelection(extra: Record<string, unknown>) {
    localStorage.setItem(
      'studio:selection',
      JSON.stringify({
        providerAlias: 'td',
        model: 'seedream-5.0-pro',
        ratio: '1:1',
        resolution: '2K',
        customSize: '2048x2048',
        ...extra,
      }),
    );
  }

  it('ignores a stale auto-computed size in storage and shows the model standard on mount', async () => {
    mockProKeys();
    saveProSelection({}); // 无 customSizeManual：旧版本存档 / 自动算出来的尺寸

    renderStudio();

    // 关键：**不做任何点击改动**，只打开面板读数。修之前这里是 2048。
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    await waitFor(() => expect(screen.getByLabelText('输出宽度')).toHaveValue(2150));
    expect(screen.getByLabelText('输出高度')).toHaveValue(2150);
  });

  it('submits the model standard size, not the stale stored one, without any interaction', async () => {
    const fetchMock = mockProKeys();
    saveProSelection({});

    renderStudio();

    typePrompt(await screen.findByLabelText('生图 prompt'), '开箱即用');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(call![1]!.body));
    expect(body.params.size).toBe('2150x2150');
  });

  it('still restores a size the user actually typed', async () => {
    mockProKeys();
    saveProSelection({ customSizeManual: true });

    renderStudio();

    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    await waitFor(() => expect(screen.getByLabelText('输出宽度')).toHaveValue(2048));
    expect(screen.getByLabelText('输出高度')).toHaveValue(2048);
  });

  it('clamps a manually stored size that exceeds the current model cap', async () => {
    mockProKeys();
    // 4096x2304 = 9437184 像素，是 pro 上限 4624220 的两倍：换模型后原样套用必被上游拒。
    saveProSelection({ customSize: '4096x2304', customSizeManual: true });

    renderStudio();

    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    await waitFor(() => {
      const w = (screen.getByLabelText('输出宽度') as HTMLInputElement).valueAsNumber;
      const h = (screen.getByLabelText('输出高度') as HTMLInputElement).valueAsNumber;
      expect(w * h).toBeLessThanOrEqual(4624220);
      expect(w).toBeGreaterThan(h); // 仍是横构图，只是等比缩到上限内
    });
  });

  it('submits the valid Seedream 2K 3:4 size instead of the too-small 1536x2048 request', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [
              {
                alias: 'volc',
                provider: 'seedream',
                access_key: 'ark...key',
                secret_key: null,
                capabilities: ['portrait'],
                models: [{ name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '3:4' }));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(1728);
    expect(screen.getByLabelText('输出高度')).toHaveValue(2304);

    typePrompt(screen.getByLabelText('生图 prompt'), '竖版角色海报');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('1728x2304');
    expect(1728 * 2304).toBeGreaterThanOrEqual(3686400);
  });

  it('normalizes a custom Seedream 1296x1296 request to the minimum valid area', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [{
              alias: 'volc',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: '图片 5.0 Lite', id: 'doubao-seedream-5-0-260128' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '1296' } });
    expect(screen.getByLabelText('输出宽度')).toHaveValue(1920);
    expect(screen.getByLabelText('输出高度')).toHaveValue(1920);

    typePrompt(screen.getByLabelText('生图 prompt'), '方形角色头像');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('1920x1920');
  });

  it('opens prompt menus upward on the studio page', async () => {
    renderStudio();
    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    // 弹窗 portal 后定位走 inline fixed：向上弹 = 设 bottom、不设 top。
    const panel = screen.getByRole('listbox', { name: '选择厂商列表' });
    expect(panel).toHaveAttribute('data-toolbar-popover');
    expect(panel.style.bottom).not.toBe('');
    expect(panel.style.top).toBe('');
  });

  it('anchors prompt popovers to their selected trigger on the studio page', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByTestId('provider-control-wrap')).toHaveClass('relative');
    const providerPanel = screen.getByRole('listbox', { name: '选择厂商列表' });
    expect(providerPanel).toHaveAttribute('data-toolbar-popover');
    expect(providerPanel.style.bottom).not.toBe('');

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    expect(screen.getByTestId('model-control-wrap')).toHaveClass('relative');
    const modelPanel = screen.getByRole('listbox', { name: '选择模型列表' });
    expect(modelPanel).toHaveAttribute('data-toolbar-popover');
    expect(modelPanel.style.bottom).not.toBe('');

    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByTestId('size-control-wrap')).toHaveClass('relative');
    expect(screen.getByTestId('size-popover')).toHaveAttribute('data-toolbar-popover');
    expect(screen.getByTestId('size-popover').style.bottom).not.toBe('');
  });

  it('renders the size panel without smart ratio and with emphasized 1:1 option', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择比例和分辨率/ }));

    expect(screen.queryByRole('option', { name: '智能' })).not.toBeInTheDocument();
    expect(screen.getByTestId('size-popover')).toHaveClass('w-[320px]', 'p-3', 'border', 'bg-card');
    expect(screen.getByRole('listbox', { name: '选择比例' })).toHaveClass('grid', 'rounded-lg', 'bg-popover', 'p-1');
    expect(screen.getByRole('listbox', { name: '选择比例' }).firstElementChild).toHaveClass('h-[98px]', 'w-[296px]', 'grid-cols-[56px_1fr]');
    expect(screen.getByRole('option', { name: '1:1' })).toHaveClass('h-[90px]', 'w-[56px]', 'text-sm');
    expect(screen.getByTestId('side-ratio-grid')).toHaveClass('min-w-0', 'grid-cols-4', 'grid-rows-2');
    expect(screen.getByRole('option', { name: '4:3' })).toHaveClass('h-[43px]', 'w-full', 'text-sm');
    expect(screen.getByRole('listbox', { name: '选择分辨率' })).toHaveClass('h-9', 'p-0.5');
    expect(screen.getByRole('option', { name: /高清 2K/ })).toHaveClass('h-8', 'text-sm');
    expect(screen.getByLabelText('输出宽度').closest('div')?.parentElement).toHaveClass('w-[296px]');
    expect(screen.getByLabelText('输出宽度')).toHaveClass('text-xs', 'tabular-nums');
    expect(screen.getByLabelText('输出高度')).toHaveClass('text-xs', 'tabular-nums');
  });

  it('highlights prompt control buttons while their popovers are open', async () => {
    renderStudio();

    const providerButton = await screen.findByRole('button', { name: /选择厂商/ });
    fireEvent.click(providerButton);
    expect(providerButton).toHaveClass('bg-secondary');

    const modelButton = screen.getByRole('button', { name: /选择模型/ });
    fireEvent.click(modelButton);
    expect(modelButton).toHaveClass('bg-secondary');

    const sizeButton = screen.getByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(sizeButton);
    expect(sizeButton).toHaveClass('bg-secondary');
  });

  it('uses fixed width and row height for provider and model menus', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('w-[280px]', 'max-h-[400px]');
    expect(screen.getByRole('option', { name: /volc/ })).toHaveClass('h-[58px]', 'text-sm');

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    expect(screen.getByRole('listbox', { name: '选择模型列表' })).toHaveClass('w-[280px]', 'max-h-[400px]');
    expect(screen.getByRole('option', { name: /图片 5.0 Lite/ })).toHaveClass('h-[58px]', 'text-sm');
  });

  it('Enter without Cmd inserts newline (not submit)', () => {
    renderStudio();
    const textarea = screen.getByLabelText('生图 prompt');
    typePrompt(textarea, 'line1');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      '/api/studio/jobs',
      expect.any(Object),
    );
  });

  it('restores completed studio images from persisted jobs and exposes download links', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [{
              alias: 'volc',
              provider: 'seedream',
              access_key: 'ark...key',
              secret_key: null,
              capabilities: ['portrait'],
              models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
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
            character_id: 'volc',
            prompt: '城市海报',
            submitted_at: '2026-05-27T01:00:00Z',
            model: 'doubao-seedream-4-5-251128',
            params: {},
            output_paths: ['/Users/me/project/studio/job-studio-1/v1.png'],
            status: 'done',
            error: null,
            kind: 'image',
            namespace: 'studio',
            alias: 'volc',
            provider: 'seedream',
          }],
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudio();

    const image = await screen.findByRole('img', { name: '生成结果 1' });
    expect(image).toHaveAttribute(
      'src',
      '/api/gallery/image?path=%2FUsers%2Fme%2Fproject%2Fstudio%2Fjob-studio-1%2Fv1.png',
    );
    expect(screen.getByRole('link', { name: '下载生成结果 1' })).toHaveAttribute(
      'href',
      '/api/gallery/image?path=%2FUsers%2Fme%2Fproject%2Fstudio%2Fjob-studio-1%2Fv1.png',
    );
    expect(screen.queryByTestId('round-generation-cost')).toBeNull();
  });

  it('restores a pending studio job after returning to the page', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'oa',
            keys: [{
              alias: 'oa',
              provider: 'openai',
              access_key: 'sk',
              secret_key: null,
              capabilities: [],
              models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-pending-1',
            character_id: 'oa',
            prompt: '刷新后仍在生成的画面',
            submitted_at: '2026-05-28T02:00:00Z',
            model: 'gpt-image-2',
            params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
            output_paths: [],
            status: 'pending',
            error: null,
            kind: 'image',
            namespace: 'studio',
            alias: 'oa',
            provider: 'openai',
          }],
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudio();

    expect(await screen.findByText('刷新后仍在生成的画面')).toBeInTheDocument();
    expect(screen.getByTestId('studio-pending-job-pending-1')).toBeInTheDocument();
  });

  it('flips a pending studio job to done via SSE targeted update (no 2s full polling)', async () => {
    vi.stubGlobal('EventSource', TestEventSource);
    TestEventSource.last = null;
    const firstJobs = [{
      job_id: 'job-pending-2',
      character_id: 'oa',
      prompt: '轮询完成的图',
      submitted_at: '2026-05-28T02:05:00Z',
      model: 'gpt-image-2',
      params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
      output_paths: [],
      status: 'pending',
      error: null,
      kind: 'image',
      namespace: 'studio',
      alias: 'oa',
      provider: 'openai',
    }];
    const doneJob = {
      ...firstJobs[0],
      status: 'done',
      output_paths: ['/tmp/studio/job-pending-2/v1.png'],
    };
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'oa',
            keys: [{
              alias: 'oa',
              provider: 'openai',
              access_key: 'sk',
              secret_key: null,
              capabilities: [],
              models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => firstJobs } as any);
      }
      // SSE 定向更新：按 job_id 拉单条，而不是全量 refetch。
      if (url === '/api/jobs/job-pending-2') {
        return Promise.resolve({ ok: true, json: async () => doneJob } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudio();
    expect(await screen.findByTestId('studio-pending-job-pending-2')).toBeInTheDocument();
    expect(TestEventSource.last).not.toBeNull();

    await act(async () => {
      TestEventSource.last!.emit('job-changed', { job_id: 'job-pending-2', status: 'done' });
    });

    await waitFor(() => {
      expect(screen.getByRole('img', { name: '生成结果 1' })).toHaveAttribute(
        'src',
        '/api/gallery/image?path=%2Ftmp%2Fstudio%2Fjob-pending-2%2Fv1.png',
      );
    });
    expect(screen.queryByTestId('studio-pending-job-pending-2')).not.toBeInTheDocument();
  });

  it('polls /api/jobs while a round is pending and flips it to done without any SSE (Windows 代理缓冲兜底)', async () => {
    // jsdom 无 EventSource → useSSE 直接 early-return，这里不 stub → 隔离出兜底轮询单独路径：
    // 证明就算 SSE 完全不通（系统代理把流式响应缓冲死），pending 卡也能靠 4s 轮询自动翻面。
    vi.useFakeTimers();
    const pendingJob = {
      job_id: 'job-poll-1', character_id: 'oa', prompt: '代理缓冲下也要出图',
      submitted_at: '2026-06-01T02:00:00Z', model: 'gpt-image-2',
      params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
      output_paths: [] as string[], status: 'pending', error: null,
      kind: 'image', namespace: 'studio', alias: 'oa', provider: 'openai',
    };
    let jobs: unknown[] = [pendingJob];
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'oa',
            keys: [{
              alias: 'oa', provider: 'openai', access_key: 'sk', secret_key: null,
              capabilities: [], models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') return Promise.resolve({ ok: true, json: async () => jobs } as any);
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('studio-pending-job-poll-1')).toBeInTheDocument();

    // 后端出图完成（供应商 78s 出好），下一轮轮询应拉到 done 并翻面 —— 全程没有任何 SSE 事件。
    jobs = [{ ...pendingJob, status: 'done', output_paths: ['/tmp/studio/job-poll-1/v1.png'] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    expect(screen.getByRole('img', { name: '生成结果 1' })).toHaveAttribute(
      'src', '/api/gallery/image?path=%2Ftmp%2Fstudio%2Fjob-poll-1%2Fv1.png',
    );
    expect(screen.queryByTestId('studio-pending-job-poll-1')).not.toBeInTheDocument();
    const jobsCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/jobs').length;
    expect(jobsCalls).toBeGreaterThanOrEqual(2); // 首载 + 至少一次轮询
  });

  it('does not render the batch submitted time above studio results', async () => {
    renderStudioWithCompletedBatch();

    expect(await screen.findByText(/一个身披白床单/)).toBeInTheDocument();
    expect(screen.queryByText(/1:00:00/)).not.toBeInTheDocument();
  });

  it('renders a completed studio batch with metadata and action buttons', async () => {
    renderStudioWithCompletedBatch();

    // chip 化后提示词文本落在 <p line-clamp-2> 内的 span 里，断言上提到段落容器。
    expect((await screen.findByText(/一个身披白床单/)).closest('p')).toHaveClass('line-clamp-2');
    expect(screen.getByTestId('studio-round-list')).toHaveClass(
      'w-full',
      'min-w-[800px]',
      'max-w-[1024px]',
      'mx-auto',
      'text-left',
    );
    expect(screen.getByRole('img', { name: '参考素材' })).toHaveAttribute(
      'src',
      '/api/raw?path=%2Ftmp%2Fref.png&job_id=job-studio-1',
    );
    await waitFor(() => expect(screen.getAllByText(/图片 4.7/).length).toBeGreaterThan(0));
    expect(screen.getByText(/4:3/)).toBeInTheDocument();
    expect(screen.getByText(/2304x1728/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /生成结果/ })).toHaveLength(2);
    expect(screen.getByTestId('studio-result-thumb-1')).toHaveClass('w-[251.5px]');
    expect(screen.getByTestId('studio-result-thumb-2')).toHaveClass('w-[251.5px]');
    expect(screen.getByTestId('round-generation-cost')).toHaveTextContent('¥ 0.63');
    expect(screen.getByRole('button', { name: '重新编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再次生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
  });

  it('uses fixed batch action sizes and opens the more menu to the right', async () => {
    renderStudioWithCompletedBatch();

    expect(await screen.findByRole('button', { name: '重新编辑' })).toHaveClass('h-9', 'w-[94px]');
    expect(screen.getByRole('button', { name: '再次生成' })).toHaveClass('h-9', 'w-[94px]');
    expect(screen.getByRole('button', { name: '更多操作' })).toHaveClass('h-9', 'w-9');

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    expect(screen.getByTestId('studio-more-menu')).toHaveClass('absolute', 'left-full', 'top-0', 'ml-2');
    expect(screen.getByTestId('studio-more-menu')).toHaveClass('w-[195px]', 'rounded-xl', 'bg-glass', 'p-1');
    expect(screen.getByRole('button', { name: '删除该批次结果' })).toHaveClass('h-10', 'w-full', 'px-3', 'text-sm');
    expect(screen.getByTestId('studio-more-menu')).not.toHaveClass('top-full');
  });

  it('closes the more menu when clicking outside it', async () => {
    renderStudioWithCompletedBatch();

    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    expect(screen.getByTestId('studio-more-menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByTestId('studio-more-menu')).not.toBeInTheDocument());
  });

  it('re-edits a completed batch into the prompt input and restores controls', async () => {
    renderStudioWithCompletedBatch();

    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));

    await waitFor(() => {
      expect(screen.getByLabelText('生图 prompt').textContent).toContain('一个身披白床单');
    });
    expect(screen.getByTestId('reference-images-panel').querySelector('img')).not.toBeNull();
    const sizeButton = screen.getByRole('button', { name: '选择比例和分辨率' });
    expect(sizeButton).not.toHaveTextContent('4:3');
    expect(sizeButton).toHaveTextContent('2304');
    expect(sizeButton).toHaveTextContent('高清 2K');
  });

  it('keeps the current editor snapshot when a re-edit reference cannot be restored', async () => {
    const fetchMock = mockCompletedBatchAndKeys();
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith('/api/raw')) {
        return Promise.resolve(new Response('', { status: 403 }));
      }
      return defaultFetch(url, init);
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderStudio();

    const editor = screen.getByLabelText('生图 prompt');
    typePrompt(editor, '保留当前编辑内容');
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 403')));
    expect(editor.textContent).toContain('保留当前编辑内容');
    expect(editor.textContent).not.toContain('一个身披白床单');
  });

  it('regenerates a completed batch with the same config', async () => {
    const fetchMock = mockCompletedBatchAndKeys();
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: '再次生成' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url, init]) => url === '/api/studio/jobs' && init?.method === 'POST');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body).toMatchObject({
      prompt: expect.stringContaining('一个身披白床单'),
      alias: 'volc',
      model: 'doubao-seedream-4-5-251128',
      params: {
        ratio: '4:3',
        resolution: '2K',
        size: '2304x1728',
      },
    });
  });

  it('deletes every image in a completed batch through image delete endpoints', async () => {
    const fetchMock = mockCompletedBatchAndKeys();
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除该批次结果' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-studio-1/image?path=%2Ftmp%2Fstudio%2Fjob-studio-1%2Fv1.png', { method: 'DELETE' });
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-studio-1/image?path=%2Ftmp%2Fstudio%2Fjob-studio-1%2Fv2.png', { method: 'DELETE' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: '生成结果 1' })).not.toBeInTheDocument();
    });
  });

  it('deletes a persisted failed studio job from the page', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ default_alias: null, keys: [] }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-failed-1',
            character_id: 'seedream',
            prompt: '失败提示词',
            submitted_at: '2026-05-27T02:00:00Z',
            model: 'doubao',
            params: {},
            output_paths: [],
            status: 'failed',
            error: 'provider timeout',
            kind: 'image',
            namespace: 'studio',
            alias: 'seedream',
            provider: 'seedream',
          }],
        } as any);
      }
      if (url === '/api/jobs/job-failed-1' && init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    expect(await screen.findByText('provider timeout')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除失败记录' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-failed-1', { method: 'DELETE' });
    });
    await waitFor(() => {
      expect(screen.queryByText('provider timeout')).not.toBeInTheDocument();
    });
  });

  it('shows prompt and action buttons on a failed round card', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [{
              alias: 'volc', provider: 'seedream', access_key: 'ak', secret_key: null,
              capabilities: [], models: [{ name: '图片 4.7', id: 'doubao-4.7' }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-fail-2', character_id: 'volc',
            prompt: '失败的幻想世界', submitted_at: '2026-05-28T01:00:00Z',
            model: 'doubao-4.7', alias: 'volc', provider: 'seedream',
            params: { ratio: '3:4', resolution: '2K', size: '1728x2304' },
            output_paths: [], status: 'failed',
            error: 'API 调用超时', kind: 'image', namespace: 'studio',
          }],
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudio();

    expect(await screen.findByText('失败的幻想世界')).toBeInTheDocument();
    expect(screen.getByText('API 调用超时')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再次生成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除失败记录' })).toBeInTheDocument();
  });

  it('adjusts height when width is edited with ratio locked', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'oa',
            keys: [{
              alias: 'oa', provider: 'openai', access_key: 'sk', secret_key: null,
              capabilities: [], models: [{ name: '图片', id: 'std-image' }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '4:3' }));

    expect(screen.getByLabelText('输出宽度')).toHaveValue(2048);
    expect(screen.getByLabelText('输出高度')).toHaveValue(1536);

    fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '2000' } });
    expect(screen.getByLabelText('输出高度')).toHaveValue(1500);
  });

  it('submits custom dimensions when W/H are manually edited', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'oa',
            keys: [{
              alias: 'oa', provider: 'openai', access_key: 'sk', secret_key: null,
              capabilities: [], models: [{ name: '图片', id: 'std-image' }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
      } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('button', { name: '解除比例锁定' }));
    fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '1920' } });
    fireEvent.change(screen.getByLabelText('输出高度'), { target: { value: '1080' } });

    typePrompt(screen.getByLabelText('生图 prompt'), '自定义尺寸测试');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(call![1]!.body));
    expect(body.params.size).toBe('1920x1080');
  });

  it('ControlButton shows pixel dimensions instead of ratio after ratio is selected', async () => {
    renderStudio();
    await screen.findByRole('button', { name: /选择比例和分辨率/ });
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '16:9' }));

    const sizeButton = screen.getByRole('button', { name: /选择比例和分辨率/ });
    expect(sizeButton).not.toHaveTextContent('16:9');
    expect(sizeButton).toHaveTextContent('高清 2K');
    expect(sizeButton).toHaveTextContent('2560');
  });
});

describe('Studio video submission', () => {
  it('submits a video job with kind=video and video params', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [
              {
                alias: 'volc',
                provider: 'seedream',
                access_key: 'ark...key',
                secret_key: null,
                capabilities: ['portrait'],
                modalities: ['image'],
                models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
              {
                alias: 'vvolc',
                provider: 'volcengine_video',
                access_key: 'ark...vkey',
                secret_key: null,
                capabilities: [],
                modalities: ['video'],
                models: [{ name: 'Seedance 2.0 Fast', id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: false,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            job_id: 'job-v1', character_id: '', prompt: 'p', submitted_at: new Date().toISOString(),
            model: 'doubao-seedance-2-0-fast-260128', params: {}, output_paths: [],
            status: 'pending', error: null, kind: 'video', namespace: 'studio',
          }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    // 切到视频生成（kind 弹窗）→ provider 自动收敛到声明了 video 能力的 key（vvolc / seedance 模型）。
    fireEvent.click(await screen.findByRole('button', { name: '选择生成模式' }));
    fireEvent.click(screen.getByRole('option', { name: /视频生成/ }));

    const textarea = screen.getByLabelText('生图 prompt');
    typePrompt(textarea, '一段电影质感的镜头');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body).toMatchObject({
      kind: 'video',
      // 上游 generate_audio 默认 true：音频关闭也必须显式发 false，省略字段≠关闭。
      params: expect.objectContaining({
        duration: 5,
        resolution: '720p',
        generate_audio: false,
        estimated_cost_cny: 3.996,
      }),
    });
  });

  it('submits an i2v video job with a reference image → params.reference_images + frame_mode', async () => {
    if (!URL.createObjectURL) {
      (URL as any).createObjectURL = () => 'blob:stub';
      (URL as any).revokeObjectURL = () => {};
    }
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'vvolc',
            keys: [
              {
                alias: 'vvolc',
                provider: 'volcengine_video',
                access_key: 'ark...vkey',
                secret_key: null,
                capabilities: [],
                modalities: ['video'],
                models: [{ name: 'Seedance 2.0 Fast', id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      if (url === '/api/uploads') {
        return Promise.resolve({ ok: true, json: async () => ({ path: '/uploads/ref-first.png' }) } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            job_id: 'job-v2', character_id: '', prompt: 'p', submitted_at: new Date().toISOString(),
            model: 'doubao-seedance-2-0-fast-260128', params: {}, output_paths: [],
            status: 'pending', error: null, kind: 'video', namespace: 'studio',
          }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    // 切到视频生成（kind 弹窗）→ 默认生成方式=首尾帧，渲染「上传首帧/尾帧」双槽。
    fireEvent.click(await screen.findByRole('button', { name: '选择生成模式' }));
    fireEvent.click(screen.getByRole('option', { name: /视频生成/ }));

    // 通过 label htmlFor 拿到 首帧 槽的 file input，附一张参考图。
    const srcLabel = await screen.findByLabelText('上传首帧');
    const inputId = srcLabel.getAttribute('for')!;
    const srcInput = document.getElementById(inputId) as HTMLInputElement;
    const refFile = new File(['x'], 'first.png', { type: 'image/png' });
    fireEvent.change(srcInput, { target: { files: [refFile] } });

    const textarea = screen.getByLabelText('生图 prompt');
    typePrompt(textarea, '一段电影质感的镜头');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    // frame_mode 按帧数推导：仅首帧 → first。
    expect(body.params.reference_images).toEqual(['/uploads/ref-first.png']);
    expect(body.params.frame_mode).toBe('first');
  });

  it('blocks last-frame-only submission for Seedance（尾帧必须配首帧）', async () => {
    if (!URL.createObjectURL) {
      (URL as any).createObjectURL = () => 'blob:stub';
      (URL as any).revokeObjectURL = () => {};
    }
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'vvolc',
            keys: [
              {
                alias: 'vvolc',
                provider: 'volcengine_video',
                access_key: 'ark...vkey',
                secret_key: null,
                capabilities: [],
                modalities: ['video'],
                models: [{ name: 'Seedance 2.0 Fast', id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' }],
                notes: '',
                created_at: '2026-05-25T00:00:00Z',
                is_default: true,
              },
            ],
          }),
        } as any);
      }
      if (url === '/api/jobs') {
        return Promise.resolve({ ok: true, json: async () => [] } as any);
      }
      if (url === '/api/uploads') {
        return Promise.resolve({ ok: true, json: async () => ({ path: '/uploads/ref-last.png' }) } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            job_id: 'job-v3', character_id: '', prompt: 'p', submitted_at: new Date().toISOString(),
            model: 'doubao-seedance-2-0-fast-260128', params: {}, output_paths: [],
            status: 'pending', error: null, kind: 'video', namespace: 'studio',
          }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: '选择生成模式' }));
    fireEvent.click(screen.getByRole('option', { name: /视频生成/ }));

    // 只填尾帧（首帧留空）—— Seedance 不支持，应被客户端拦下：提示出现 + 提交禁用 + 不发出图请求。
    const lastLabel = await screen.findByLabelText('上传尾帧');
    const inputId = lastLabel.getAttribute('for')!;
    const lastInput = document.getElementById(inputId) as HTMLInputElement;
    fireEvent.change(lastInput, { target: { files: [new File(['y'], 'last.png', { type: 'image/png' })] } });

    typePrompt(screen.getByLabelText('生图 prompt'), '收束到这一帧');

    expect(await screen.findByTestId('frame-block-hint')).toBeInTheDocument();
    const submitBtn = screen.getByLabelText('提交生成') as HTMLButtonElement;
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object));
  });

  it('regenerates a video job with the full original params, not the current form state', async () => {
    // 原 job：10s / 1080p / 9:16 / 首帧 / 带音频 / 三类参考资产 —— 表单默认值全是另一套（5s/720p/16:9/auto）。
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'vvolc',
            keys: [{
              alias: 'vvolc',
              provider: 'volcengine_video',
              access_key: 'ark...vkey',
              secret_key: null,
              capabilities: [],
              modalities: ['video'],
              models: [{ name: 'Seedance 2.0 Fast', id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' }],
              notes: '',
              created_at: '2026-05-25T00:00:00Z',
              is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs' && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-video-done',
            character_id: '',
            prompt: '镜头缓缓推进',
            submitted_at: '2026-06-09T01:00:00Z',
            model: 'doubao-seedance-2-0-fast-260128',
            params: {
              duration: 10,
              resolution: '1080p',
              ratio: '9:16',
              frame_mode: 'first',
              generate_audio: true,
              reference_images: ['/uploads/first.png'],
              reference_videos: ['https://cdn.x/ref.mp4'],
              reference_audios: ['https://cdn.x/ref.mp3'],
            },
            output_paths: ['/tmp/studio/job-video-done/v1.mp4'],
            status: 'done',
            error: null,
            kind: 'video',
            namespace: 'studio',
            alias: 'vvolc',
            provider: 'volcengine_video',
          }],
        } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            job_id: 'job-video-regen', character_id: '', prompt: '镜头缓缓推进',
            submitted_at: new Date().toISOString(),
            model: 'doubao-seedance-2-0-fast-260128', params: {}, output_paths: [],
            status: 'pending', error: null, kind: 'video', namespace: 'studio',
          }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: '再次生成' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.kind).toBe('video');
    expect(body.params).toMatchObject({
      duration: 10,
      resolution: '1080p',
      ratio: '9:16',
      frame_mode: 'first',
      generate_audio: true,
      reference_images: ['/uploads/first.png'],
      reference_videos: ['https://cdn.x/ref.mp4'],
      reference_audios: ['https://cdn.x/ref.mp3'],
    });
    // 没有任何文件需要重新上传 —— 参考资产复用服务器路径。
    expect(fetchMock).not.toHaveBeenCalledWith('/api/uploads', expect.any(Object));
  });

  it('re-edits a video job with its prompt and every omni reference asset', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'tokendance',
            keys: [{
              alias: 'tokendance', provider: 'tokendance', access_key: 'key', secret_key: null,
              capabilities: [], modalities: ['video'],
              models: [{ name: 'Seedance 2.0 Mini', id: 'seedance-2.0-mini', protocol: 'seedance' }],
              notes: '', created_at: '2026-08-22T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/jobs' && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-video-edit', character_id: '',
            prompt: '曹操@图片1 参考@视频1，配合@音频1。',
            submitted_at: '2026-08-22T14:35:52Z', model: 'seedance-2.0-mini',
            params: {
              duration: 15, resolution: '720p', ratio: '9:16',
              reference_images: ['/characters/cao-cao/portrait/v1.png'],
              reference_videos: ['https://cdn.example/reference.mp4'],
              reference_audios: ['/runtime/uploads/reference.mp3'],
            },
            output_paths: ['/projects/ma-jiang-you-xi/videos/triple-win-chaos/versions/v1.mp4'],
            status: 'done', error: null, kind: 'video', namespace: 'video',
            alias: 'tokendance', provider: 'tokendance', project_id: 'p-975dcbf4f3',
            production_id: 'triple-win-chaos',
          }],
        } as any);
      }
      if (href.startsWith('/api/raw') || href.startsWith('https://cdn.example/')) {
        const type = href.includes('.mp4') ? 'video/mp4' : href.includes('.mp3') ? 'audio/mpeg' : 'image/png';
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(['reference'], { type }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;

    renderStudio();
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));

    const editor = screen.getByLabelText('生图 prompt');
    await waitFor(() => {
      expect(editor.querySelector('[data-mention="图1"]')).not.toBeNull();
      expect(editor.querySelector('[data-mention="视频1"]')).not.toBeNull();
      expect(editor.querySelector('[data-mention="音频1"]')).not.toBeNull();
    });
    const panel = screen.getByTestId('reference-images-panel');
    expect(panel.textContent).toContain('图1');
    expect(panel.textContent).toContain('视频1');
    expect(panel.textContent).toContain('音频1');
    expect(fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl).startsWith('/api/raw'))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/reference.mp4');
  });
});

describe('Studio compact mode errors', () => {
  function renderStudioCompact() {
    const { hook } = memoryLocation({ path: '/', static: true });
    return render(
      <Router hook={hook}>
        <Studio compact />
      </Router>,
    );
  }

  it('shows an inline error when compact submission fails instead of failing silently', async () => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [{
              alias: 'volc', provider: 'seedream', access_key: 'ak', secret_key: null,
              capabilities: [], models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudioCompact();

    const textarea = await screen.findByLabelText('生图 prompt');
    typePrompt(textarea, '失败也要有反馈');
    fireEvent.click(screen.getByLabelText('提交生成'));

    const alert = await screen.findByRole('alert');
    // 报错要说清是哪一步失败 + 状态码（英文 `studio job failed: 500` 那种对画师没用）
    expect(alert).toHaveTextContent('创建出图任务失败');
    expect(alert).toHaveTextContent('500');
  });

  it('freezes the same CNY cost snapshot when submitting from compact mode', async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      if (url === '/api/keys') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            default_alias: 'volc',
            keys: [{
              alias: 'volc', provider: 'seedream', base_url: null,
              access_key: 'ak', secret_key: null, capabilities: [],
              models: [{
                name: '图片 4.5', id: 'doubao-seedream-4-5-251128', protocol: 'ark',
              }],
              notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
            }],
          }),
        } as any);
      }
      if (url === '/api/studio/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            job_id: 'compact-priced', status: 'pending', submitted_at: '2026-08-28T00:00:00Z',
          }),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    });
    globalThis.fetch = fetchMock as any;
    renderStudioCompact();

    const textarea = await screen.findByLabelText('生图 prompt');
    typePrompt(textarea, '首页也要记录费用');
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const request = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(request![1]!.body));
    expect(body.params.estimated_cost_cny).toBe(0.25);
  });
});

describe('Studio 首页深链定位（?job=）', () => {
  it('目标轮加载后 scrollIntoView 定位（无高亮环，避免推移布局）', async () => {
    mockCompletedBatchAndKeys();
    // jsdom 不实现 scrollIntoView，补个 spy 断言定位动作真的发生。
    const scrollSpy = vi.fn();
    (Element.prototype as any).scrollIntoView = scrollSpy;
    const { hook, searchHook } = memoryLocation({ path: '/studio?job=job-studio-1', static: true });
    const { container } = render(
      <Router hook={hook} searchHook={searchHook}>
        <Studio />
      </Router>,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-round-job="job-studio-1"]')).not.toBeNull();
    });
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(container.querySelector('[data-round-job="job-studio-1"]')!.className).not.toContain('ring-primary');
  });

  it('无 ?job= 参数时不定位', async () => {
    mockCompletedBatchAndKeys();
    const scrollSpy = vi.fn();
    (Element.prototype as any).scrollIntoView = scrollSpy;
    const { container } = renderStudio();
    await waitFor(() => {
      expect(container.querySelector('[data-round-job="job-studio-1"]')).not.toBeNull();
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('Studio 图卡编辑导入参考图', () => {
  it('点编辑取图成功：参考图追加进输入框（缩略图出现）', async () => {
    const inner = mockCompletedBatchAndKeys();
    // 编辑取图走 /api/gallery/image → blob；其余请求回落通用 mock
    const fetchMock = vi.fn(((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith('/api/gallery/image')) {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(['fake-png'], { type: 'image/png' }),
        } as any);
      }
      return (inner as any)(url, init);
    }) as any);
    globalThis.fetch = fetchMock as any;
    (globalThis.URL as any).createObjectURL ??= vi.fn(() => 'blob:test');
    (globalThis.URL as any).revokeObjectURL ??= vi.fn();

    renderStudio();
    const editBtns = await screen.findAllByTitle('编辑（导入为参考图）');
    fireEvent.click(editBtns[0]);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/gallery/image?path='),
      );
    });
    // 追加成功且无失败提示
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('取图失败（源文件不在）：不弹提示、也不留半张参考图（飙哥指定：这条链路全程静默）', async () => {
    const inner = mockCompletedBatchAndKeys();
    const fetchMock = vi.fn(((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith('/api/gallery/image')) {
        return Promise.resolve({ ok: false, status: 403 } as any);
      }
      return (inner as any)(url, init);
    }) as any);
    globalThis.fetch = fetchMock as any;

    renderStudio();
    const editBtns = await screen.findAllByTitle('编辑（导入为参考图）');
    fireEvent.click(editBtns[0]);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/gallery/image?path='));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    // 空参考图槽还在（没有塞进半个坏文件）
    expect(screen.getByLabelText('添加参考图')).toBeInTheDocument();
  });
});
