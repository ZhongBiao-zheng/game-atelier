import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Studio } from './Studio';

beforeEach(() => {
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
});

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
            reference_images: ['/tmp/ref.png'],
          },
          seed: null,
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
    fireEvent.change(textarea, { target: { value: 'test prompt' } });
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

    await screen.findByRole('button', { name: /选择厂商/ });
    fireEvent.click(screen.getByRole('button', { name: /选择厂商/ }));
    fireEvent.click(screen.getByRole('option', { name: /oa/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    fireEvent.click(screen.getByRole('option', { name: /GPT Image 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    fireEvent.click(screen.getByRole('option', { name: '16:9' }));
    fireEvent.click(screen.getByRole('option', { name: /超清 4K/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择出图数量/ }));
    fireEvent.click(screen.getByRole('option', { name: '3' }));

    const textarea = screen.getByLabelText('生图 prompt');
    fireEvent.change(textarea, { target: { value: '广西南宁城市海报' } });
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    expect(studioCall?.[1]).toBeDefined();
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body).toMatchObject({
      prompt: '广西南宁城市海报',
      alias: 'oa',
      model: 'gpt-image-2',
      params: {
        ratio: '16:9',
        resolution: '4K',
        size: '4096x2304',
        n: 3,
      },
    });
  });

  it('renders image count control beside size and submits the selected count', async () => {
    renderStudio();

    const sizeButton = await screen.findByRole('button', { name: /选择比例和分辨率/ });
    const countButton = screen.getByRole('button', { name: /选择出图数量/ });
    expect(sizeButton.parentElement?.nextElementSibling).toBe(countButton.parentElement);

    fireEvent.click(countButton);
    expect(screen.getByRole('listbox', { name: '选择出图数量列表' })).toHaveClass('absolute');
    fireEvent.click(screen.getByRole('option', { name: '4' }));
    expect(countButton).toHaveTextContent('4 张');

    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '四张草图' } });
    fireEvent.click(screen.getByLabelText('提交生成'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.n).toBe(4);
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

    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '宽幅海报' } });
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('2048x1152');
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

    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '竖版角色海报' } });
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

    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '方形角色头像' } });
    fireEvent.click(screen.getByLabelText('提交生成'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
    const studioCall = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
    const body = JSON.parse(String(studioCall![1]!.body));
    expect(body.params.size).toBe('1920x1920');
  });

  it('opens prompt menus upward on the studio page', async () => {
    renderStudio();
    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('bottom-full');
  });

  it('anchors prompt popovers to their selected trigger on the studio page', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
    expect(screen.getByTestId('provider-control-wrap')).toHaveClass('relative');
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('absolute', 'left-0', 'bottom-full');
    expect(screen.getByRole('listbox', { name: '选择厂商列表' })).not.toHaveClass('sm:left-40');

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
    expect(screen.getByTestId('model-control-wrap')).toHaveClass('relative');
    expect(screen.getByRole('listbox', { name: '选择模型列表' })).toHaveClass('absolute', 'left-0', 'bottom-full');
    expect(screen.getByRole('listbox', { name: '选择模型列表' })).not.toHaveClass('sm:left-64');

    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByTestId('size-control-wrap')).toHaveClass('relative');
    expect(screen.getByTestId('size-popover')).toHaveClass('absolute', 'left-0', 'bottom-full');
    expect(screen.getByTestId('size-popover')).not.toHaveClass('sm:left-96');
  });

  it('renders the size panel without smart ratio and with emphasized 1:1 option', async () => {
    renderStudio();

    fireEvent.click(await screen.findByRole('button', { name: /选择比例和分辨率/ }));

    expect(screen.queryByRole('option', { name: '智能' })).not.toBeInTheDocument();
    expect(screen.getByTestId('size-popover')).toHaveClass('w-[320px]', 'p-3', 'ring-1');
    expect(screen.getByRole('listbox', { name: '选择比例' })).toHaveClass('grid', 'grid-cols-[56px_1fr]', 'h-[98px]', 'w-[296px]', 'p-1');
    expect(screen.getByRole('option', { name: '1:1' })).toHaveClass('h-[90px]', 'w-[56px]', 'text-sm');
    expect(screen.getByTestId('side-ratio-grid')).toHaveClass('min-w-0', 'grid-cols-4', 'grid-rows-2');
    expect(screen.getByRole('option', { name: '4:3' })).toHaveClass('h-[43px]', 'w-full', 'text-sm');
    expect(screen.getByRole('listbox', { name: '选择分辨率' })).toHaveClass('h-9', 'p-0.5');
    expect(screen.getByRole('option', { name: /高清 2K/ })).toHaveClass('h-8', 'text-sm');
    expect(screen.getByLabelText('输出宽度').closest('div')?.parentElement).toHaveClass('w-[296px]');
    expect(screen.getByLabelText('输出宽度')).toHaveClass('text-[12px]', 'tabular-nums');
    expect(screen.getByLabelText('输出高度')).toHaveClass('text-[12px]', 'tabular-nums');
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
    const textarea = screen.getByLabelText('生图 prompt') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'line1' } });
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
            seed: null,
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
            seed: null,
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

  it('refreshes persisted pending studio jobs until they become done', async () => {
    let intervalCallback: TimerHandler | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((callback: TimerHandler, timeout?: number) => {
      if (timeout === 2000) intervalCallback = callback;
      return 1;
    });
    vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
    const firstJobs = [{
      job_id: 'job-pending-2',
      character_id: 'oa',
      prompt: '轮询完成的图',
      submitted_at: '2026-05-28T02:05:00Z',
      model: 'gpt-image-2',
      params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
      seed: null,
      output_paths: [],
      status: 'pending',
      error: null,
      kind: 'image',
      namespace: 'studio',
      alias: 'oa',
      provider: 'openai',
    }];
    const secondJobs = [{
      ...firstJobs[0],
      status: 'done',
      output_paths: ['/tmp/studio/job-pending-2/v1.png'],
    }];
    let jobsCallCount = 0;
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
        jobsCallCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => (jobsCallCount >= 2 ? secondJobs : firstJobs),
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }) as any;

    renderStudio();
    expect(await screen.findByTestId('studio-pending-job-pending-2')).toBeInTheDocument();

    await act(async () => {
      if (typeof intervalCallback === 'function') intervalCallback();
    });

    await waitFor(() => {
      expect(screen.getByRole('img', { name: '生成结果 1' })).toHaveAttribute(
        'src',
        '/api/gallery/image?path=%2Ftmp%2Fstudio%2Fjob-pending-2%2Fv1.png',
      );
    });
    expect(screen.queryByTestId('studio-pending-job-pending-2')).not.toBeInTheDocument();
  });

  it('does not render the batch submitted time above studio results', async () => {
    renderStudioWithCompletedBatch();

    expect(await screen.findByText(/一个身披白床单/)).toBeInTheDocument();
    expect(screen.queryByText(/1:00:00/)).not.toBeInTheDocument();
  });

  it('renders a completed studio batch with metadata and action buttons', async () => {
    renderStudioWithCompletedBatch();

    expect(await screen.findByText(/一个身披白床单/)).toHaveClass('line-clamp-2');
    expect(screen.getByTestId('studio-round-list')).toHaveClass('max-w-[1024px]');
    expect(screen.getByRole('img', { name: '参考图' })).toHaveAttribute('src', '/api/gallery/image?path=%2Ftmp%2Fref.png');
    await waitFor(() => expect(screen.getAllByText(/图片 4.7/).length).toBeGreaterThan(0));
    expect(screen.getByText(/4:3/)).toBeInTheDocument();
    expect(screen.getByText(/2304x1728/)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /生成结果/ })).toHaveLength(2);
    expect(screen.getByTestId('studio-result-thumb-1')).toHaveClass('w-[251.5px]');
    expect(screen.getByTestId('studio-result-thumb-2')).toHaveClass('w-[251.5px]');
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
    expect(screen.getByTestId('studio-more-menu')).toHaveClass('w-[195px]', 'h-11', 'rounded-xl', 'bg-secondary', 'p-0');
    expect(screen.getByRole('button', { name: '删除该批次结果' })).toHaveClass('h-11', 'px-3', 'py-[9px]', 'text-[13px]');
    expect(screen.getByTestId('studio-more-menu')).not.toHaveClass('top-full');
  });

  it('re-edits a completed batch into the prompt input and restores controls', async () => {
    renderStudioWithCompletedBatch();

    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));

    expect((screen.getByLabelText('生图 prompt') as HTMLTextAreaElement).value).toContain('一个身披白床单');
    const sizeButton = screen.getByRole('button', { name: '选择比例和分辨率' });
    expect(sizeButton).not.toHaveTextContent('4:3');
    expect(sizeButton).toHaveTextContent('2304');
    expect(sizeButton).toHaveTextContent('高清 2K');
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
            seed: null,
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
            seed: null, output_paths: [], status: 'failed',
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
              capabilities: [], models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
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
              capabilities: [], models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
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

    fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '自定义尺寸测试' } });
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
