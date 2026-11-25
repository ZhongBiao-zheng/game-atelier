import type { KeyCreatePayload, KeyModel } from '@/api/keys';

export type ProviderKind = 'official' | 'relay' | 'custom' | 'team' | 'subscription' | 'local';
type ApiModality = 'image' | 'video' | 'audio' | 'llm';

/** One identity rule for presets, settings and generation controls. */
export function providerPresetId(key?: { provider?: string; base_url?: string | null } | null): string {
  if (key?.provider && key.provider !== 'custom') return key.provider;
  try {
    const host = new URL(key?.base_url || '').hostname;
    for (const [domain, id] of [['tu-zi.com', 'tuzi'], ['openai-hk.com', 'openai-hk'], ['api.anthropic.com', 'anthropic'],
      ['generativelanguage.googleapis.com', 'gemini'], ['api.deepseek.com', 'deepseek'], ['api.moonshot.cn', 'kimi'],
      ['api.moonshot.ai', 'kimi'], ['open.bigmodel.cn', 'zhipu'], ['dashscope.aliyuncs.com', 'qwen'],
      ['api.siliconflow.cn', 'siliconflow']]) {
      if (host === domain || host.endsWith(`.${domain}`)) return id;
    }
  } catch { /* An unconfigured or invalid address is a custom provider. */ }
  return 'custom';
}


export interface ProviderPreset {
  id: string;
  value: string;
  label: string;
  kind: ProviderKind;
  modalities: ApiModality[];
  homepageUrl?: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  defaultBaseUrl?: string | null;
  defaultModels: KeyModel[];
  /** 对话接口固定的预置（ADR-0044）；不写 = 自动。 */
  textProtocol?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'comfyui', value: 'comfyui', label: 'ComfyUI', kind: 'local', modalities: ['image'], defaultBaseUrl: 'http://127.0.0.1:8188', defaultModels: [] },
  { id: 'openai', value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }, { name: 'GPT 5', id: 'gpt-5', modality: 'text', protocol: 'openai-responses', input_modalities: ['text'] }] },
  { id: 'anthropic', value: 'custom', label: 'Anthropic', kind: 'official', modalities: ['llm'], homepageUrl: 'https://www.anthropic.com', docsUrl: 'https://platform.claude.com/docs', apiKeyUrl: 'https://platform.claude.com/settings/keys', defaultBaseUrl: 'https://api.anthropic.com', textProtocol: 'anthropic-messages', defaultModels: [{ name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', modality: 'text', protocol: 'anthropic-messages', input_modalities: ['text', 'image'] }] },
  // 第 3 批（ADR-0044）的六家对话模型预置：只给地址、鉴权方式与申请链接，默认模型留空（没用真实密钥核对过的 id
  // 不写死，「测试连接」拉真实列表）。通义没有模型列表接口，保留官方文档点名支持工具调用的 qwen-plus。
  { id: 'gemini', value: 'custom', label: 'Google Gemini', kind: 'official', modalities: ['llm'], homepageUrl: 'https://ai.google.dev', docsUrl: 'https://aistudio.google.com/docs/openai', apiKeyUrl: 'https://aistudio.google.com/apikey', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModels: [] },
  { id: 'deepseek', value: 'custom', label: 'DeepSeek', kind: 'official', modalities: ['llm'], docsUrl: 'https://api-docs.deepseek.com', apiKeyUrl: 'https://platform.deepseek.com/api_keys', defaultBaseUrl: 'https://api.deepseek.com', defaultModels: [] },
  { id: 'kimi', value: 'custom', label: 'Kimi', kind: 'official', modalities: ['llm'], docsUrl: 'https://platform.kimi.com/docs', apiKeyUrl: 'https://platform.kimi.com/console/api-keys', defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultModels: [] },
  { id: 'zhipu', value: 'custom', label: '智谱', kind: 'official', modalities: ['llm'], homepageUrl: 'https://bigmodel.cn', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/quick-start', apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModels: [] },
  { id: 'qwen', value: 'custom', label: '通义', kind: 'official', modalities: ['llm'], docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', apiKeyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModels: [{ name: 'Qwen Plus', id: 'qwen-plus', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] }] },
  { id: 'siliconflow', value: 'custom', label: '硅基流动', kind: 'relay', modalities: ['llm'], docsUrl: 'https://docs.siliconflow.cn/cn/userguide/quickstart', apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak', defaultBaseUrl: 'https://api.siliconflow.cn/v1', defaultModels: [] },
  { id: 'seedream', value: 'seedream', label: 'Volcengine Ark', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://www.volcengine.com', docsUrl: 'https://www.volcengine.com/docs/82379/1399008', apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }, { name: '豆包 Seed 1.8', id: 'doubao-seed-1-8-251228', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] }] },
  { id: 'tokendance', value: 'tokendance', label: 'TokenDance', kind: 'relay', modalities: ['image', 'video'], homepageUrl: 'https://tokendance.space', docsUrl: 'https://tokendance.space/docs/quickstart', apiKeyUrl: 'https://tokendance.space/keys', defaultBaseUrl: 'https://tokendance.space/gateway/v1', defaultModels: [{ name: 'Seedream 5.0 Lite', id: 'seedream-5.0-lite', modality: 'image', protocol: 'openai' }, { name: 'Seedream 5.0 Pro', id: 'seedream-5.0-pro', modality: 'image', protocol: 'ark' }, { name: 'Seedance 2.0', id: 'seedance-2.0', modality: 'video', protocol: 'seedance' }] },
  { id: 'openrouter', value: 'openrouter', label: 'OpenRouter', kind: 'relay', modalities: ['image', 'video'], homepageUrl: 'https://openrouter.ai', docsUrl: 'https://openrouter.ai/docs/quickstart', apiKeyUrl: 'https://openrouter.ai/settings/keys', defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultModels: [{ name: 'GPT Image 2', id: 'openai/gpt-image-2', modality: 'image' }, { name: 'Google: Veo 3.1', id: 'google/veo-3.1', modality: 'video' }] },
  { id: 'evolink', value: 'evolink', label: 'EvoLink', kind: 'relay', modalities: ['image'], homepageUrl: 'https://evolink.ai', docsUrl: 'https://docs.evolink.ai', defaultBaseUrl: 'https://api.evolink.ai/v1', defaultModels: [{ name: 'Midjourney V8.2', id: 'mj-v8.2', modality: 'image', protocol: 'evolink' }] },
  { id: 'tuzi', value: 'custom', label: 'Tuzi', kind: 'relay', modalities: ['image', 'video', 'llm'], homepageUrl: 'https://tu-zi.com', apiKeyUrl: 'https://api.tu-zi.com', defaultBaseUrl: 'https://api.tu-zi.com', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' }] },
  { id: 'openai-hk', value: 'custom', label: 'OpenAI-HK', kind: 'relay', modalities: ['image', 'video', 'llm'], homepageUrl: 'https://www.openai-hk.com', apiKeyUrl: 'https://www.openai-hk.com/v3/ai', defaultBaseUrl: 'https://api.openai-hk.com', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' }] },
  { id: 'chatgpt', value: 'chatgpt', label: 'ChatGPT（Codex 登录）', kind: 'subscription', modalities: ['image'], defaultModels: [{ name: 'GPT Image', id: 'gpt-image-2', modality: 'image' }] },
  { id: 'custom', value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
  // 局域网里另一台开了团队网关的 Atelier（ADR-0025）：模型由网关决定，连接后自动带回。
  { id: 'atelier', value: 'atelier', label: '团队网关', kind: 'team', modalities: ['image'], defaultBaseUrl: '', defaultModels: [] },
];

/** 从预设打开新建表单时的初始值（添加页与首启引导共用）。 */
export function presetInitial(preset: ProviderPreset, baseUrl = preset.defaultBaseUrl): Partial<KeyCreatePayload> {
  return {
    provider: preset.value, alias: preset.kind === 'custom' ? '' : preset.label,
    base_url: baseUrl, models: preset.defaultModels, modalities: preset.modalities,
    homepage_url: preset.homepageUrl, docs_url: preset.docsUrl, api_key_url: preset.apiKeyUrl,
    ...(preset.textProtocol ? { text_protocol: preset.textProtocol } : {}),
  };
}
