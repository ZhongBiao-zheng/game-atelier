import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { CanvasMediaVersion } from '@/schema/canvas';
import { CanvasMaskEditDialog } from './CanvasMaskEditDialog';
import { getCanvasImageEditSource, previewCanvasEdit } from '@/api/canvas';
import { editSize, isEditModel } from './imageEditGeometry';

vi.mock('@/api/canvas', () => ({ getCanvasImageEditSource: vi.fn(), previewCanvasEdit: vi.fn() }));

const version: CanvasMediaVersion = {
  version_id: 'source', kind: 'image', path: 'source.png', mime_type: 'image/png',
  bytes: 1024, width: 1024, height: 1024, sha256: 'a'.repeat(64),
  created_at: '2026-09-09T00:00:00Z', origin: { kind: 'upload', upload_id: 'source' },
};
const keys: KeyView[] = [{
  alias: 'Tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com/v1', access_key: 'masked',
  secret_key: null, capabilities: [], notes: '', created_at: version.created_at,
  models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image', protocol: 'openai' }],
}];
const evoKey: KeyView = { ...keys[0], alias: 'EvoLink', provider: 'evolink', base_url: 'https://api.evolink.ai/v1',
  models: [{ id: 'mj-v8.2', name: 'Midjourney V8.2', modality: 'image', protocol: 'evolink' }],
};

function mount(mode: 'inpaint' | 'outpaint' = 'inpaint') {
  const onSubmit = vi.fn();
  render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
    keys={keys} initialDraft={null} initialMode={mode} busy={false} error={null}
    onOpenChange={vi.fn()} onSubmit={onSubmit} />);
  const image = screen.getByRole('img', { name: '原图' });
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  fireEvent.load(image);
  return onSubmit;
}

describe('image editor', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.mocked(getCanvasImageEditSource).mockResolvedValue({ source_version_id: 'source', reason: null, mj: null });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['mask'], { type: 'image/png' }));
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('accepts only EvoLink normal V8.2 for upload editing and keeps custom frame geometry', () => {
    expect(isEditModel(evoKey.models[0], evoKey)).toBe(true);
    expect(isEditModel({ ...evoKey.models[0], id: 'mj-v8.2-upload-paint' }, evoKey)).toBe(false);
    expect(isEditModel({ ...evoKey.models[0], protocol: 'mj' }, evoKey)).toBe(false);
    expect(editSize(evoKey, 'mj-v8.2', 4096, 1024)).toEqual({ params: {}, error: null });
    expect(editSize(keys[0], 'gpt-image-2', 4096, 1024).error).toContain('3:1');
  });

  it('edits an uploaded image with EvoLink using one native mask and four candidates', async () => {
    const onSubmit = vi.fn();
    render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
      keys={[...keys, evoKey]} projectId="p" nodeId="n" initialDraft={null} busy={false} error={null}
      references={[{ id: 'ref', title: '参考图' }]} onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    const image = screen.getByRole('img', { name: '原图' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    fireEvent.change(screen.getByLabelText('替换参考素材'), { target: { value: 'ref' } });
    fireEvent.change(screen.getByLabelText('编辑密钥'), { target: { value: 'EvoLink' } });
    expect(screen.getByLabelText('编辑模型')).toHaveValue('mj-v8.2');
    expect(screen.queryByLabelText('编辑方式')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('编辑质量')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('候选数')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('替换参考素材')).not.toBeInTheDocument();
    expect(screen.getByLabelText('编辑输出尺寸')).toHaveTextContent('4 张 · Fast');
    expect(screen.getByRole('status')).toHaveTextContent('预计 ¥0.84');
    const canvas = screen.getByLabelText('蒙版绘制区域');
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas);
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(previewCanvasEdit).not.toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ requestedCount: 4,
      draft: { alias: 'EvoLink', model: 'mj-v8.2', params: { n: 4 } },
      options: { mode: 'inpaint', source_version_id: 'source' },
    });
    expect(onSubmit.mock.calls[0][0].options).not.toHaveProperty('reference_node_id');
    expect(onSubmit.mock.calls[0][0].options).not.toHaveProperty('plan_id');
  });

  it('expands any image with EvoLink without applying regular model ratio or size limits', async () => {
    const onSubmit = vi.fn();
    render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
      keys={[evoKey]} initialDraft={null} initialMode="outpaint" busy={false} error={null}
      onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    const image = screen.getByRole('img', { name: '原图' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    fireEvent.change(screen.getByLabelText('目标宽度'), { target: { value: '4096' } });
    fireEvent.change(screen.getByLabelText('目标高度'), { target: { value: '1024' } });
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].options).toEqual({
      mode: 'outpaint', width: 4096, height: 1024, x: 1536, y: 0, source_version_id: 'source',
    });
    expect(onSubmit.mock.calls[0][0].draft.params).toEqual({ n: 4 });
    expect(onSubmit.mock.calls[0][0].requestedCount).toBe(4);
  });

  it('shows exact source dimensions instead of AUTO and blocks an empty selection', () => {
    mount();
    expect(screen.getByLabelText('编辑输出尺寸')).toHaveTextContent('1024 × 1024');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '矩形' })).toBeInTheDocument();
  });

  it('permits empty prompts for an expanded frame and freezes its geometry', async () => {
    const onSubmit = mount('outpaint');
    fireEvent.change(screen.getByLabelText('目标宽度'), { target: { value: '1536' } });
    fireEvent.change(screen.getByLabelText('目标高度'), { target: { value: '1024' } });
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].options).toMatchObject({
      mode: 'outpaint', width: 1536, height: 1024, source_version_id: 'source',
    });
    expect(onSubmit.mock.calls[0][0].draft.prompt).toBe('');
    expect(onSubmit.mock.calls[0][0].draft.params.size_mode).not.toBe('auto');
  });

  it('includes a 21:9 preset without allowing a frame to crop the original', () => {
    mount('outpaint');
    fireEvent.change(screen.getByLabelText('扩图比例'), { target: { value: '21:9' } });
    expect(Number((screen.getByLabelText('目标宽度') as HTMLInputElement).value)).toBeGreaterThan(1024);
    fireEvent.change(screen.getByLabelText('目标宽度'), { target: { value: '100' } });
    expect(screen.getByLabelText('扩图比例')).toHaveValue('');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
  });

  it('uses actual MJ buttons and makes preparation an explicit single task', async () => {
    vi.mocked(getCanvasImageEditSource).mockResolvedValue({ source_version_id: 'source', reason: null,
      mj: { alias: 'MJ 原渠道', model: 'midjourney', actions: [
        { kind: 'prepare', custom_id: 'MJ::JOB::upsample::2::source', label: '准备单图 U2' },
      ] } });
    const onSubmit = vi.fn();
    render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
      keys={keys} projectId="p" nodeId="n" initialDraft={null} busy={false} error={null}
      onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    const image = screen.getByRole('img', { name: '原图' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    fireEvent.change(await screen.findByLabelText('编辑方式'), { target: { value: 'mj' } });
    expect(screen.queryByLabelText('候选数')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '准备单图' }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ requestedCount: 1,
      options: { mode: 'prepare', custom_id: 'MJ::JOB::upsample::2::source' },
      draft: { alias: 'MJ 原渠道', model: 'midjourney', params: { n: 1 } },
    });
  });
});
