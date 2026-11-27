import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AssetPanel } from './AssetPanel';
import { loadUiPrefs, saveUiPref } from '@/lib/uiPrefs';

vi.mock('@/lib/uiPrefs', () => ({ loadUiPrefs: vi.fn(), saveUiPref: vi.fn() }));
vi.mock('@/api/history', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/history')>(),
  listHistory: vi.fn(async () => ({ items: [], next_cursor: null })),
}));
vi.mock('./CreationAssetPanel', async () => {
  const { forwardRef } = await import('react');
  return { CreationAssetPanel: forwardRef(() => <div>提示词</div>) };
});
const props = { onClose: vi.fn(), onUseMedia: vi.fn(), onUsePrompt: vi.fn() };

it('opens history by default and remembers the library tab', async () => {
  vi.mocked(loadUiPrefs).mockResolvedValue({});
  render(<AssetPanel {...props} />);
  expect(await screen.findByText('还没有生成记录')).toBeVisible();
  fireEvent.mouseDown(screen.getByRole('tab', { name: '素材库' }));
  expect(await screen.findByText('提示词')).toBeVisible();
  expect(saveUiPref).toHaveBeenCalledWith('asset-panel', 'library');
});

it('restores the tab and keeps direct save operations in the library', async () => {
  vi.mocked(loadUiPrefs).mockResolvedValue({ 'asset-panel': 'library' });
  const view = render(<AssetPanel {...props} />);
  await waitFor(() => expect(screen.getByRole('tab', { name: '素材库' })).toHaveAttribute('aria-selected', 'true'));
  view.unmount();
  vi.mocked(loadUiPrefs).mockResolvedValue({ 'asset-panel': 'history' });
  render(<AssetPanel {...props} initialKind="team" />);
  expect(screen.getByRole('tab', { name: '素材库' })).toHaveAttribute('aria-selected', 'true');
});
