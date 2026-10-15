import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { CanvasMediaVersion } from '@/schema/canvas';
import { CanvasMaskEditDialog } from './CanvasMaskEditDialog';
import { getCanvasImageEditSource } from '@/api/canvas';

vi.mock('@/api/canvas', () => ({ getCanvasImageEditSource: vi.fn() }));

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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['mask'], { type: 'image/png' }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

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
