import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKey, patchKey } from '@/api/keys';
import { ApiError } from '@/api/http';
import { defaultIconUrl, fetchProviderIcon, uploadProviderIcon } from '@/api/providerIcons';
import { KeyForm } from './KeyForm';
import { PROVIDER_PRESETS, presetInitial } from './providerPresets';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  getChatGPTSubscription: vi.fn(),
  createKey: vi.fn(),
  patchKey: vi.fn(),
  previewModels: vi.fn(),
}));
vi.mock('@/api/providerIcons', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/providerIcons')>(),
  uploadProviderIcon: vi.fn(),
  fetchProviderIcon: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

const SHA = 'a'.repeat(64);
const custom = PROVIDER_PRESETS.find(preset => preset.id === 'custom')!;
const openNew = () => render(<KeyForm presetId="custom"
  initial={{ ...presetInitial(custom, 'https://relay.example/v1'), alias: 'relay', access_key: 'sk-test-0123',
    models: [{ id: 'gpt-x', name: 'GPT', modality: 'text' }] }}
  onCreated={vi.fn()} onCancel={vi.fn()} />);
const editInitial = (icon?: string) => ({ alias: 'relay', provider: 'custom', base_url: 'https://relay.example/v1',
  access_key: 'sk...mask', icon, models: [{ id: 'gpt-x', name: 'GPT', modality: 'text' as const }] });

// I1：表单头部的图标是弹层入口；选的图标随表单保存写进 KEY。
describe('供应商图标弹层', () => {
  it('没设图标的自定义供应商显示名称首字母', () => {
    openNew();
    expect(screen.getByRole('button', { name: '更换图标' }).querySelector('[data-icon="initial"]')).toHaveTextContent('R');
  });

  it('选内置品牌后保存带上 icon', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.click(await screen.findByRole('button', { name: 'DeepSeek' }));
    expect(screen.getByRole('button', { name: '更换图标' }).querySelector('[data-icon="initial"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    expect(vi.mocked(createKey).mock.calls[0][0].icon).toBe('brand:deepseek');
  });

  it('没选图标时不提交 icon', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    expect(vi.mocked(createKey).mock.calls[0][0]).not.toHaveProperty('icon');
  });

  it('上传成功后显示图片，保存带上 file: 引用', async () => {
    vi.mocked(uploadProviderIcon).mockResolvedValue({ icon: `file:${SHA}` });
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '上传' }), { button: 0 });
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('图标图片'), { target: { files: [file] } });
    await waitFor(() => expect(uploadProviderIcon).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByRole('button', { name: '更换图标' }).querySelector('img'))
      .toHaveAttribute('src', `/api/provider-icons/${SHA}`));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    expect(vi.mocked(createKey).mock.calls[0][0].icon).toBe(`file:${SHA}`);
  });

  it('上传被拒时在弹层里显示服务端的原因', async () => {
    vi.mocked(uploadProviderIcon).mockRejectedValue(new ApiError('上传图标失败：不支持这种图片格式（HTTP 422）',
      { status: 422, reason: '不支持这种图片格式' }));
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '上传' }), { button: 0 });
    const file = new File(['<svg/>'], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('图标图片'), { target: { files: [file] } });
    expect((await screen.findByRole('alert')).textContent).toBe('不支持这种图片格式');
  });

  it('编辑时恢复默认提交 null，没改动不提交', async () => {
    vi.mocked(patchKey).mockResolvedValue(undefined);
    const { unmount } = render(<KeyForm mode="edit" initial={editInitial('brand:gemini')} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patchKey).mock.calls[0][1]).not.toHaveProperty('icon');
    unmount();
    render(<KeyForm mode="edit" initial={editInitial('brand:gemini')} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledTimes(2));
    expect(vi.mocked(patchKey).mock.calls[1][1].icon).toBeNull();
  });
});

// I1 6/n：按网址获取，默认填官网，没有官网时取接口地址的 origin。
describe('按网址获取图标', () => {
  it('默认地址：官网优先，其次接口地址的 origin', () => {
    expect(defaultIconUrl('https://home.example', 'https://api.example/v1')).toBe('https://home.example');
    expect(defaultIconUrl('', 'https://api.example/v1')).toBe('https://api.example');
    expect(defaultIconUrl(null, 'not a url')).toBe('');
  });

  it('网址页签预填接口地址的 origin，获取成功后保存带上引用', async () => {
    vi.mocked(fetchProviderIcon).mockResolvedValue({ icon: `file:${SHA}` });
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '网址' }), { button: 0 });
    expect(await screen.findByLabelText('图标网址')).toHaveValue('https://relay.example');
    fireEvent.click(screen.getByRole('button', { name: '获取' }));
    await waitFor(() => expect(fetchProviderIcon).toHaveBeenCalledWith('https://relay.example'));
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    expect(vi.mocked(createKey).mock.calls[0][0].icon).toBe(`file:${SHA}`);
  });

  it('取不到时显示原因', async () => {
    vi.mocked(fetchProviderIcon).mockRejectedValue(new ApiError('获取图标失败：没有找到图标（HTTP 422）',
      { status: 422, reason: '没有找到图标' }));
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '网址' }), { button: 0 });
    fireEvent.change(await screen.findByLabelText('图标网址'), { target: { value: 'https://other.example' } });
    fireEvent.click(screen.getByRole('button', { name: '获取' }));
    await waitFor(() => expect(fetchProviderIcon).toHaveBeenCalledWith('https://other.example'));
    expect((await screen.findByRole('alert')).textContent).toBe('没有找到图标');
  });
});

// 验收 F10：请求进行中用户另做了选择，之后回来的结果丢弃，不能盖掉用户后做的选择。
describe('进行中的请求被后来的选择取代', () => {
  const deferred = () => {
    let resolve!: (value: { icon: string }) => void;
    const promise = new Promise<{ icon: string }>(done => { resolve = done; });
    return { promise, resolve };
  };
  const startUpload = async () => {
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '上传' }), { button: 0 });
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('图标图片'), { target: { files: [file] } });
    await waitFor(() => expect(uploadProviderIcon).toHaveBeenCalled());
  };
  const savedIcon = async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    return vi.mocked(createKey).mock.calls[0][0].icon;
  };

  it('上传中选了品牌：上传结果丢弃', async () => {
    const pending = deferred();
    vi.mocked(uploadProviderIcon).mockReturnValue(pending.promise);
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    await startUpload();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '品牌' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'DeepSeek' }));
    await act(async () => { pending.resolve({ icon: `file:${SHA}` }); });
    expect(await savedIcon()).toBe('brand:deepseek');
  });

  it('上传中点了恢复默认：上传结果丢弃', async () => {
    const pending = deferred();
    vi.mocked(uploadProviderIcon).mockReturnValue(pending.promise);
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    render(<KeyForm presetId="custom" initial={{ ...presetInitial(custom, 'https://relay.example/v1'), alias: 'relay',
      access_key: 'sk-test-0123', icon: 'brand:gemini', models: [{ id: 'gpt-x', name: 'GPT', modality: 'text' }] }}
      onCreated={vi.fn()} onCancel={vi.fn()} />);
    await startUpload();
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await act(async () => { pending.resolve({ icon: `file:${SHA}` }); });
    expect(await savedIcon()).toBeUndefined();
  });

  it('获取中关了弹层：结果与报错都丢弃', async () => {
    const pending = deferred();
    vi.mocked(fetchProviderIcon).mockReturnValue(pending.promise);
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '网址' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: '获取' }));
    await waitFor(() => expect(fetchProviderIcon).toHaveBeenCalled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tab', { name: '网址' })).toBeNull());
    await act(async () => { pending.resolve({ icon: `file:${SHA}` }); });
    expect(screen.getByRole('button', { name: '更换图标' }).querySelector('img')).toBeNull();
    expect(await savedIcon()).toBeUndefined();
  });
});
