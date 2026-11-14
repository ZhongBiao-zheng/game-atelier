import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import cases from '../../../../tests/fixtures/http_protocol_cases.json';
import type { KeyView } from '@/api/keys';
import { declaredImageCaps } from '@/lib/imageControlCaps';
import { selectionImageCaps, withAutoProvider } from '@/lib/modelRoutes';
import { videoControlCaps } from '@/lib/videoControlCaps';
import { canvasGenerationModelSupportsMode } from '@/pages/canvasEditorModel';
import { estimateGenerationCost } from '@/lib/generationCost';
import type { DeclaredCapabilities, ModelDeclared } from '@/schema/httpProtocols';
import { chooseOption } from '@/test/select';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';
import { KeyForm } from './KeyForm';

const api = vi.hoisted(() => ({
  listHttpProtocols: vi.fn(),
  getHttpProtocol: vi.fn(),
  createHttpProtocol: vi.fn(),
  updateHttpProtocol: vi.fn(),
  deleteHttpProtocol: vi.fn(),
  validateHttpProtocol: vi.fn(),
}));
vi.mock('@/api/httpProtocols', () => api);

const IMAGE: DeclaredCapabilities = {
  kind: 'image', ratios: ['1:1', '3:4'], resolutions: ['1K', '2K'], durations: null,
  max_count: 2, reference_images: 3, frames: 0,
};
const VIDEO: DeclaredCapabilities = {
  kind: 'video', ratios: ['16:9'], resolutions: null, durations: [5, 10],
  max_count: 1, reference_images: 0, frames: 2,
};
const available = (caps: DeclaredCapabilities): ModelDeclared => ({ available: true, error: null, name: '接口', ...caps });

function customKey(models: KeyView['models'], provider = 'custom'): KeyView {
  return {
    alias: 'vendor', provider, base_url: 'https://api.example.com', access_key: 'sk-...x',
    secret_key: null, capabilities: [], notes: '', created_at: '', models,
  };
}

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset());
  api.listHttpProtocols.mockResolvedValue({ protocols: [
    { id: 'hp-aaaaaaaaaaaa', name: '同步出图', kind: 'image', available: true, error: null, declared: IMAGE, used_by: [] },
    { id: 'hp-bbbbbbbbbbbb', name: '视频任务', kind: 'video', available: true, error: null, declared: VIDEO, used_by: [] },
  ] });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('declared capabilities drive the controls', () => {
  it.each(cases.valid)('maps fixture $name the same way the server declared it', ({ declared }) => {
    const caps = declared as DeclaredCapabilities;
    if (caps.kind === 'image') {
      const image = declaredImageCaps(caps);
      expect(image.maxCount).toBe(caps.max_count);
      expect(image.maxRefImages).toBe(caps.reference_images);
      expect(image.ratios).toEqual(caps.ratios ?? []);
      expect(image.resolutions).toEqual(caps.resolutions ?? []);
      expect(image.qualities).toBeNull();
      expect(image.showCustomSize).toBe(false);
    } else {
      const video = videoControlCaps('anything', 'declarative', { available: true, error: null, name: 'x', ...caps });
      expect(video.durations).toEqual(caps.durations ?? []);
      expect(video.maxFrames).toBe(caps.frames);
      expect(video.supportsReferenceVideo).toBe(false);
    }
  });

  it('uses the template instead of guessing from the model id', () => {
    const key = customKey([{ id: 'gpt-image-2', name: 'x', modality: 'image', protocol: 'declarative',
      declarative_id: 'hp-aaaaaaaaaaaa', declared: available(IMAGE) }]);
    const caps = selectionImageCaps(key, 'gpt-image-2');
    expect(caps.qualities).toBeNull();
    expect(caps.ratios).toEqual(['1:1', '3:4']);
    expect(caps.sizeKind).toBe('ratio');
  });

  it('video templates without frames or references are text only', () => {
    const caps = videoControlCaps('m', 'declarative', available({ ...VIDEO, frames: 0, durations: null }));
    expect(caps).toMatchObject({ modes: ['firstlast'], maxFrames: 0, durations: [], maxRefImages: 0 });
  });

  it('hides models whose template is missing and copies declared onto 自动', () => {
    const keys = [customKey([
      { id: 'ok', name: 'ok', modality: 'image', protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa', declared: available(IMAGE) },
      { id: 'broken', name: 'broken', modality: 'image', protocol: 'declarative', declarative_id: 'hp-cccccccccccc',
        declared: { available: false, error: '自定义接口不存在', name: null } },
    ])];
    const route = { id: 'declarative:hp-aaaaaaaaaaaa:ok', name: 'ok', modality: 'image' as const, mode: 'order' as const,
      candidate_alias: null, members: [{ alias: 'vendor', provider: 'custom', base_url: null, model_id: 'ok', name: 'ok', protocol: 'declarative' }] };
    const [auto, vendor] = withAutoProvider(keys, [route]);
    expect(vendor.models.map(model => model.id)).toEqual(['ok']);
    expect(auto.models[0].declared).toEqual(available(IMAGE));
  });

  it('canvas accepts bound models only on custom providers', () => {
    const image = { id: 'm', name: 'm', modality: 'image' as const, protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa', declared: available(IMAGE) };
    const video = { id: 'v', name: 'v', modality: 'video' as const, protocol: 'declarative', declarative_id: 'hp-bbbbbbbbbbbb', declared: available(VIDEO) };
    expect(canvasGenerationModelSupportsMode(customKey([image]), image, 'image')).toBe(true);
    expect(canvasGenerationModelSupportsMode(customKey([video]), video, 'video')).toBe(true);
    expect(canvasGenerationModelSupportsMode(customKey([image], 'openai'), image, 'image')).toBe(false);
  });

  it('is never priced', () => {
    expect(estimateGenerationCost({
      kind: 'image', provider: { provider: 'custom', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      model: { id: 'doubao-seedream-5-0-260128', protocol: 'declarative' }, count: 2,
    })).toBeNull();
  });
});

describe('KeyForm interface binding', () => {
  const initial = {
    alias: 'vendor', provider: 'custom', base_url: 'https://api.example.com', access_key: 'sk-...x',
    capabilities: [], modalities: ['image'],
    models: [{ id: 'm1', name: 'M1', modality: 'image' as const, protocol: 'declarative',
      declarative_id: 'hp-aaaaaaaaaaaa', declared: available(IMAGE) }],
  };

  it('keeps the binding on save and can switch back to the default interface', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ alias: 'vendor' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<KeyForm mode="edit" initial={initial} onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText('模型详情'));
    const picker = await screen.findByLabelText('模型接口 1');
    await waitFor(() => expect(picker).toHaveTextContent('同步出图'));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const bound = JSON.parse(fetchMock.mock.calls[0][1].body).models[0];
    expect(bound).toMatchObject({ id: 'm1', protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa' });

    await chooseOption(picker, '默认接口');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const plain = JSON.parse(fetchMock.mock.calls[1][1].body).models[0];
    expect(plain.protocol).toBeNull();
    expect(plain).not.toHaveProperty('declarative_id');
  });

  it('only offers templates of the same kind', async () => {
    render(<KeyForm mode="edit" initial={initial} onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText('模型详情'));
    const picker = await screen.findByLabelText('模型接口 1');
    await waitFor(() => expect(picker).toHaveTextContent('同步出图'));
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(await screen.findByRole('option', { name: '新建自定义接口…' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '视频任务' })).not.toBeInTheDocument();
  });
});

describe('CustomInterfaceDialog', () => {
  it('shows issues and blocks saving until the server accepts the template', async () => {
    api.validateHttpProtocol.mockResolvedValue({
      valid: false, issues: [{ path: 'submit.path', message: '必须是以 / 开头的相对路径，不能写域名' }],
      declared: null, preview: null,
    });
    render(<CustomInterfaceDialog identifier={null} kind="image" onSaved={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('必须是以 / 开头的相对路径，不能写域名')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('接口模板'), { target: { value: '{ broken' } });
    expect(await screen.findByText('JSON')).toBeInTheDocument();
  });

  it('previews the request and saves the document', async () => {
    api.validateHttpProtocol.mockResolvedValue({
      valid: true, issues: [], declared: IMAGE,
      preview: { submit: { method: 'POST', url: 'https://api.example.com/v1/images/generations',
        headers: { Authorization: 'Bearer ***' }, body: { prompt: '示例提示词' } } },
    });
    api.createHttpProtocol.mockResolvedValue({ id: 'hp-dddddddddddd' });
    const onSaved = vi.fn();
    render(<CustomInterfaceDialog identifier={null} kind="image" baseUrl="https://api.example.com"
      onSaved={onSaved} onClose={() => {}} />);
    expect(await screen.findByText(/Bearer \*\*\*/)).toBeInTheDocument();
    expect(api.validateHttpProtocol).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image' }),
      { baseUrl: 'https://api.example.com', model: undefined });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'hp-dddddddddddd' }));
    expect(api.createHttpProtocol.mock.calls[0][0]).toMatchObject({ version: 1, kind: 'image' });
  });
});

describe('CustomInterfaceDialog examples', () => {
  it('starts from the first example of the kind and can switch', async () => {
    api.validateHttpProtocol.mockResolvedValue({ valid: true, issues: [], declared: IMAGE, preview: null });
    render(<CustomInterfaceDialog identifier={null} kind="image" onSaved={() => {}} onClose={() => {}} />);
    const editor = screen.getByLabelText('接口模板') as HTMLTextAreaElement;
    expect(JSON.parse(editor.value).name).toBe('OpenAI 兼容出图');
    await chooseOption(screen.getByLabelText('从示例开始'), '异步出图任务');
    expect(JSON.parse(editor.value).poll.path).toBe('/v1/tasks/${taskId}');
  });

  it('editing an existing interface offers no examples', () => {
    api.getHttpProtocol.mockReturnValue(new Promise(() => {}));
    render(<CustomInterfaceDialog identifier="hp-aaaaaaaaaaaa" kind="image" onSaved={() => {}} onClose={() => {}} />);
    expect(screen.queryByLabelText('从示例开始')).not.toBeInTheDocument();
  });
});
