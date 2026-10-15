import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
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
    onOpenChange={vi.fn()} onSave={vi.fn()} onSubmit={onSubmit} />);
  const image = screen.getByRole('img', { name: '原图' });
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  fireEvent.load(image);
  return onSubmit;
}

describe('image editor', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.mocked(getCanvasImageEditSource).mockResolvedValue({ source_version_id: 'source', reason: null, mj: null });
    vi.mocked(previewCanvasEdit).mockResolvedValue({ plan_id: 'plan', regions: [] });
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
      references={[{ id: 'ref', title: '参考图', versionId: 'ref-version' }]} onOpenChange={vi.fn()} onSave={vi.fn()} onSubmit={onSubmit} />);
    const image = screen.getByRole('img', { name: '原图' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    fireEvent.change(screen.getByLabelText('替换参考素材'), { target: { value: 'ref:ref-version' } });
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
      options: { mode: 'inpaint' }, referenceNodeId: null, referenceVersionId: null,
    });
    expect(onSubmit.mock.calls[0][0].options).not.toHaveProperty('reference_node_id');
    expect(onSubmit.mock.calls[0][0].options).not.toHaveProperty('plan_id');
  });

  it('expands any image with EvoLink without applying regular model ratio or size limits', async () => {
    const onSubmit = vi.fn();
    render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
      keys={[evoKey]} initialDraft={null} initialMode="outpaint" busy={false} error={null}
      onOpenChange={vi.fn()} onSave={vi.fn()} onSubmit={onSubmit} />);
    const image = screen.getByRole('img', { name: '原图' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    fireEvent.change(screen.getByLabelText('目标宽度'), { target: { value: '4096' } });
    fireEvent.change(screen.getByLabelText('目标高度'), { target: { value: '1024' } });
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].options).toEqual({
      mode: 'outpaint', width: 4096, height: 1024, x: 1536, y: 0,
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
      mode: 'outpaint', width: 1536, height: 1024,
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
      onOpenChange={vi.fn()} onSave={vi.fn()} onSubmit={onSubmit} />);
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

  it('saves an incomplete draft without a model, selection or generation and closes cleanly', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(<CanvasMaskEditDialog open title="编辑" version={version} mediaUrl="/source.png" keys={[]}
      initialDraft={null} busy={false} error={null} onSave={onSave} onSubmit={onSubmit} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText('编辑提示词'), { target: { value: '先保存这个想法' } });
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({ mask: null, draft: { model: '', prompt: '先保存这个想法' },
      editorState: { native: false, strokes: [] }, referenceVersionId: null });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('关闭', { selector: 'button' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('尚未保存')).not.toBeInTheDocument();
  });

  it('requires an explicit discard when closing unsaved changes', () => {
    const onOpenChange = vi.fn();
    render(<CanvasMaskEditDialog open title="编辑" version={version} mediaUrl="/source.png" keys={[]}
      initialDraft={null} busy={false} error={null} onSave={vi.fn()} onSubmit={vi.fn()} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText('编辑提示词'), { target: { value: '未保存' } });
    fireEvent.click(screen.getByText('关闭', { selector: 'button' }));
    expect(screen.getByText('尚未保存')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('编辑提示词')).toHaveValue('未保存');
    fireEvent.click(screen.getByText('关闭', { selector: 'button' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('restores strokes and regional settings with the saved reference version after its node changes', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const data: CanvasImageEditNode['data'] = {
      source_node_id: null, source_version_id: 'source', mask_version_id: 'mask', active_run_id: null,
      reference_node_id: 'ref', reference_version_id: 'ref-old',
      generation_draft: { mode: 'image', model: 'gpt-image-2', alias: 'Tuzi', prompt: '替换花朵',
        input_policy: 'all_connected', params: { n: 3, quality: 'high' }, updated_at: version.created_at },
      options: { mode: 'inpaint', context: .5, feather: 12, groups: [[0, 1]], region_prompts: { '0-1': '红花' } },
      editor_state: { native: false, frame_ratio: '3:2', frame: { width: 1800, height: 1200, x: 300, y: 80 },
        strokes: [{ tool: 'rectangle', size: 20, points: [{ x: 10, y: 20 }, { x: 50, y: 60 }] }] },
    };
    render(<CanvasMaskEditDialog open title="编辑" version={version} mediaUrl="/source.png" keys={keys}
      initialData={data} initialDraft={data.generation_draft} references={[{ id: 'ref', versionId: 'ref-new', title: '参考' }]}
      busy={false} error={null} onSave={onSave} onSubmit={vi.fn()} onOpenChange={vi.fn()} />);
    const image = screen.getByRole('img', { name: '编辑' });
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    fireEvent.load(image);
    expect(screen.getByLabelText('候选数')).toHaveValue('3');
    expect(screen.getByLabelText('编辑质量')).toHaveValue('high');
    expect(screen.getByLabelText('替换参考素材')).toHaveValue('ref:ref-old');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({ mask: expect.any(Blob), options: data.options,
      editorState: data.editor_state, referenceNodeId: 'ref', referenceVersionId: 'ref-old',
      draft: { prompt: '替换花朵', params: { n: 3, quality: 'high' } } });
    fireEvent.click(screen.getByRole('button', { name: '扩图' }));
    expect(screen.getByLabelText('目标宽度')).toHaveValue(1800);
    expect(screen.getByLabelText('目标高度')).toHaveValue(1200);
    expect(screen.getByLabelText('扩图比例')).toHaveValue('3:2');
  });
});
