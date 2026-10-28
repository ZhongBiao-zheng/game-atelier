import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { TeamLibrariesSection } from './TeamLibrariesSection';
import {
  ProfileRequiredError,
  fetchProfile,
  listTeamLibraries,
  mountTeamLibrary,
  rescanTeamLibrary,
  saveProfile,
  unmountTeamLibrary,
} from '@/api/teamLibraries';
import { listCanvasProjects } from '@/api/canvas';
import { chooseFolder } from '@/api/folders';
import type { TeamLibraryView } from '@/schema/teamLibrary';

vi.mock('@/api/teamLibraries', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/teamLibraries')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    saveProfile: vi.fn(),
    listTeamLibraries: vi.fn(),
    mountTeamLibrary: vi.fn(),
    unmountTeamLibrary: vi.fn(),
    rescanTeamLibrary: vi.fn(),
  };
});
vi.mock('@/api/canvas', () => ({ listCanvasProjects: vi.fn() }));
vi.mock('@/api/folders', () => ({ chooseFolder: vi.fn() }));

const mockProfile = vi.mocked(fetchProfile);
const mockSaveProfile = vi.mocked(saveProfile);
const mockList = vi.mocked(listTeamLibraries);
const mockMount = vi.mocked(mountTeamLibrary);
const mockUnmount = vi.mocked(unmountTeamLibrary);
const mockRescan = vi.mocked(rescanTeamLibrary);
const mockProjects = vi.mocked(listCanvasProjects);
const mockChooseFolder = vi.mocked(chooseFolder);

const view: TeamLibraryView = {
  library_id: 'lib_0123456789abcdef',
  project_id: 'p1',
  name: '美术共享盘',
  mount_path: '/Volumes/team/art',
  mounted_at: '2026-09-20T00:00:00Z',
  reachable: true,
  asset_count: 12,
  scanned_at: '2026-09-20T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockProjects.mockResolvedValue([
    { project_id: 'p1', name: '买牌三国' }, { project_id: 'p2', name: '列车短片' }, { project_id: 'p3', name: '空项目' },
  ] as never);
  mockProfile.mockResolvedValue({ display_name: '小李' });
  mockSaveProfile.mockResolvedValue({ display_name: '小李' });
  mockList.mockResolvedValue([view]);
  mockMount.mockResolvedValue(view);
  mockUnmount.mockResolvedValue(undefined);
  mockRescan.mockResolvedValue(view);
  mockChooseFolder.mockResolvedValue('/tmp/lib');
});

const card = async (name = '美术共享盘') => screen.findByRole('listitem', { name });

describe('TeamLibrariesSection', () => {
  it('同一个库挂在多个项目时合并成一张卡，列出挂到的项目', async () => {
    mockList.mockResolvedValue([view, { ...view, project_id: 'p2' }]);
    render(<TeamLibrariesSection />);

    const item = await card();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(within(item).getByText('/Volumes/team/art')).toBeInTheDocument();
    expect(within(item).getByText(/12 项 ·/)).toBeInTheDocument();
    expect(await within(item).findByText('买牌三国')).toBeInTheDocument();
    expect(within(item).getByText('列车短片')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(undefined, true);
    expect(await screen.findByRole('button', { name: /署名\s*小李/ })).toBeInTheDocument();
  });

  it('点项目标签上的 × 只从该项目卸载', async () => {
    mockList.mockResolvedValue([view, { ...view, project_id: 'p2' }]);
    render(<TeamLibrariesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '从 列车短片 卸载' }));
    await waitFor(() => expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p2'));
    expect(mockUnmount).toHaveBeenCalledTimes(1);
  });

  it('「+ 项目」勾选新项目时用库的路径挂载', async () => {
    render(<TeamLibrariesSection />);
    const item = await card();
    fireEvent.click(within(item).getByRole('button', { name: '项目' }));
    const picker = await screen.findByRole('dialog', { name: '美术共享盘 挂到的项目' });
    expect(within(picker).getByRole('checkbox', { name: '买牌三国' })).toBeChecked();
    fireEvent.click(within(picker).getByRole('checkbox', { name: '空项目' }));
    await waitFor(() => expect(mockMount).toHaveBeenCalledWith({ projectId: 'p3', path: '/Volumes/team/art' }));
  });

  it('不可达的库标红并可重新定位：新路径挂回原项目，换了库就卸掉旧库', async () => {
    mockList.mockResolvedValue([{ ...view, reachable: false }, { ...view, project_id: 'p2', reachable: false }]);
    mockMount.mockResolvedValue({ ...view, library_id: 'lib_new' });
    render(<TeamLibrariesSection />);
    const item = await card();
    expect(within(item).getByText('路径不可达')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: '项目' })).toBeDisabled();

    fireEvent.click(within(item).getByRole('button', { name: '重新定位' }));
    await waitFor(() => expect(mockUnmount).toHaveBeenCalledTimes(2));
    expect(mockChooseFolder).toHaveBeenCalledWith('重新定位团队库', '/Volumes/team/art');
    expect(mockMount).toHaveBeenCalledWith({ projectId: 'p1', path: '/tmp/lib' });
    expect(mockMount).toHaveBeenCalledWith({ projectId: 'p2', path: '/tmp/lib' });
    expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p1');
    expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p2');
  });

  it('从全部项目卸载需确认', async () => {
    mockList.mockResolvedValue([view, { ...view, project_id: 'p2' }]);
    render(<TeamLibrariesSection />);
    const item = await card();
    fireEvent.keyDown(within(item).getByRole('button', { name: '更多' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '从全部项目卸载' }));
    expect(mockUnmount).not.toHaveBeenCalled();

    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(mockUnmount).toHaveBeenCalledTimes(2));
    expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p1');
    expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p2');
  });

  it('挂载弹窗：选目录、勾项目，挂到每个勾选的项目', async () => {
    render(<TeamLibrariesSection />);
    await card();
    fireEvent.click(screen.getByRole('button', { name: '挂载文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '挂载文件夹' });
    expect(within(dialog).queryByPlaceholderText('分享时显示的名字')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '挂载' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    expect(await within(dialog).findByText('/tmp/lib')).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: '买牌三国' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '空项目' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '挂载到 2 个项目' }));

    await waitFor(() => expect(mockMount).toHaveBeenCalledTimes(2));
    expect(mockMount).toHaveBeenNthCalledWith(1, { projectId: 'p1', path: '/tmp/lib' });
    expect(mockMount).toHaveBeenNthCalledWith(2, { projectId: 'p3', path: '/tmp/lib' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '挂载文件夹' })).not.toBeInTheDocument());
  });

  it('没有署名时挂载弹窗要求先填，保存后再挂载', async () => {
    mockProfile.mockResolvedValue({ display_name: null });
    render(<TeamLibrariesSection />);
    expect(await screen.findByRole('button', { name: /署名\s*未设置/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '挂载文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '挂载文件夹' });
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: '买牌三国' }));
    const name = await within(dialog).findByPlaceholderText('分享时显示的名字');
    expect(within(dialog).getByRole('button', { name: '挂载到 1 个项目' })).toBeDisabled();

    fireEvent.change(name, { target: { value: '小李' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '挂载到 1 个项目' }));
    await waitFor(() => expect(mockMount).toHaveBeenCalled());
    expect(mockSaveProfile).toHaveBeenCalledWith('小李');
    expect(mockSaveProfile.mock.invocationCallOrder[0]).toBeLessThan(mockMount.mock.invocationCallOrder[0]);
  });

  it('缺署名导致挂载失败时就地弹出署名框，保存后可重试', async () => {
    mockProfile.mockResolvedValue({ display_name: null });
    mockMount.mockRejectedValueOnce(new ProfileRequiredError());
    render(<TeamLibrariesSection />);
    fireEvent.click(within(await card()).getByRole('button', { name: '项目' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '美术共享盘 挂到的项目' })).getByRole('checkbox', { name: '空项目' }));

    expect(await screen.findByText('先设置署名')).toBeInTheDocument();
    const signature = await screen.findByRole('dialog', { name: '署名' });
    fireEvent.change(within(signature).getByRole('textbox', { name: '署名' }), { target: { value: '小李' } });
    fireEvent.click(within(signature).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith('小李'));
    expect(await screen.findByRole('button', { name: /署名\s*小李/ })).toBeInTheDocument();
    expect(screen.queryByText('先设置署名')).not.toBeInTheDocument();
  });

  it('没有任何库时显示空状态', async () => {
    mockList.mockResolvedValue([]);
    render(<TeamLibrariesSection />);
    expect(await screen.findByText('还没有团队库')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '挂载文件夹' })).toBeInTheDocument();
  });

  it('库列表返回格式不对时报错，不装成空列表', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockResolvedValue({} as unknown as TeamLibraryView[]);
    render(<TeamLibrariesSection />);

    expect(await screen.findByText('读取列表失败：返回格式不对')).toBeInTheDocument();
    expect(screen.queryByText('还没有团队库')).not.toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('项目列表返回格式不对时报错', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProjects.mockResolvedValue({} as never);
    render(<TeamLibrariesSection />);

    expect(await screen.findByText('读取列表失败：返回格式不对')).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('点扫描调用 rescan', async () => {
    render(<TeamLibrariesSection />);
    fireEvent.click(within(await card()).getByRole('button', { name: '重新扫描' }));
    await waitFor(() => expect(mockRescan).toHaveBeenCalledWith('lib_0123456789abcdef'));
  });

  it('显示相对扫描时间和未扫描状态', async () => {
    mockList.mockResolvedValue([{ ...view, scanned_at: new Date(Date.now() - 600000).toISOString() },
      { ...view, library_id: 'lib_other', name: '其他', scanned_at: null }]);
    render(<TeamLibrariesSection />);
    expect(await screen.findByText('12 项 · 10 分钟前扫描')).toBeInTheDocument();
    expect(screen.getByText('12 项 · 尚未扫描')).toBeInTheDocument();
  });

  it('操作后的新列表不会被初始慢响应覆盖', async () => {
    let resolveInitial!: (value: TeamLibraryView[]) => void;
    mockList.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }));
    mockList.mockResolvedValue([view]);
    render(<TeamLibrariesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '挂载文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '挂载文件夹' });
    fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: '买牌三国' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '挂载到 1 个项目' }));
    await card();
    await act(async () => { resolveInitial([]); });
    expect(screen.getByRole('listitem', { name: '美术共享盘' })).toBeInTheDocument();
  });
});
