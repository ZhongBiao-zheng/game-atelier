import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamShareDialog, type TeamShareDialogRequest } from './TeamShareDialog';
import {
  ProfileRequiredError,
  TeamRefsTooLargeError,
  fetchProfile,
  listTeamLibraries,
  saveProfile,
  shareToTeamLibrary,
} from '@/api/teamLibraries';
import type { TeamLibraryIndexEntry, TeamLibraryView } from '@/schema/teamLibrary';

vi.mock('@/api/teamLibraries', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/teamLibraries')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    saveProfile: vi.fn(),
    listTeamLibraries: vi.fn(),
    shareToTeamLibrary: vi.fn(),
  };
});

const mockProfile = vi.mocked(fetchProfile);
const mockSaveProfile = vi.mocked(saveProfile);
const mockList = vi.mocked(listTeamLibraries);
const mockShare = vi.mocked(shareToTeamLibrary);

function view(overrides: Partial<TeamLibraryView> = {}): TeamLibraryView {
  return {
    library_id: 'lib_a',
    project_id: 'canvas-1',
    name: '美术共享盘',
    mount_path: '/Volumes/team/art',
    mounted_at: '2026-09-20T00:00:00Z',
    reachable: true,
    asset_count: 3,
    scanned_at: '2026-09-20T00:00:00Z',
    ...overrides,
  };
}

const entry: TeamLibraryIndexEntry = {
  id: 'ta_01',
  kind: 'generation',
  title: '夜景',
  author: '老王',
  tags: ['夜'],
  mime_type: 'image/png',
  bytes: 10,
  relative_path: 'shared/老王/ta_01',
  sha256: 'abc',
  updated_at: '2026-09-23T00:00:00Z',
  reproducible: true,
  status: 'ready',
  model: 'gpt-image-1',
  cost_cny: 0.2,
  input_sha256: [],
};

const request: TeamShareDialogRequest = {
  source: { kind: 'job_output', job_id: 'studio-1', output_index: 0 },
  defaultTitle: '夜景',
  previewUrl: '/api/raw?job_id=studio-1&path=v1.png',
};

function renderDialog(props: Partial<Parameters<typeof TeamShareDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onShared = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <TeamShareDialog
      request={request}
      onClose={onClose}
      onShared={onShared}
      onOpenSettings={onOpenSettings}
      {...props}
    />,
  );
  return { onClose, onShared, onOpenSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile.mockResolvedValue({ display_name: '老王' });
  mockList.mockResolvedValue([view()]);
  mockShare.mockResolvedValue(entry);
});

describe('TeamShareDialog', () => {
  it('request 为 null 时不渲染也不拉数据', () => {
    renderDialog({ request: null });
    expect(screen.queryByText('分享到团队库')).not.toBeInTheDocument();
    expect(mockProfile).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('打开时并行拉显示名与全部团队库，只有一个库时默认选中', async () => {
    let resolveProfile: (value: { display_name: string | null }) => void = () => {};
    mockProfile.mockReturnValue(new Promise(resolve => { resolveProfile = resolve; }));
    renderDialog();

    expect(mockProfile).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith();
    resolveProfile({ display_name: '老王' });

    const select = await screen.findByLabelText('团队库');
    await waitFor(() => expect(select).toHaveValue('lib_a'));
    expect(screen.getByLabelText('标题')).toHaveValue('夜景');
    expect(screen.queryByLabelText('显示名')).not.toBeInTheDocument();
  });

  it('只列可达的库并按 library_id 去重，多个库时需手动选择', async () => {
    mockList.mockResolvedValue([
      view({ library_id: 'lib_a', name: '美术共享盘' }),
      view({ library_id: 'lib_a', project_id: 'canvas-2', name: '美术盘（画布 2）' }),
      view({ library_id: 'lib_b', name: '策划盘' }),
      view({ library_id: 'lib_c', name: '断开的盘', reachable: false }),
    ]);
    renderDialog();

    expect(await screen.findByRole('option', { name: '策划盘' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '美术共享盘' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '美术盘（画布 2）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '断开的盘' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('团队库')).toHaveValue('');
    expect(screen.getByRole('button', { name: '分享' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('团队库'), { target: { value: 'lib_b' } });
    expect(screen.getByRole('button', { name: '分享' })).toBeEnabled();
  });

  it('提交标题与标签，成功后回调 onShared 并关闭', async () => {
    const { onShared, onClose } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  城市夜景  ' } });
    const tagInput = screen.getByPlaceholderText('输入标签，按 Enter 添加');
    fireEvent.change(tagInput, { target: { value: '夜，城市' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '分享' }));

    await waitFor(() => expect(onShared).toHaveBeenCalledWith(entry, '美术共享盘'));
    expect(mockShare).toHaveBeenCalledWith('lib_a', {
      source: request.source,
      title: '城市夜景',
      tags: ['夜', '城市'],
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });

  it('没有显示名时先保存显示名再分享', async () => {
    mockProfile.mockResolvedValue({ display_name: null });
    mockSaveProfile.mockResolvedValue({ display_name: '小李' });
    const { onShared } = renderDialog();

    const nameInput = await screen.findByLabelText('显示名');
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));
    expect(screen.getByRole('button', { name: '分享' })).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: ' 小李 ' } });
    fireEvent.click(screen.getByRole('button', { name: '分享' }));

    await waitFor(() => expect(onShared).toHaveBeenCalled());
    expect(mockSaveProfile).toHaveBeenCalledWith('小李');
    expect(mockSaveProfile.mock.invocationCallOrder[0])
      .toBeLessThan(mockShare.mock.invocationCallOrder[0]);
  });

  it('没有可达库时显示「挂载」并调用 onOpenSettings', async () => {
    mockList.mockResolvedValue([view({ reachable: false })]);
    const { onOpenSettings } = renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: '挂载' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '分享' })).toBeDisabled();
  });

  it('参考内容过大时确认后带 allow_large 重发', async () => {
    mockShare
      .mockRejectedValueOnce(new TeamRefsTooLargeError(300 * 1024 * 1024))
      .mockResolvedValueOnce(entry);
    const { onShared } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));

    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    expect(await screen.findByText('参考内容共 300 MB')).toBeInTheDocument();
    expect(onShared).not.toHaveBeenCalled();

    const confirm = screen.getByRole('dialog', { name: '参考内容较大' });
    fireEvent.click(within(confirm).getByRole('button', { name: '分享' }));
    await waitFor(() => expect(onShared).toHaveBeenCalledWith(entry, '美术共享盘'));
    expect(mockShare).toHaveBeenLastCalledWith('lib_a', {
      source: request.source,
      title: '夜景',
      tags: [],
      allow_large: true,
    });
  });

  it('其他错误显示在对话框内且不关闭', async () => {
    mockShare.mockRejectedValue(new Error('分享到团队库失败：团队库不可达'));
    const { onShared, onClose } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));

    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('分享到团队库失败：团队库不可达');
    expect(onShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('同 library_id 不可达的挂载在前、可达的在后时仍保留可达那条', async () => {
    mockList.mockResolvedValue([
      view({ library_id: 'lib_a', name: '断开的挂载', reachable: false }),
      view({ library_id: 'lib_a', project_id: 'canvas-2', name: '可达的挂载' }),
    ]);
    renderDialog();

    const select = await screen.findByLabelText('团队库');
    await waitFor(() => expect(select).toHaveValue('lib_a'));
    expect(screen.getByRole('option', { name: '可达的挂载' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '断开的挂载' })).not.toBeInTheDocument();
  });

  it('标题限长 120，标签超过 20 个时禁用分享', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));
    expect(screen.getByLabelText('标题')).toHaveAttribute('maxLength', '120');

    const tagInput = screen.getByPlaceholderText('输入标签，按 Enter 添加');
    const twenty = Array.from({ length: 20 }, (_, index) => `t${index}`).join(',');
    fireEvent.change(tagInput, { target: { value: twenty } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '分享' })).toBeEnabled();

    fireEvent.change(tagInput, { target: { value: 't20' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '分享' })).toBeDisabled();
  });

  it('提交中重复点击只发一次请求', async () => {
    let resolveShare: (value: TeamLibraryIndexEntry) => void = () => {};
    mockShare.mockReturnValue(new Promise(resolve => { resolveShare = resolve; }));
    const { onShared } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));

    const button = screen.getByRole('button', { name: '分享' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockShare).toHaveBeenCalledTimes(1);
    resolveShare(entry);
    await waitFor(() => expect(onShared).toHaveBeenCalledTimes(1));
  });

  it('分享时报需要显示名，重新露出显示名输入并显示错误', async () => {
    mockShare.mockRejectedValueOnce(new ProfileRequiredError());
    const { onShared, onClose } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));
    expect(screen.queryByLabelText('显示名')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('先设置显示名');
    expect(screen.getByLabelText('显示名')).toBeInTheDocument();
    expect(onShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('保存显示名失败时显示错误且不分享', async () => {
    mockProfile.mockResolvedValue({ display_name: null });
    mockSaveProfile.mockRejectedValue(new Error('保存显示名失败：磁盘只读'));
    renderDialog();

    fireEvent.change(await screen.findByLabelText('显示名'), { target: { value: '小李' } });
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));
    fireEvent.click(screen.getByRole('button', { name: '分享' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('保存显示名失败：磁盘只读');
    expect(mockShare).not.toHaveBeenCalled();
    expect(screen.getByLabelText('显示名')).toBeInTheDocument();
  });

  it('参考内容过大时点取消不重发，分享对话框仍开着', async () => {
    mockShare.mockRejectedValueOnce(new TeamRefsTooLargeError(300 * 1024 * 1024));
    const { onShared, onClose } = renderDialog();
    await waitFor(() => expect(screen.getByLabelText('团队库')).toHaveValue('lib_a'));

    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    const confirm = await screen.findByRole('dialog', { name: '参考内容较大' });
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '参考内容较大' })).not.toBeInTheDocument();
    });
    expect(mockShare).toHaveBeenCalledTimes(1);
    expect(onShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '分享到团队库' })).toBeInTheDocument();
  });

  it('request 切到 null 后迟到的响应被丢弃', async () => {
    let resolveFirst: (value: TeamLibraryView[]) => void = () => {};
    mockList.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
    mockList.mockReturnValueOnce(new Promise(() => {}));
    const props = { onClose: vi.fn(), onShared: vi.fn() };
    const { rerender } = render(<TeamShareDialog request={request} {...props} />);

    rerender(<TeamShareDialog request={null} {...props} />);
    rerender(<TeamShareDialog request={{ ...request, defaultTitle: '第二张' }} {...props} />);
    resolveFirst([view({ name: '迟到的库' })]);

    expect(await screen.findByRole('option', { name: '正在读取…' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('第二张'));
    expect(screen.queryByRole('option', { name: '迟到的库' })).not.toBeInTheDocument();
  });

  it('读取团队库失败时显示错误', async () => {
    mockList.mockRejectedValue(new Error('读取团队库失败'));
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('读取团队库失败');
  });
});
