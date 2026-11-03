import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchProfile } from '@/api/teamLibraries';
import { TeamLibraryPanel } from './TeamLibraryPanel';
import { GatewayLibraryBrowser } from './GatewayLibraryBrowser';
import { listGatewayAssets, listGatewayLibraries, type GatewayLibrarySelection } from '@/api/gatewayLibraries';
vi.mock('@/api/gatewayLibraries', async original => ({ ...await original<typeof import('@/api/gatewayLibraries')>(),
  listGatewayLibraries: vi.fn(), listGatewayAssets: vi.fn() }));
vi.mock('@/api/teamLibraries', () => ({ listTeamLibraries: vi.fn(async () => []), fetchProfile: vi.fn(async () => ({ display_name: null })), listRelatedTeamAssets: vi.fn(async () => []) }));
const library: GatewayLibrarySelection = { alias: '林晓网关', id: 'lib_0123456789abcdef', name: '画面参考', owner_name: '林晓', updated_at: 'now', counts: {} };
const entries = [
  { entry_id: 'ta_image', kind: 'raw' as const, title: '风景.png', mime_type: 'image/png', tags: [], preview_count: 0 },
  { entry_id: 'ta_video', kind: 'raw' as const, title: '片段.mp4', mime_type: 'video/mp4', tags: [], preview_count: 0 },
  { entry_id: 'ta_prompt', kind: 'prompt' as const, title: '夕照提示词', author: '林晓', prompt_text: '山谷夕照', tags: [], preview_count: 2 },
];
beforeEach(() => {
  vi.mocked(fetchProfile).mockResolvedValue({ display_name: null });
  vi.mocked(listGatewayLibraries).mockResolvedValue([{ gateway_alias: library.alias, owner_name: '林晓', unreachable: false, libraries: [library] }]);
  vi.mocked(listGatewayAssets).mockResolvedValue(entries);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('无本地项目也能选同事共享，只查看缩略图和提示词，没有媒体源与采用动作', async () => {
  const { container } = render(<TeamLibraryPanel projectId="" onAdopted={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '团队库' }));
  const group = screen.getByRole('group', { name: '同事共享' });
  fireEvent.click(within(group).getByRole('button', { name: /画面参考 · 林晓/ }));
  await screen.findByRole('button', { name: '查看 风景.png' });
  expect(container.querySelector('video, audio, [draggable="true"]')).toBeNull();
  expect(screen.queryByRole('button', { name: /采用|下载|复刻/ })).toBeNull();
  for (const img of container.querySelectorAll('img')) {
    expect(img.getAttribute('src')).toMatch(/^\/api\/gateway-libraries\/.*\/thumb\?/);
    expect(img).toHaveAttribute('draggable', 'false');
  }
  fireEvent.click(screen.getByRole('button', { name: '查看 夕照提示词' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '效果图 2' }));
  expect(within(dialog).getByAltText('夕照提示词')).toHaveAttribute('src', expect.stringContaining('/previews/1/thumb'));
  expect(within(dialog).getByRole('button', { name: '复制' })).toBeInTheDocument();
  vi.mocked(listGatewayLibraries).mockResolvedValue([{ gateway_alias: library.alias, owner_name: '林晓', unreachable: false, libraries: [] }]);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(await screen.findByText('已停止共享')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '团队库' }));
  expect(within(screen.getByRole('group', { name: '同事共享' })).queryByText(/画面参考/)).toBeNull();
});

it('每 30 秒重查目录，断连后清空，不依赖 SSE', async () => {
  vi.useFakeTimers();
  render(<TeamLibraryPanel projectId="" onAdopted={vi.fn()} />);
  await act(async () => {});
  expect(listGatewayLibraries).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(30000); });
  expect(listGatewayLibraries).toHaveBeenCalledTimes(2);
});

it('缩略图失败立即通知上层撤掉共享库，旧列表请求不能覆盖切换', async () => {
  const stopped = vi.fn();
  const { rerender } = render(<GatewayLibraryBrowser library={library} available revision={1} onRefresh={vi.fn()} onUnavailable={stopped} />);
  fireEvent.error(await screen.findByAltText('风景.png'));
  expect(stopped).toHaveBeenCalledTimes(1);
  rerender(<GatewayLibraryBrowser library={library} available={false} revision={2} onRefresh={vi.fn()} onUnavailable={stopped} />);
  expect(screen.getByText('已停止共享')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByAltText('风景.png')).toBeNull());
});

it('正常轮询保留正在查看的详情，停止共享才清空', async () => {
  const props = { library, available: true, revision: 1, onRefresh: vi.fn(), onUnavailable: vi.fn() };
  const { rerender } = render(<GatewayLibraryBrowser {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看 夕照提示词' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<GatewayLibraryBrowser {...props} revision={2} />);
  await waitFor(() => expect(listGatewayAssets).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<GatewayLibraryBrowser {...props} revision={3} available={false} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
