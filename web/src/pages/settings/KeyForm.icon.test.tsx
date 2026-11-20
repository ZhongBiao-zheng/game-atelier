import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKey, patchKey } from '@/api/keys';
import { uploadProviderIcon } from '@/api/providerIcons';
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
    vi.mocked(uploadProviderIcon).mockRejectedValue(new Error('上传图标失败：只支持 PNG、JPEG、WebP、GIF、ICO 图片'));
    openNew();
    fireEvent.click(screen.getByRole('button', { name: '更换图标' }));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '上传' }), { button: 0 });
    const file = new File(['<svg/>'], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('图标图片'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('只支持');
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
