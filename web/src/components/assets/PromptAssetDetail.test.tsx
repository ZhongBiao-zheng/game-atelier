import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptAssetDetail } from './PromptAssetDetail';
import { AssetCard } from './CreationAssetCards';
import type { CreationAsset } from '@/schema/creationAssets';
const api = vi.hoisted(() => ({ uploadPromptPreviews: vi.fn(), deletePromptPreview: vi.fn(), reorderPromptPreviews: vi.fn() }));
vi.mock('@/api/creationAssets', async original => ({ ...await original<typeof import('@/api/creationAssets')>(), ...api }));
const asset: CreationAsset = { asset_id: 'prompt-a', kind: 'prompt', title: '角色', tags: ['线稿'], category: null,
  created_at: '', updated_at: '', last_used_at: null, use_count: 3, project_ids: [],
  content: { kind: 'prompt', segments: [{ kind: 'text', text: '绘制' }, { kind: 'variable', name: '主体', default_value: '白犬' }] } };
const previews = Array.from({ length: 8 }, (_, i) => ({ file: `${String(i).padStart(16, '0')}.png`, mime_type: 'image/png', width: 300, height: 600,
  source_job_id: i === 0 ? 'job-one' : null, source_model: i === 0 ? 'gpt-image-2' : null, added_at: '' }));
const full: CreationAsset = { ...asset, content: { ...asset.content as Extract<CreationAsset['content'], { kind: 'prompt' }>, preview_images: previews } };
function Detail({ initial = asset }: { initial?: CreationAsset }) {
  const [current, setCurrent] = useState(initial);
  return <PromptAssetDetail asset={current} busy={false} onUpdated={setCurrent} onUse={vi.fn()} onEdit={vi.fn()} />;
}
beforeEach(() => vi.resetAllMocks());
describe('prompt previews', () => {
  it('makes the empty list cover visible and shows the first preview as cover', () => {
    const view = render(<AssetCard asset={asset} onOpen={vi.fn()} />);
    expect(view.container.querySelector('.border-dashed')).toHaveClass('border-input');
    view.rerender(<AssetCard asset={full} onOpen={vi.fn()} />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', `/api/creation-assets/prompt-a/previews/${previews[0].file}/thumb?w=128`);
  });
  it('accepts multiple files from the empty drop area and shows the saved image', async () => {
    api.uploadPromptPreviews.mockResolvedValue({ ...full, content: { ...full.content, preview_images: [previews[0]] } });
    render(<Detail />);
    const file = new File(['png'], 'a.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('button', { name: '添加效果图' }), { dataTransfer: { files: [file] } });
    await screen.findByRole('img', { name: '角色效果图' });
    expect(api.uploadPromptPreviews).toHaveBeenCalledWith('prompt-a', [file], undefined);
    expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
  });
  it('hides add at eight while replacement preserves the selected file identity', async () => {
    api.uploadPromptPreviews.mockResolvedValue(full);
    render(<Detail initial={full} />);
    expect(screen.queryByRole('button', { name: '添加效果图' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看效果图 3' }));
    expect(screen.queryByText('效果图模型')).toBeNull();
    const file = new File(['png'], 'new.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('更换效果图文件'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadPromptPreviews).toHaveBeenCalledWith('prompt-a', [file], previews[2].file));
  });
  it('sets cover, deletes, and keeps the previous display on a server failure', async () => {
    api.reorderPromptPreviews.mockResolvedValue(full);
    api.deletePromptPreview.mockRejectedValue(new Error('删除失败'));
    render(<Detail initial={full} />);
    fireEvent.click(screen.getByRole('button', { name: '查看效果图 2' }));
    fireEvent.click(screen.getByRole('button', { name: '设为封面' }));
    await waitFor(() => expect(api.reorderPromptPreviews).toHaveBeenCalledWith('prompt-a', [previews[1].file, previews[0].file, ...previews.slice(2).map(p => p.file)]));
    await waitFor(() => expect(screen.getByRole('button', { name: '删除效果图 2' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '删除效果图 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败');
    expect(screen.getAllByRole('button', { name: /查看效果图/ })).toHaveLength(8);
  });
});
