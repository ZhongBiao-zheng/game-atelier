import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TeamLibrariesSection } from './TeamLibrariesSection';
import {
  ProfileRequiredError,
  listTeamLibraries,
  mountTeamLibrary,
  rescanTeamLibrary,
  unmountTeamLibrary,
} from '@/api/teamLibraries';
import { fetchProjects } from '@/api/projects';
import { chooseFolder } from '@/api/folders';
import type { TeamLibraryView } from '@/schema/teamLibrary';

vi.mock('@/api/teamLibraries', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/teamLibraries')>();
  return {
    ...actual,
    listTeamLibraries: vi.fn(),
    mountTeamLibrary: vi.fn(),
    unmountTeamLibrary: vi.fn(),
    rescanTeamLibrary: vi.fn(),
  };
});
vi.mock('@/api/projects', () => ({ fetchProjects: vi.fn() }));
vi.mock('@/api/folders', () => ({ chooseFolder: vi.fn() }));

const mockList = vi.mocked(listTeamLibraries);
const mockMount = vi.mocked(mountTeamLibrary);
const mockUnmount = vi.mocked(unmountTeamLibrary);
const mockRescan = vi.mocked(rescanTeamLibrary);
const mockProjects = vi.mocked(fetchProjects);
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
  mockProjects.mockResolvedValue({
    projects: [{ id: 'p1', slug: 'maipai', name: '买牌三国', created_at: '2026-01-01T00:00:00Z' }],
    assignments: {},
  });
  mockList.mockResolvedValue([view]);
  mockMount.mockResolvedValue(view);
  mockUnmount.mockResolvedValue(undefined);
  mockRescan.mockResolvedValue(view);
  mockChooseFolder.mockResolvedValue('/tmp/lib');
});

describe('TeamLibrariesSection', () => {
  it('渲染项目选择与该项目的库列表', async () => {
    render(<TeamLibrariesSection />);

    const select = await screen.findByLabelText('项目');
    await waitFor(() => expect(select).toHaveValue('p1'));
    expect(screen.getByRole('option', { name: '买牌三国' })).toBeInTheDocument();

    expect(await screen.findByText('美术共享盘')).toBeInTheDocument();
    expect(screen.getByText('/Volumes/team/art')).toBeInTheDocument();
    expect(screen.getByText('12 项')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('p1'));
  });

  it('不可达的库打标记', async () => {
    mockList.mockResolvedValue([{ ...view, reachable: false }]);
    render(<TeamLibrariesSection />);
    expect(await screen.findByText('不可达')).toBeInTheDocument();
  });

  it('点挂载先选目录再挂载', async () => {
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '挂载' }));

    await waitFor(() => expect(mockChooseFolder).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockMount).toHaveBeenCalledWith({ projectId: 'p1', path: '/tmp/lib', name: undefined }),
    );
  });

  it('缺显示名时提示先设置显示名', async () => {
    mockMount.mockRejectedValue(new ProfileRequiredError());
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '挂载' }));

    expect(await screen.findByText('先设置显示名')).toBeInTheDocument();
  });

  it('卸载需确认', async () => {
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '卸载' }));
    expect(mockUnmount).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(mockUnmount).toHaveBeenCalledWith('lib_0123456789abcdef', 'p1'),
    );
  });

  it('库列表返回格式不对时报错，不装成空列表', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockResolvedValue({} as unknown as TeamLibraryView[]);
    render(<TeamLibrariesSection />);

    expect(await screen.findByText('读取列表失败：返回格式不对')).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('项目列表返回格式不对时报错', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProjects.mockResolvedValue({} as unknown as Awaited<ReturnType<typeof fetchProjects>>);
    render(<TeamLibrariesSection />);

    expect(await screen.findByText('读取列表失败：返回格式不对')).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('点扫描调用 rescan', async () => {
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    await waitFor(() => expect(mockRescan).toHaveBeenCalledWith('lib_0123456789abcdef'));
  });
});
