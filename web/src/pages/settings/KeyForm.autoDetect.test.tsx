import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createKey, previewModels, type RemoteModel } from '@/api/keys';
import { listHttpProtocols } from '@/api/httpProtocols';
import { probeKey, recordOnboardingEvent } from '@/api/onboarding';
import { KeyForm } from './KeyForm';
import { PROVIDER_PRESETS, presetInitial } from './providerPresets';

vi.mock('@/api/keys', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/keys')>(),
  createKey: vi.fn(),
  previewModels: vi.fn(),
}));
vi.mock('@/api/httpProtocols', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/httpProtocols')>(),
  listHttpProtocols: vi.fn(),
}));
vi.mock('@/api/onboarding', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/onboarding')>(),
  probeKey: vi.fn(),
  recordOnboardingEvent: vi.fn(),
}));

const remote = (id: string, modality: RemoteModel['modality']): RemoteModel => ({
  id, name: id, modality, category: modality ?? 'unknown', protocol: null, input_modalities: [],
});

const tuzi = PROVIDER_PRESETS.find(preset => preset.id === 'tuzi')!;
const open = (autoDetect = true) => render(<KeyForm presetId="tuzi" initial={presetInitial(tuzi)} autoDetect={autoDetect}
  submitLabel="保存并开始" onCreated={vi.fn()} onCancel={vi.fn()} />);
const paste = (value = 'sk-onboarding-test') =>
  fireEvent.change(screen.getByPlaceholderText('粘贴密钥'), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listHttpProtocols).mockResolvedValue({ protocols: [] });
  vi.mocked(createKey).mockResolvedValue({ alias: 'Tuzi' });
  vi.mocked(probeKey).mockResolvedValue('ok');
  vi.mocked(recordOnboardingEvent).mockResolvedValue();
});

it('pastes a key, detects models and preselects only known image and video models', async () => {
  vi.mocked(previewModels).mockResolvedValue({
    models: [
      remote('gpt-image-2', 'image'), remote('nano-banana-pro', 'image'), remote('doubao-seedance-2-0-260128', 'video'),
      remote('minimax-speech-2.8-turbo', 'audio'), remote('mystery-image-x', 'image'), remote('gpt-5', 'text'),
      remote('who-knows', null),
    ],
    total: 7, excluded: 0,
  });
  open();
  paste();
  await waitFor(() => expect(previewModels).toHaveBeenCalledWith(expect.objectContaining({
    access_key: 'sk-onboarding-test', base_url: 'https://api.tu-zi.com', include_all: false,
  })));
  expect(await screen.findByRole('radio', { name: '已选 3' })).toBeInTheDocument();
  expect(await screen.findByRole('status')).toHaveTextContent('Key 有效');
  expect(probeKey).toHaveBeenCalledWith('tuzi', 'sk-onboarding-test');
  expect(recordOnboardingEvent).toHaveBeenCalledWith({ event: 'models_detected', count: 3 });

  fireEvent.click(screen.getByRole('button', { name: '保存并开始' }));
  await waitFor(() => expect(createKey).toHaveBeenCalled());
  const payload = vi.mocked(createKey).mock.calls[0][0];
  expect((payload.models ?? []).map(model => [model.id, model.modality])).toEqual([
    ['gpt-image-2', 'image'], ['nano-banana-pro', 'image'], ['doubao-seedance-2-0-260128', 'video'],
  ]);
  expect(payload.modalities).toEqual(['image', 'video']);
  expect(payload.access_key).toBe('sk-onboarding-test');
});

it('keeps many preselected models valid for the selection view and the save payload', async () => {
  const ids = [
    'gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
    'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'nano-banana-2', 'nano-banana-pro', 'gemini-3-pro-image',
    'doubao-seedream-5-0-lite-260128', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-5-261028',
    'doubao-seedream-4-5-251128', 'mj_imagine', 'flux-3-image',
  ];
  const videos = ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628', 'veo3.1', 'sora-2-pro', 'kling-4.0', 'happyhorse-1.1'];
  vi.mocked(previewModels).mockResolvedValue({
    models: [...ids.map(id => remote(id, 'image')), ...videos.map(id => remote(id, 'video'))],
    total: ids.length + videos.length, excluded: 0,
  });
  open();
  paste();
  // 模型目录认不出的写法（veo3.1）不预选，其余 21 个全选上。
  const count = 21;
  expect(await screen.findByRole('radio', { name: `已选 ${count}` })).toBeInTheDocument();
  // 已选视图里每个预选模型都有一枚可点的芯片，保存按钮可用。
  expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(count);
  fireEvent.click(screen.getByRole('button', { name: '保存并开始' }));
  await waitFor(() => expect(createKey).toHaveBeenCalled());
  const models = vi.mocked(createKey).mock.calls[0][0].models ?? [];
  expect(models).toHaveLength(count);
  expect(new Set(models.map(model => model.id)).size).toBe(count);
  for (const model of models) expect(['image', 'video']).toContain(model.modality);
  expect(models.map(model => model.id)).not.toEqual(expect.arrayContaining(['veo3.1']));
  // 22 个模型的渲染平时 1–3 秒，机器负载高时超过默认的 5 秒（macOS CI 实测 6.1 秒）。
}, 20000);

it('shows an invalid key without blocking save', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [remote('gpt-image-2', 'image')], total: 1, excluded: 0 });
  vi.mocked(probeKey).mockResolvedValue('invalid');
  open();
  paste();
  expect(await screen.findByRole('alert')).toHaveTextContent('Key 无效');
  expect(screen.getByRole('button', { name: '保存并开始' })).toBeEnabled();
});

it('keeps the preset models and shows the fetch error when detection fails', async () => {
  vi.mocked(previewModels).mockRejectedValue(new Error('拉取模型列表失败：上游 401'));
  vi.mocked(probeKey).mockResolvedValue('unknown');
  open();
  paste();
  expect(await screen.findByText('拉取模型列表失败：上游 401')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '已选 1' })).toBeInTheDocument();
  expect(screen.queryByText(/Key 有效|Key 无效/)).not.toBeInTheDocument();
});

it('does nothing automatically outside the guide', async () => {
  open(false);
  paste();
  await new Promise(resolve => setTimeout(resolve, 700));
  expect(previewModels).not.toHaveBeenCalled();
  expect(probeKey).not.toHaveBeenCalled();
});

it('keeps the manual connection result when the onboarding timer fires afterwards', async () => {
  vi.mocked(previewModels).mockResolvedValue({ models: [remote('chat-demo', 'text')], total: 1, excluded: 0 });
  open();
  paste();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await screen.findByRole('button', { name: /chat-demo/ });
  // The separate key probe runs from the same timer, even when its list request is superseded.
  await waitFor(() => expect(probeKey).toHaveBeenCalledOnce());
  expect(previewModels).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox', { name: '搜索模型' })).toBeInTheDocument();
});
