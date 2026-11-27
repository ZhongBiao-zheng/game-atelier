import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKey, patchKey, previewModels } from '@/api/keys';
import { chooseOption } from '@/test/select';
import { KeyForm, autoInterfaceText } from './KeyForm';
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

  it('选 Gemini 后保存与测试连接都带上 gemini-generate-content（第 5 批）', async () => {
    vi.mocked(createKey).mockResolvedValue({ alias: 'relay' });
    vi.mocked(previewModels).mockResolvedValue({ models: [], total: 0, excluded: 0 });
    openCustom();
    await chooseOption(screen.getByRole('combobox', { name: '对话接口' }), 'Gemini');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(previewModels).toHaveBeenCalled());
    expect(vi.mocked(previewModels).mock.calls[0][0].text_protocol).toBe('gemini-generate-content');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createKey).toHaveBeenCalled());
    const payload = vi.mocked(createKey).mock.calls[0][0];
    expect(payload.text_protocol).toBe('gemini-generate-content');
    expect(payload.models!.map(model => [model.id, model.protocol])).toEqual([
      ['claude-x', 'gemini-generate-content'], ['img', null]]);
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

  it('服务端标了 agent_unverified 的模型行显示「不进 Agent」（第 3 批）', () => {
    const initial = { alias: 'relay', provider: 'custom', base_url: 'https://relay.example', access_key: 'sk...mask',
      models: [
        { id: 'gemini-x', name: 'Gemini X', modality: 'text' as const, protocol: 'gemini-generate-content',
          agent_unverified: true },
        { id: 'gpt-x', name: 'GPT X', modality: 'text' as const, protocol: 'openai-chat' },
      ] };
    render(<KeyForm mode="edit" initial={initial} onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('模型详情'));
    expect(screen.getAllByText('不进 Agent')).toHaveLength(1);
    expect(screen.getByLabelText('不进 Agent 说明')).toBeInTheDocument();
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

// ADR-0044 第 3 批：「自动」后面显示识别结果；识别结果不存进 KEY，重开表单按已存模型的协议汇总。
describe('自动 · 识别结果', () => {
  it('优先用本次检测的结果，New API 带站点名', () => {
    expect(autoInterfaceText({ protocol: 'openai-chat', family: 'new-api', label: '兔子API v0.9' }, [])).toBe('New API（兔子API v0.9）');
    expect(autoInterfaceText({ protocol: 'openai-chat', family: 'new-api', label: null }, [])).toBe('New API');
    expect(autoInterfaceText({ protocol: 'anthropic-messages', family: 'anthropic', label: null }, [])).toBe('Anthropic');
  });

  it('没检测过时按已存的文本模型协议汇总', () => {
    const text = (protocol: string | null) => ({ modality: 'text', protocol });
    expect(autoInterfaceText(null, [text('anthropic-messages'), text('anthropic-messages')])).toBe('Anthropic');
    expect(autoInterfaceText(null, [text(null)])).toBe('OpenAI Chat');
    expect(autoInterfaceText(null, [text('openai-chat'), text('gemini-generate-content')])).toBe('逐模型');
    expect(autoInterfaceText(null, [{ modality: 'image', protocol: null }])).toBe('');
  });

  it('测试连接拿到识别结果后，下拉显示「自动 · New API（站点名）」', async () => {
    vi.mocked(previewModels).mockResolvedValue({ models: [], total: 0, excluded: 0,
      detected: { protocol: 'openai-chat', family: 'new-api', label: '兔子API v0.9' } });
    openCustom();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '对话接口' }))
      .toHaveTextContent('自动 · New API（兔子API v0.9）'));
  });
});

// ADR-0044 第 3 批的六家对话模型预置：没用真实密钥核对过的模型 id 不写死（管理会话 2026-11-20 定）。
describe('六家对话模型预置', () => {
  const byId = (id: string) => PROVIDER_PRESETS.find(preset => preset.id === id)!;

  it.each([
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.moonshot.cn/v1', 'kimi'],
    ['https://api.moonshot.ai/v1', 'kimi'],
    ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen'],
    ['https://api.siliconflow.cn/v1', 'siliconflow'],
  ])('按域名识别 %s → %s，预置地址也落在这个域名上', (url, id) => {
    expect(providerPresetId({ provider: 'custom', base_url: url })).toBe(id);
    expect(providerPresetId({ provider: 'custom', base_url: byId(id).defaultBaseUrl })).toBe(id);
    expect(byId(id)).toMatchObject({ value: 'custom', modalities: ['llm'] });
  });

  it('能拉模型列表的五家不带默认模型；通义只带 qwen-plus', () => {
    for (const id of ['gemini', 'deepseek', 'kimi', 'zhipu', 'siliconflow']) expect(byId(id).defaultModels).toEqual([]);
    expect(byId('qwen').defaultModels.map(model => [model.id, model.modality, model.protocol])).toEqual([
      ['qwen-plus', 'text', 'openai-chat']]);
  });

  it('Tuzi 推荐预置带 Midjourney 和一个能看图的便宜对话模型，新用户直接能用 Agent', () => {
    expect(byId('tuzi').defaultModels.map(model => [model.id, model.modality, model.protocol, model.input_modalities])).toEqual([
      ['gpt-image-2', 'image', undefined, undefined],
      ['mj_imagine', 'image', undefined, undefined],
      ['gemini-3.1-flash-lite', 'text', 'openai-chat', ['text', 'image']]]);
    // 计费分组不填就不计价；首启引导让用户在 Tuzi 建 Key 时选 default，预置跟着填上。
    expect(presetInitial(byId('tuzi')).billing_group).toBe('default');
  });
});
