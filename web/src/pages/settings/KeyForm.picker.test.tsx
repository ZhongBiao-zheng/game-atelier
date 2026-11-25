import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createKey, patchKey, previewModels, type ModelsPreview } from '@/api/keys';
import { listHttpProtocols } from '@/api/httpProtocols';
import { KeyForm } from './KeyForm';

vi.mock('@/api/keys', async original => ({ ...await original<typeof import('@/api/keys')>(),
  createKey: vi.fn(), patchKey: vi.fn(), previewModels: vi.fn() }));
vi.mock('@/api/httpProtocols', async original => ({ ...await original<typeof import('@/api/httpProtocols')>(), listHttpProtocols: vi.fn() }));

const remote: ModelsPreview = { models: [
  { id: 'chat-demo', name: 'Chat', category: 'text', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] },
  { id: 'image-demo', name: 'Image', category: 'image', modality: 'image', protocol: 'openai', input_modalities: [] },
], total: 2, excluded: 0 };
const initial = { alias: 'vendor', provider: 'custom', base_url: 'http://127.0.0.1:9999/v1', access_key: 'test-only',
  models: [{ id: 'chat-demo', name: 'Chat', modality: 'text' as const, protocol: 'openai-chat' }] };
const open = (mode: 'create' | 'edit' = 'create') => render(<KeyForm presetId="custom" mode={mode} initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [] });
  vi.mocked(previewModels).mockResolvedValue(remote);
  vi.mocked(createKey).mockResolvedValue({ alias: 'vendor' });
  vi.mocked(patchKey).mockResolvedValue(undefined);
});

it('keeps selected chips pressed across search and category changes, and toggles them off', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  const chip = await screen.findByRole('button', { name: 'Chat chat-demo' });
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(chip).toHaveClass('aria-pressed:bg-primary/10', 'aria-pressed:text-foreground');
  expect(chip.querySelector('svg')).not.toBeNull();
  const image = screen.getByRole('button', { name: 'Image image-demo' });
  expect(image).toHaveAttribute('aria-pressed', 'false');
  expect(image.querySelector('svg')).toBeNull();
  fireEvent.click(image);
  fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: 'chat' } });
  expect(screen.queryByRole('button', { name: 'Image image-demo' })).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: '' } });
  const filters = within(screen.getByRole('radiogroup', { name: '模型类型筛选' }));
  fireEvent.click(filters.getByRole('radio', { name: '图片 1' }));
  expect(screen.getByRole('button', { name: 'Image image-demo' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(filters.getByRole('radio', { name: '全部 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chat chat-demo' }));
  expect(screen.getByRole('button', { name: 'Chat chat-demo' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: '启用所选（1）' }));
  expect(screen.getByRole('button', { name: 'image-demo' })).toHaveClass('bg-primary/10');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'image-demo' })] })));
});

it.each(['create', 'edit'] as const)('refreshes the list once after a successful connection in %s without selecting new models', async mode => {
  open(mode);
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('可用');
  expect(await screen.findByRole('button', { name: 'Chat chat-demo' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Image image-demo' })).toHaveAttribute('aria-pressed', 'false');
  expect(previewModels).toHaveBeenCalledOnce();
  expect(previewModels).toHaveBeenCalledWith(expect.objectContaining({ access_key: mode === 'edit' ? null : 'test-only' }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(mode === 'edit' ? patchKey : createKey).toHaveBeenCalledOnce());
  const payload = mode === 'edit' ? vi.mocked(patchKey).mock.calls[0][1] : vi.mocked(createKey).mock.calls[0][0];
  expect(payload.models).toEqual([expect.objectContaining({ id: 'chat-demo' })]);
});

it('keeps a loaded list and pending selections when connection fails without another refresh', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Image image-demo' }));
  vi.mocked(previewModels).mockRejectedValue(new Error('连接失败'));
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(previewModels).toHaveBeenCalledTimes(2); // 首次列表 + 连接探测，没有后续刷新。
  expect(screen.getByRole('button', { name: 'Image image-demo' })).toHaveAttribute('aria-pressed', 'true');
});

it('preserves pending selections made during refresh even when the new list omits the model', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  await screen.findByRole('button', { name: 'Image image-demo' });
  let finish!: (result: ModelsPreview) => void;
  vi.mocked(previewModels).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  fireEvent.click(screen.getByRole('button', { name: 'Image image-demo' }));
  finish({ ...remote, models: remote.models.slice(0, 1), total: 1 });
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
  expect(vi.mocked(createKey).mock.calls[0][0].models?.map(m => m.id)).toEqual(['chat-demo', 'image-demo']);
});

it('retains connection success and selections if a custom catalog cannot be loaded', async () => {
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [{ id: 'hp-aaaaaaaaaaaa', name: '目录', kind: 'image', available: true, error: null, declared: null, catalog: true, used_by: [] }] });
  const { chooseOption } = await import('@/test/select');
  open();
  await chooseOption(await screen.findByLabelText('模型目录'), '目录');
  vi.mocked(previewModels).mockResolvedValueOnce(remote).mockRejectedValueOnce(new Error('目录不可用'));
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('可用');
  expect(await screen.findByRole('alert')).toHaveTextContent('目录不可用');
  expect(previewModels).toHaveBeenCalledTimes(2);
  expect(previewModels).toHaveBeenLastCalledWith(expect.objectContaining({ protocol_id: 'hp-aaaaaaaaaaaa' }));
  expect(screen.getByRole('button', { name: 'chat-demo' })).toHaveAttribute('aria-pressed', 'true');
});

it.each(['create', 'edit'] as const)('collapses manual entry by default and does not persist it in %s', async mode => {
  const view = open(mode);
  const summary = screen.getByText('手动添加模型');
  expect(summary.closest('button')).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(summary);
  expect(summary.closest('button')).toHaveAttribute('aria-expanded', 'true');
  fireEvent.change(screen.getByLabelText('添加模型 ID'), { target: { value: 'manual-demo' } });
  fireEvent.click(screen.getByRole('button', { name: '添加', hidden: true }));
  expect(screen.getByRole('button', { name: 'manual-demo' })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
  open(mode);
  expect(screen.getByText('手动添加模型').closest('button')).toHaveAttribute('aria-expanded', 'false');
});

it.each(['获取失败', '上游没有模型列表接口（HTTP 404）'])('opens manual entry when the list is unavailable: %s', async message => {
  vi.mocked(previewModels).mockRejectedValue(new Error(message));
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  await waitFor(() => expect(screen.getByText('手动添加模型').closest('button')).toHaveAttribute('aria-expanded', 'true'));
  expect(screen.getByRole('button', { name: 'chat-demo' })).toBeInTheDocument();
});

it('opens manual entry after a failed connection without adding a second error', async () => {
  vi.mocked(previewModels).mockRejectedValue(new Error('列表接口不可用'));
  open();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('列表接口不可用');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByText('手动添加模型').closest('button')).toHaveAttribute('aria-expanded', 'true');
});

it('does not save an unclassified selection as an image when a refresh hides it', async () => {
  const filtered = { ...remote, total: 3, excluded: 1 };
  vi.mocked(previewModels).mockResolvedValueOnce(filtered).mockResolvedValueOnce({
    ...filtered, models: [...remote.models, { id: 'embed', name: 'Embed', category: 'excluded',
      modality: null, protocol: null, input_modalities: [] }],
  }).mockResolvedValueOnce(filtered);
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  fireEvent.click(await screen.findByRole('button', { name: '显示全部' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Embed embed' }));
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '只看可生成模型' }));
  await screen.findByRole('button', { name: '显示全部' });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
  expect(vi.mocked(createKey).mock.calls[0][0].models?.map(m => m.id)).toEqual(['chat-demo']);
});

it('blocks list requests while the connection test owns the refresh', async () => {
  const filtered = { ...remote, total: 3, excluded: 1 };
  vi.mocked(previewModels).mockResolvedValueOnce(filtered);
  open();
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  const showAll = await screen.findByRole('button', { name: '显示全部' });
  let finish!: (value: ModelsPreview) => void;
  vi.mocked(previewModels).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  const all = within(screen.getByRole('radiogroup', { name: '模型范围' })).getByRole('radio', { name: '全部' });
  expect(all).toBeDisabled();
  expect(showAll).toBeDisabled();
  fireEvent.click(showAll);
  expect(previewModels).toHaveBeenCalledTimes(2);
  finish(filtered);
  await waitFor(() => expect(showAll).toBeEnabled());
  expect(all).toBeEnabled();
});

it.each([
  { refresh: '重新获取', listed: false },
  { refresh: '测试连接', listed: true },
  { refresh: '重新获取', listed: true },
])('preserves the default-image detail row after $refresh (listed=$listed)', async ({ refresh, listed }) => {
  open();
  fireEvent.click(screen.getByText('模型详情'));
  fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
  fireEvent.change(screen.getByLabelText('模型 ID 2'), { target: { value: 'my-model' } });
  fireEvent.change(screen.getByLabelText('模型名称 2'), { target: { value: '我的图片模型' } });
  if (listed) {
    const classified = refresh === '测试连接';
    vi.mocked(previewModels).mockResolvedValueOnce({ ...remote, total: 3, models: [...remote.models,
      { id: 'my-model', name: '上游名称', category: classified ? 'image' : 'unknown', modality: classified ? 'image' : null, protocol: null, input_modalities: [] },
    ] });
  }
  fireEvent.click(screen.getByRole('button', { name: refresh }));
  await screen.findByRole('textbox', { name: '搜索模型' });
  expect(screen.getByLabelText('模型名称 2')).toHaveValue('我的图片模型');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(createKey).toHaveBeenCalledOnce());
  expect(vi.mocked(createKey).mock.calls[0][0].models).toContainEqual(expect.objectContaining({
    id: 'my-model', name: '我的图片模型', modality: 'image',
  }));
});

it('keeps an edited name and unsaved price when the upstream lists the same image model', async () => {
  render(<KeyForm presetId="custom" mode="edit" initial={{ ...initial, models: [{
    id: 'image-demo', name: '原名', unpriced: true, per_call_cny: 1,
  }] }} onCreated={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByText('模型详情'));
  fireEvent.change(screen.getByLabelText('模型名称 1'), { target: { value: '改过的名称' } });
  fireEvent.change(screen.getByLabelText('单价 1'), { target: { value: '0.35' } });
  fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
  await screen.findByRole('textbox', { name: '搜索模型' });
  expect(screen.getByLabelText('单价 1')).toHaveValue('0.35');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(patchKey).toHaveBeenCalledOnce());
  expect(vi.mocked(patchKey).mock.calls[0][1].models).toEqual([
    expect.objectContaining({ id: 'image-demo', name: '改过的名称', per_call_cny: 0.35, modality: 'image' }),
  ]);
});

it('keeps the connection test busy through the custom catalog request', async () => {
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [{ id: 'hp-aaaaaaaaaaaa', name: '目录', kind: 'image', available: true, error: null, declared: null, catalog: true, used_by: [] }] });
  const { chooseOption } = await import('@/test/select');
  let finish!: (result: ModelsPreview) => void;
  vi.mocked(previewModels).mockResolvedValueOnce(remote).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  open();
  await chooseOption(await screen.findByLabelText('模型目录'), '目录');
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(previewModels).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: /^测试中/ })).toBeDisabled();
  finish(remote);
  await screen.findByRole('button', { name: 'Chat chat-demo' });
  expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
});
