import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { TeamLibrariesSection } from './TeamLibrariesSection';
import {
  ProfileRequiredError,
  listTeamLibraries,
  mountTeamLibrary,
  rescanTeamLibrary,
  unmountTeamLibrary,
} from '@/api/teamLibraries';
import { listCanvasProjects } from '@/api/canvas';
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
vi.mock('@/api/canvas', () => ({ listCanvasProjects: vi.fn() }));
vi.mock('@/api/folders', () => ({ chooseFolder: vi.fn() }));

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
    { schema_version: 2, project_id: 'p1', name: '买牌三国', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  ] as never);
  mockList.mockResolvedValue([view]);
  mockMount.mockResolvedValue(view);
  mockUnmount.mockResolvedValue(undefined);
  mockRescan.mockResolvedValue(view);
  mockChooseFolder.mockResolvedValue('/tmp/lib');
});

describe('TeamLibrariesSection', () => {
  it('渲染项目选择与该项目的库列表', async () => {
    render(<TeamLibrariesSection />);

    const project = await screen.findByRole('button', { name: /买牌三国/ });
    expect(project).toHaveAttribute('aria-pressed', 'true');

    expect(await screen.findByText('美术共享盘')).toBeInTheDocument();
    expect(screen.getByText('/Volumes/team/art')).toBeInTheDocument();
    expect(screen.getByText(/12 项 ·/)).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(undefined, true));
  });

  it('不可达的库打标记', async () => {
    mockList.mockResolvedValue([{ ...view, reachable: false }]);
    render(<TeamLibrariesSection />);
    expect(await screen.findByText('路径不可达')).toBeInTheDocument();
  });

  it('点挂载先选目录再挂载', async () => {
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '挂载文件夹' }));

    await waitFor(() => expect(mockChooseFolder).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockMount).toHaveBeenCalledWith({ projectId: 'p1', path: '/tmp/lib', name: undefined }),
    );
  });

  it('缺显示名时提示先设置显示名', async () => {
    mockMount.mockRejectedValue(new ProfileRequiredError());
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '挂载文件夹' }));

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
    mockProjects.mockResolvedValue({} as never);
    render(<TeamLibrariesSection />);

    expect(await screen.findByText('读取列表失败：返回格式不对')).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('点扫描调用 rescan', async () => {
    render(<TeamLibrariesSection />);
    await screen.findByText('美术共享盘');

    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }));
    await waitFor(() => expect(mockRescan).toHaveBeenCalledWith('lib_0123456789abcdef'));
  });

  it('按 ?canvas= 默认选中画布，不在列表里就回落第一个', async () => {
    mockProjects.mockResolvedValue([
      { schema_version: 2, project_id: 'p1', name: '买牌三国', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { schema_version: 2, project_id: 'p2', name: '列车短片', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ] as never);
    try {
      window.history.replaceState(null, '', '/settings?canvas=p2');
      const first = render(<TeamLibrariesSection />);
      await waitFor(() => expect(screen.getByRole('button', { name: /列车短片/ })).toHaveAttribute('aria-pressed', 'true'));
      await waitFor(() => expect(mockList).toHaveBeenCalledWith(undefined, true));
      first.unmount();

      window.history.replaceState(null, '', '/settings?canvas=gone');
      render(<TeamLibrariesSection />);
      await waitFor(() => expect(screen.getByRole('button', { name: /买牌三国/ })).toHaveAttribute('aria-pressed', 'true'));
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

it('跨项目同库分别计数，切换空项目显示挂载入口，卸载后更新数量', async () => {
  mockProjects.mockResolvedValue([
    { project_id: 'p1', name: '项目一' }, { project_id: 'p2', name: '项目二' }, { project_id: 'p3', name: '空项目' },
  ] as never);
  mockList.mockResolvedValue([view, { ...view, project_id: 'p2' }]);
  render(<TeamLibrariesSection />);
  const first = await screen.findByRole('button', { name: '项目一 1 个' });
  expect(screen.getByRole('button', { name: '项目二 1 个' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '空项目' }));
  expect(screen.getByText('这个项目还没挂载团队库')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择文件夹' })).toBeInTheDocument();
  fireEvent.click(first);
  fireEvent.click(screen.getByRole('button', { name: '卸载' }));
  mockList.mockResolvedValue([{ ...view, project_id: 'p2' }]);
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(first).toHaveTextContent('项目一'));
  await waitFor(() => expect(first).not.toHaveTextContent('1 个'));
  expect(screen.getByRole('button', { name: '项目二 1 个' })).toBeInTheDocument();
});

it('显示相对扫描时间和未扫描状态', async () => {
  mockList.mockResolvedValue([{ ...view, scanned_at: new Date(Date.now() - 600000).toISOString() },
    { ...view, library_id: 'lib_other', name: '其他', scanned_at: null }]);
  render(<TeamLibrariesSection />);
  expect(await screen.findByText('12 项 · 10 分钟前扫描')).toBeInTheDocument();
  expect(screen.getByText('12 项 · 尚未扫描')).toBeInTheDocument();
});

it('挂载后的新列表不会被初始慢响应覆盖', async () => {
  let resolveInitial!: (value: TeamLibraryView[]) => void;
  mockList.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }));
  mockList.mockResolvedValue([view]);
  render(<TeamLibrariesSection />);
  fireEvent.click(await screen.findByRole('button', { name: '挂载文件夹' }));
  await screen.findByText('美术共享盘');
  await act(async () => { resolveInitial([]); });
  expect(screen.getByRole('button', { name: '买牌三国 1 个' })).toBeInTheDocument();
  expect(screen.getByText('美术共享盘')).toBeInTheDocument();
});
