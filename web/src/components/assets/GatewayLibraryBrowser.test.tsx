import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readTeamMedia } from './teamAssetUse';
vi.mock('./teamAssetUse', () => ({ readTeamMedia: vi.fn() }));
import { fetchProfile } from '@/api/teamLibraries';
import { TeamLibraryPanel } from './TeamLibraryPanel';
import { GatewayLibraryBrowser } from './GatewayLibraryBrowser';
import { listGatewayAssets, listGatewayLibraries, type GatewayLibrarySelection } from '@/api/gatewayLibraries';
vi.mock('@/api/gatewayLibraries', async original => ({ ...await original<typeof import('@/api/gatewayLibraries')>(),
  listGatewayLibraries: vi.fn(), listGatewayAssets: vi.fn() }));
vi.mock('@/api/teamLibraries', () => ({ listTeamLibraries: vi.fn(async () => []), fetchProfile: vi.fn(async () => ({ display_name: null })), listRelatedTeamAssets: vi.fn(async () => []) }));
const library: GatewayLibrarySelection = { alias: '林晓网关', id: 'lib_0123456789abcdef', name: '画面参考', owner_name: '林晓', updated_at: 'now', counts: {} };
const entries = [
  { entry_id: 'ta_image', kind: 'raw' as const, title: '风景.png', mime_type: 'image/png', tags: [], preview_count: 0, has_content: true },
  { entry_id: 'ta_video', kind: 'raw' as const, title: '片段.mp4', mime_type: 'video/mp4', tags: [], preview_count: 0, has_content: true },
  { entry_id: 'ta_prompt', kind: 'prompt' as const, title: '夕照提示词', author: '林晓', prompt_text: '山谷夕照', tags: [], preview_count: 2 },
];
beforeEach(() => {
  vi.mocked(fetchProfile).mockResolvedValue({ display_name: null });
  vi.mocked(listGatewayLibraries).mockResolvedValue([{ gateway_alias: library.alias, owner_name: '林晓', unreachable: false, libraries: [library] }]);
  vi.mocked(listGatewayAssets).mockResolvedValue(entries);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('无本地项目默认选中首个同事共享，展示缩略图和使用入口，没有复刻与采用动作', async () => {
  const { container } = render(<TeamLibraryPanel projectId="" onUseMedia={vi.fn()} />);
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
  render(<TeamLibraryPanel projectId="" onUseMedia={vi.fn()} />);
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

it('同事库使用通过 content 代理取文件并传给创作端，提示词直接填入', async () => {
  const media = vi.fn(), prompt = vi.fn();
  const file = new File(['image'], '风景.png', { type: 'image/png' });
  vi.mocked(readTeamMedia).mockResolvedValue(file);
  render(<GatewayLibraryBrowser library={library} available revision={1} onRefresh={vi.fn()} onUnavailable={vi.fn()} onUseMedia={media} onUsePrompt={prompt} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '使用' }))[0]);
  await waitFor(() => expect(media).toHaveBeenCalledWith(file, expect.objectContaining({ id: 'ta_image' }), `${library.alias}:${library.id}:ta_image`));
  expect(readTeamMedia).toHaveBeenCalledWith(expect.stringContaining('/ta_image/content'), expect.any(Object));
  const promptUse = within(screen.getByRole('button', { name: '查看 夕照提示词' }).parentElement!).getByRole('button', { name: '使用' });
  await waitFor(() => expect(promptUse).not.toBeDisabled());
  fireEvent.click(promptUse);
  expect(prompt).toHaveBeenCalledWith('山谷夕照', expect.objectContaining({ id: 'ta_prompt' }));
});

it('没有本地或同事共享库时明确显示尚无团队库', async () => {
  vi.mocked(listGatewayLibraries).mockResolvedValue([]);
  render(<TeamLibraryPanel projectId="" />);
  expect(await screen.findByText('还没有团队库')).toBeInTheDocument();
  expect(screen.queryByText('库里还没有内容')).toBeNull();
  expect(listGatewayAssets).not.toHaveBeenCalled();
});
