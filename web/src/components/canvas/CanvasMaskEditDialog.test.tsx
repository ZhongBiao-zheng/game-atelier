import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyView } from '@/api/keys';
import type { CanvasMediaVersion } from '@/schema/canvas';
import { CanvasMaskEditDialog } from './CanvasMaskEditDialog';

const version: CanvasMediaVersion = {
  version_id: 'source', kind: 'image', path: 'source.png', mime_type: 'image/png',
  bytes: 1024, width: 512, height: 512, sha256: 'a'.repeat(64),
  created_at: '2026-09-09T00:00:00Z', origin: { kind: 'upload', upload_id: 'source' },
};

function key(alias: string, baseUrl: string): KeyView {
  return {
    alias, provider: 'custom', base_url: baseUrl, access_key: 'masked', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-09-09T00:00:00Z',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image', protocol: 'openai' }],
  };
}

function openDialog(keys: KeyView[], width = 1360, height = 2048) {
  const onSubmit = vi.fn();
  render(<CanvasMaskEditDialog open title="原图" version={version} mediaUrl="/source.png"
    keys={keys} initialDraft={null} busy={false} error={null} onOpenChange={vi.fn()} onSubmit={onSubmit} />);
  const image = screen.getByRole('img', { name: '原图' });
  Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  fireEvent.load(image);
  fireEvent.change(screen.getByLabelText('局部编辑提示词'), { target: { value: '换成木质建筑' } });
  return onSubmit;
}

describe('mask edit output size', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['mask'], { type: 'image/png' }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses real source pixels for a channel without verified AUTO support', async () => {
    const onSubmit = openDialog([key('Tuzi', 'https://api.tu-zi.com/v1')]);
    expect(screen.getByLabelText('局部编辑输出尺寸')).toHaveTextContent('1360×2048');
    fireEvent.click(screen.getByRole('button', { name: '生成局部编辑' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].draft.params).toMatchObject({
      size_mode: 'custom', size: '1360x2048', custom_size: '1360x2048',
    });
  });

  it('uses AUTO only for a verified channel and updates the summary when switching keys', async () => {
    const onSubmit = openDialog([key('Tuzi', 'https://api.tu-zi.com/v1'), key('HK', 'https://api.openai-hk.com')]);
    fireEvent.change(screen.getByLabelText('局部编辑密钥'), { target: { value: 'HK' } });
    expect(screen.getByLabelText('局部编辑输出尺寸')).toHaveTextContent('AUTO');
    fireEvent.click(screen.getByRole('button', { name: '生成局部编辑' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].draft.params).toMatchObject({ size_mode: 'auto', size: 'auto' });
  });

  it('previews normalized pixels before submitting custom source dimensions', async () => {
    const onSubmit = openDialog([key('Tuzi', 'https://api.tu-zi.com/v1')], 1361, 2049);
    expect(screen.getByLabelText('局部编辑输出尺寸')).toHaveTextContent('1360×2048');
    fireEvent.click(screen.getByRole('button', { name: '生成局部编辑' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].draft.params.size).toBe('1360x2048');
  });

  it('blocks unsupported source aspect ratios instead of silently changing the image', () => {
    const onSubmit = openDialog([key('Tuzi', 'https://api.tu-zi.com/v1')], 4000, 1000);
    expect(screen.getByRole('alert')).toHaveTextContent('不能超过 3:1');
    expect(screen.getByRole('button', { name: '生成局部编辑' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '生成局部编辑' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
