import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SetPromptPreviewDialog } from './SetPromptPreviewDialog';
import { chooseOption } from '@/test/select';
const api = vi.hoisted(() => ({ listCreationAssets: vi.fn(), setPromptPreviewFromJob: vi.fn() }));
vi.mock('@/api/creationAssets', () => api);
beforeEach(() => vi.resetAllMocks());
it('defaults to the originating asset and sends the selected output index', async () => {
  const asset = { asset_id: 'prompt-b', title: '白犬' };
  api.listCreationAssets.mockResolvedValue({ assets: [{ asset_id: 'prompt-a', title: '风景' }, asset] });
  api.setPromptPreviewFromJob.mockResolvedValue(asset);
  const onSaved = vi.fn();
  render(<SetPromptPreviewDialog request={{ jobId: 'job-x', outputIndex: 2, promptAssetId: 'prompt-b' }} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('白犬'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(asset));
  expect(api.setPromptPreviewFromJob).toHaveBeenCalledWith('prompt-b', 'job-x', 2);
});
it('allows choosing another asset when the origin was deleted and displays upload errors', async () => {
  api.listCreationAssets.mockResolvedValue({ assets: [{ asset_id: 'prompt-a', title: '风景' }] });
  api.setPromptPreviewFromJob.mockRejectedValue(new Error('每条提示词最多 8 张效果图'));
  render(<SetPromptPreviewDialog request={{ jobId: 'job-x', outputIndex: 0, promptAssetId: 'deleted' }} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByRole('combobox');
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  await chooseOption(screen.getByRole('combobox'), '风景');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('最多 8 张');
});
