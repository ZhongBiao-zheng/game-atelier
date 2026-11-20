import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKey, patchKey, previewModels } from '@/api/keys';
import { chooseOption } from '@/test/select';
import { KeyForm } from './KeyForm';
import { PROVIDER_PRESETS, presetInitial, providerPresetId } from './providerPresets';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  getChatGPTSubscription: vi.fn(),
  createKey: vi.fn(),
  patchKey: vi.fn(),
  previewModels: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

const custom = PROVIDER_PRESETS.find(preset => preset.id === 'custom')!;
const openCustom = () => render(<KeyForm presetId="custom"
  initial={{ ...presetInitial(custom, 'https://relay.example/v1'), alias: 'relay', access_key: 'sk-test-0123',
    models: [{ id: 'claude-x', name: 'Claude', modality: 'text' }, { id: 'img', name: '图', modality: 'image' }] }}
  onCreated={vi.fn()} onCancel={vi.fn()} />);

// ADR-0044：自定义供应商可以手动选对话接口；预置的接口是确定的，不显示。
describe('对话接口', () => {
  it('自定义地址显示「对话接口」，默认自动', () => {
    openCustom();
    expect(screen.getByRole('combobox', { name: '对话接口' })).toHaveTextContent('自动');
  });

  it('预置供应商不显示「对话接口」', () => {
    const tuzi = PROVIDER_PRESETS.find(preset => preset.id === 'tuzi')!;
    render(<KeyForm presetId="tuzi" initial={presetInitial(tuzi)} onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: '对话接口' })).not.toBeInTheDocument();
  });

  it('选 Anthropic 后保存：带上接口，文本模型按它调用，图片模型不动', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openCustom();
    await chooseOption(screen.getByRole('combobox', { name: '对话接口' }), 'Anthropic');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    const payload = vi.mocked(createKey).mock.calls[0][0];
    expect(payload.text_protocol).toBe('anthropic-messages');
    expect(payload.models!.map(model => [model.id, model.protocol])).toEqual([
      ['claude-x', 'anthropic-messages'], ['img', null]]);
  });

  it('自动时不提交接口字段', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    openCustom();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    expect(vi.mocked(createKey).mock.calls[0][0]).not.toHaveProperty('text_protocol');
  });

  it('测试连接按当前选的接口列模型', async () => {
    vi.mocked(previewModels).mockResolvedValue({ models: [], total: 0, excluded: 0 });
    openCustom();
    await chooseOption(screen.getByRole('combobox', { name: '对话接口' }), 'Anthropic');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(previewModels).toHaveBeenCalled());
    expect(vi.mocked(previewModels).mock.calls[0][0].text_protocol).toBe('anthropic-messages');
  });

  it('编辑时改回自动提交 null，未改动不提交', async () => {
    vi.mocked(patchKey).mockResolvedValue(undefined);
    const initial = { alias: 'relay', provider: 'custom', base_url: 'https://relay.example/v1', access_key: 'sk...mask',
      text_protocol: 'anthropic-messages', models: [{ id: 'claude-x', name: 'Claude', modality: 'text' as const,
        protocol: 'anthropic-messages' }] };
    const { unmount } = render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patchKey).mock.calls[0][1]).not.toHaveProperty('text_protocol');
    unmount();
    render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    await chooseOption(screen.getByRole('combobox', { name: '对话接口' }), '自动');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchKey).toHaveBeenCalledTimes(2));
    expect(vi.mocked(patchKey).mock.calls[1][1].text_protocol).toBeNull();
  });
});

describe('Anthropic 预置', () => {
  const anthropic = PROVIDER_PRESETS.find(preset => preset.id === 'anthropic')!;

  it('按域名识别，接口固定为 Anthropic', () => {
    expect(providerPresetId({ provider: 'custom', base_url: 'https://api.anthropic.com' })).toBe('anthropic');
    expect(presetInitial(anthropic)).toMatchObject({ provider: 'custom', text_protocol: 'anthropic-messages' });
  });

  it('保存时带上接口，不显示对话接口下拉', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'Anthropic' });
    render(<KeyForm presetId="anthropic" initial={{ ...presetInitial(anthropic), access_key: 'sk-ant-0123' }}
      onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: '对话接口' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '新增模型类型' })).toHaveTextContent('对话');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    const payload = vi.mocked(createKey).mock.calls[0][0];
    expect(payload).toMatchObject({ provider: 'custom', base_url: 'https://api.anthropic.com',
      text_protocol: 'anthropic-messages' });
    expect(payload.models![0]).toMatchObject({ id: 'claude-sonnet-5-5', protocol: 'anthropic-messages' });
  });
});
