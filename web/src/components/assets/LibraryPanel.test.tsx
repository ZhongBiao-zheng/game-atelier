import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LibraryPanel } from './LibraryPanel';
import { listLibrary, libraryWrite, type LibraryCatalog } from '@/api/library';

vi.mock('@/api/library', async original => ({
  ...await original<typeof import('@/api/library')>(), listLibrary: vi.fn(), libraryWrite: vi.fn(),
}));
const catalog: LibraryCatalog = { folders: [
  { id: 'favorites', name: '收藏', system: 'favorites', parent_id: null, item_ids: [] },
  { id: 'fld_1', name: '包装终稿', parent_id: null, item_ids: [] },
], subjects: [], items: {} };
describe('素材库', () => {
  it('opens a folder and uses the same actions from its context menu', async () => {
    vi.mocked(listLibrary).mockResolvedValue(catalog);
    const open = vi.fn();
    render(<LibraryPanel target={null} onTarget={open} onReference={vi.fn()} />);
    const folder = await screen.findByRole('button', { name: /包装终稿 0/ });
    fireEvent.click(folder);
    expect(open).toHaveBeenCalledWith('fld_1');
    fireEvent.contextMenu(folder);
    const copy = await screen.findByRole('menuitem', { name: '创建副本' });
    vi.mocked(libraryWrite).mockResolvedValue({ id: 'fld_2' });
    fireEvent.click(copy);
    await waitFor(() => expect(libraryWrite).toHaveBeenCalledWith('fld_1/copy', {}));
  });
});
