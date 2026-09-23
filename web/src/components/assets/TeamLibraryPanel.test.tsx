import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamLibraryPanel } from './TeamLibraryPanel';
import type { TeamLibraryIndexEntry, TeamLibraryView } from '@/schema/teamLibrary';
import { TEAM_ASSET_DRAG_TYPE } from '@/schema/teamLibrary';

const api = vi.hoisted(() => ({
  listTeamLibraries: vi.fn(), listTeamAssets: vi.fn(), adoptTeamAsset: vi.fn(), rescanTeamLibrary: vi.fn(),
  teamAssetThumbUrl: (l: string, e: string, w: number) => `/thumb/${l}/${e}/${w}`,
  teamAssetContentUrl: (l: string, e: string) => `/content/${l}/${e}`,
}));
vi.mock('@/api/teamLibraries', () => api);

const library: TeamLibraryView = { library_id: 'lib_0123456789abcdef', project_id: 'p1', name: '角色参考', mount_path: '/x', mounted_at: '', reachable: true, asset_count: 2, scanned_at: null };
const raw: TeamLibraryIndexEntry = { id: 'raw_a', kind: 'raw', title: 'castle.png', author: null, tags: [], mime_type: 'image/png', bytes: 1, relative_path: 'concept/castle.png', sha256: null, updated_at: '2026-09-20T00:00:00Z', reproducible: false, status: 'ready' };
const shared: TeamLibraryIndexEntry = { ...raw, id: 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'media', title: '董卓 待机', author: '老王', tags: ['皮肤'], relative_path: 'shared/老王/ta_01ARZ3NDEKTSV4RRFFQ69G5FAV' };

afterEach(() => vi.clearAllMocks());

describe('TeamLibraryPanel', () => {
  it('shows mount hint when the project has no library', async () => {
    api.listTeamLibraries.mockResolvedValue([]);
    const onOpenSettings = vi.fn();
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByRole('button', { name: '挂载' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
  it('hides the mount button when there is no mount exit', async () => {
    api.listTeamLibraries.mockResolvedValue([]);
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    expect(await screen.findByText('这个画布还没有团队库')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '挂载' })).not.toBeInTheDocument();
  });
  it('lists entries grouped by tree and filters by kind and query', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [raw, shared], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('董卓 待机')).toBeInTheDocument();
    expect(screen.getByText('concept')).toBeInTheDocument();      // 目录树：原始文件按目录
    expect(screen.getByText('老王')).toBeInTheDocument();          // 目录树：分享内容按作者
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '董' } });
    await waitFor(() => expect(api.listTeamAssets).toHaveBeenLastCalledWith(library.library_id, expect.objectContaining({ q: '董' })));
  });
  it('adopts on click and reports created flag', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [shared], next_cursor: null });
    api.adoptTeamAsset.mockResolvedValue({ asset: { asset_id: 'ca' }, created: true });
    const onAdopted = vi.fn();
    render(<TeamLibraryPanel projectId="p1" onAdopted={onAdopted} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '采用' }));
    await waitFor(() => expect(onAdopted).toHaveBeenCalledWith({ asset: { asset_id: 'ca' }, created: true }, shared));
    expect(api.adoptTeamAsset).toHaveBeenCalledWith(library.library_id, shared.id, 'p1');
  });
  it('sets drag payload on cards', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [raw], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onOpenSettings={vi.fn()} />);
    const card = (await screen.findByText('castle.png')).closest('[draggable="true"]')!;
    const setData = vi.fn();
    fireEvent.dragStart(card, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(TEAM_ASSET_DRAG_TYPE, JSON.stringify({ library_id: library.library_id, entry_id: 'raw_a' }));
  });
  it('drops a late rescan result when the query changed meanwhile', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.rescanTeamLibrary.mockResolvedValue(library);
    const stale: TeamLibraryIndexEntry = { ...raw, id: 'raw_stale', title: 'stale.png' };
    let releaseRescanList: (page: unknown) => void = () => {};
    api.listTeamAssets
      .mockResolvedValueOnce({ entries: [raw], next_cursor: null })
      .mockImplementationOnce(() => new Promise(resolve => { releaseRescanList = resolve; }))
      .mockResolvedValue({ entries: [shared], next_cursor: null });

    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByText('castle.png');

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(api.listTeamAssets).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '董' } });
    await screen.findByText('董卓 待机');

    await act(async () => {
      releaseRescanList({ entries: [stale], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('stale.png')).toBeNull();
    expect(screen.getByText('董卓 待机')).toBeInTheDocument();
  });
  it('greys out incomplete entries and hides adopt', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [{ ...shared, status: 'incomplete' }], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onOpenSettings={vi.fn()} />);
    await screen.findByText('董卓 待机');
    expect(screen.queryByRole('button', { name: '采用' })).toBeNull();
    expect(screen.getByText('同步中')).toBeInTheDocument();
  });
});
