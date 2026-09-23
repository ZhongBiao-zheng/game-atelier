import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamLibraryPanel } from './TeamLibraryPanel';
import type { TeamLibraryIndexEntry, TeamLibraryView } from '@/schema/teamLibrary';
import { TEAM_ASSET_DRAG_TYPE } from '@/schema/teamLibrary';

const api = vi.hoisted(() => ({
  listTeamLibraries: vi.fn(), listTeamAssets: vi.fn(), adoptTeamAsset: vi.fn(), rescanTeamLibrary: vi.fn(),
  fetchProfile: vi.fn(), updateTeamAsset: vi.fn(), withdrawTeamAsset: vi.fn(), listRelatedTeamAssets: vi.fn(),
  teamAssetThumbUrl: (l: string, e: string, w: number) => `/thumb/${l}/${e}/${w}`,
  teamAssetContentUrl: (l: string, e: string) => `/content/${l}/${e}`,
  TeamNotAuthorError: class TeamNotAuthorError extends Error {
    constructor() { super('只有作者能修改'); }
  },
}));
vi.mock('@/api/teamLibraries', () => api);

const library: TeamLibraryView = { library_id: 'lib_0123456789abcdef', project_id: 'p1', name: '角色参考', mount_path: '/x', mounted_at: '', reachable: true, asset_count: 2, scanned_at: null };
const raw: TeamLibraryIndexEntry = { id: 'raw_a', kind: 'raw', title: 'castle.png', author: null, tags: [], mime_type: 'image/png', bytes: 1, relative_path: 'concept/castle.png', sha256: null, updated_at: '2026-09-20T00:00:00Z', reproducible: false, status: 'ready', model: null, cost_cny: null };
const shared: TeamLibraryIndexEntry = { ...raw, id: 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'media', title: '董卓 待机', author: '老王', tags: ['皮肤'], relative_path: 'shared/老王/ta_01ARZ3NDEKTSV4RRFFQ69G5FAV' };

const generation: TeamLibraryIndexEntry = { ...shared, id: 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAW', kind: 'generation', title: '雪山白犬', reproducible: true, model: 'gpt-image-2', cost_cny: 0.21, relative_path: 'shared/老王/ta_01ARZ3NDEKTSV4RRFFQ69G5FAW' };
const adoptedGeneration = { asset_id: 'ca_generation', kind: 'generation', title: '雪山白犬' };

beforeEach(() => {
  api.fetchProfile.mockResolvedValue({ display_name: null });
  api.listRelatedTeamAssets.mockResolvedValue([]);
});
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

  it('shows edit and withdraw only on shared cards by the current author', async () => {
    api.fetchProfile.mockResolvedValue({ display_name: '老王' });
    api.listTeamLibraries.mockResolvedValue([library]);
    const other: TeamLibraryIndexEntry = { ...shared, id: 'ta_other', title: '别人的', author: '小李' };
    const rawByName: TeamLibraryIndexEntry = { ...raw, author: '老王' };
    api.listTeamAssets.mockResolvedValue({ entries: [shared, other, rawByName], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    await screen.findByText('别人的');
    expect(api.fetchProfile).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '撤回' })).toHaveLength(1);
  });
  it('edits title and tags and updates the card', async () => {
    api.fetchProfile.mockResolvedValue({ display_name: '老王' });
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [shared], next_cursor: null });
    api.updateTeamAsset.mockResolvedValue({ ...shared, title: '董卓 攻击', tags: ['皮肤', '攻击'] });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const title = await screen.findByLabelText('标题');
    expect(title).toHaveValue('董卓 待机');
    fireEvent.change(title, { target: { value: '董卓 攻击' } });
    const tagInput = screen.getByPlaceholderText('输入标签，按 Enter 添加');
    fireEvent.change(tagInput, { target: { value: '攻击' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.updateTeamAsset).toHaveBeenCalledWith(
      library.library_id, shared.id, { title: '董卓 攻击', tags: ['皮肤', '攻击'] },
    ));
    expect(await screen.findByText('董卓 攻击')).toBeInTheDocument();
    expect(screen.queryByText('董卓 待机')).toBeNull();
    expect(screen.queryByLabelText('标题')).toBeNull();
  });
  it('shows the not-author error when editing is refused', async () => {
    api.fetchProfile.mockResolvedValue({ display_name: '老王' });
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [shared], next_cursor: null });
    api.updateTeamAsset.mockRejectedValue(new api.TeamNotAuthorError());
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));
    expect(await screen.findByText('只有作者能修改')).toBeInTheDocument();
  });
  it('withdraws after a destructive confirmation and removes the card', async () => {
    api.fetchProfile.mockResolvedValue({ display_name: '老王' });
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [shared], next_cursor: null });
    api.withdrawTeamAsset.mockResolvedValue(undefined);
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '撤回' }));
    expect(await screen.findByRole('heading', { name: '撤回团队资产' })).toBeInTheDocument();
    expect(api.withdrawTeamAsset).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '撤回' }));
    await waitFor(() => expect(api.withdrawTeamAsset).toHaveBeenCalledWith(library.library_id, shared.id));
    await waitFor(() => expect(screen.queryByText('董卓 待机')).toBeNull());
  });
  it('shows the not-author error when withdrawing is refused', async () => {
    api.fetchProfile.mockResolvedValue({ display_name: '老王' });
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [shared], next_cursor: null });
    api.withdrawTeamAsset.mockRejectedValue(new api.TeamNotAuthorError());
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '撤回' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '撤回' }));
    expect(await screen.findByText('只有作者能修改')).toBeInTheDocument();
    expect(screen.getByText('董卓 待机')).toBeInTheDocument();
  });
  it('reproduces a ready generation card by adopting first', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [generation, shared, { ...generation, id: 'ta_sync', title: '同步中的', status: 'incomplete' }], next_cursor: null });
    api.adoptTeamAsset.mockResolvedValue({ asset: adoptedGeneration, created: true });
    const onReproduce = vi.fn();
    const onAdopted = vi.fn();
    render(<TeamLibraryPanel projectId="p1" onAdopted={onAdopted} onReproduce={onReproduce} />);
    await screen.findByText('同步中的');
    const buttons = screen.getAllByRole('button', { name: '复刻' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(onReproduce).toHaveBeenCalledWith(adoptedGeneration));
    expect(api.adoptTeamAsset).toHaveBeenCalledWith(library.library_id, generation.id, 'p1');
  });
  it('hides reproduce and related recipes without onReproduce', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [generation], next_cursor: null });
    api.listRelatedTeamAssets.mockResolvedValue([{ library_id: library.library_id, library_name: library.name, entry: generation }]);
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    await screen.findByText('雪山白犬');
    expect(screen.queryByRole('button', { name: '复刻' })).toBeNull();
    expect(screen.queryByText('相关配方')).toBeNull();
    expect(api.listRelatedTeamAssets).not.toHaveBeenCalled();
  });
  it('shows the model on generation cards', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [generation], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} />);
    expect(await screen.findByText('gpt-image-2')).toBeInTheDocument();
  });
  it('lists related recipes and reproduces from their own library', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [], next_cursor: null });
    const cheap: TeamLibraryIndexEntry = { ...generation, id: 'ta_free', title: '无价配方', author: '小李', model: 'seedream-4', cost_cny: null };
    api.listRelatedTeamAssets.mockResolvedValue([
      { library_id: 'lib_other', library_name: '别的库', entry: generation },
      { library_id: library.library_id, library_name: library.name, entry: cheap },
    ]);
    api.adoptTeamAsset.mockResolvedValue({ asset: adoptedGeneration, created: false });
    const onReproduce = vi.fn();
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onReproduce={onReproduce} />);
    const row = (await screen.findByText('相关配方')).parentElement!;
    expect(api.listRelatedTeamAssets).toHaveBeenCalledWith('p1');
    const first = within(row).getByRole('button', { name: /雪山白犬/ });
    expect(first).toHaveTextContent('老王');
    expect(first).toHaveTextContent('gpt-image-2');
    expect(first).toHaveTextContent('¥0.21');
    const second = within(row).getByRole('button', { name: /无价配方/ });
    expect(second).toHaveTextContent('seedream-4');
    expect(second).not.toHaveTextContent('¥');
    fireEvent.click(first);
    await waitFor(() => expect(onReproduce).toHaveBeenCalledWith(adoptedGeneration));
    expect(api.adoptTeamAsset).toHaveBeenCalledWith('lib_other', generation.id, 'p1');
  });
  it('renders no related row when the list is empty', async () => {
    api.listTeamLibraries.mockResolvedValue([library]);
    api.listTeamAssets.mockResolvedValue({ entries: [generation], next_cursor: null });
    render(<TeamLibraryPanel projectId="p1" onAdopted={vi.fn()} onReproduce={vi.fn()} />);
    await screen.findByText('雪山白犬');
    await waitFor(() => expect(api.listRelatedTeamAssets).toHaveBeenCalledWith('p1'));
    expect(screen.queryByText('相关配方')).toBeNull();
  });
});
