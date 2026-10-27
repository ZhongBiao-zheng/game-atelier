import type { KeyModel } from '@/api/keys';

export type ProviderKind = 'official' | 'relay' | 'custom' | 'team';
type ApiModality = 'image' | 'video' | 'audio' | 'llm';

/** One identity rule for presets, settings and generation controls. */
export function providerPresetId(key?: { provider?: string; base_url?: string | null } | null): string {
  if (key?.provider && key.provider !== 'custom') return key.provider;
  try {
    const host = new URL(key?.base_url || '').hostname;
    for (const [domain, id] of [['tu-zi.com', 'tuzi'], ['openai-hk.com', 'openai-hk']]) {
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
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }, { name: 'GPT 5', id: 'gpt-5', modality: 'text', protocol: 'openai-responses', input_modalities: ['text'] }] },
  { id: 'seedream', value: 'seedream', label: 'Volcengine Ark', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://www.volcengine.com', docsUrl: 'https://www.volcengine.com/docs/82379/1399008', apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }, { name: '豆包 Seed 1.8', id: 'doubao-seed-1-8-251228', modality: 'text', protocol: 'openai-chat', input_modalities: ['text'] }] },
  { id: 'tokendance', value: 'tokendance', label: 'TokenDance', kind: 'relay', modalities: ['image', 'video'], homepageUrl: 'https://tokendance.space', docsUrl: 'https://tokendance.space/docs/quickstart', apiKeyUrl: 'https://tokendance.space/keys', defaultBaseUrl: 'https://tokendance.space/gateway/v1', defaultModels: [{ name: 'Seedream 5.0 Lite', id: 'seedream-5.0-lite', modality: 'image', protocol: 'openai' }, { name: 'Seedream 5.0 Pro', id: 'seedream-5.0-pro', modality: 'image', protocol: 'ark' }, { name: 'Seedance 2.0', id: 'seedance-2.0', modality: 'video', protocol: 'seedance' }] },
  { id: 'openrouter', value: 'openrouter', label: 'OpenRouter', kind: 'relay', modalities: ['image', 'video'], homepageUrl: 'https://openrouter.ai', docsUrl: 'https://openrouter.ai/docs/quickstart', apiKeyUrl: 'https://openrouter.ai/settings/keys', defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultModels: [{ name: 'GPT Image 2', id: 'openai/gpt-image-2', modality: 'image' }, { name: 'Google: Veo 3.1', id: 'google/veo-3.1', modality: 'video' }] },
  { id: 'evolink', value: 'evolink', label: 'EvoLink', kind: 'relay', modalities: ['image'], homepageUrl: 'https://evolink.ai', docsUrl: 'https://docs.evolink.ai', defaultBaseUrl: 'https://api.evolink.ai/v1', defaultModels: [{ name: 'Midjourney V8.2', id: 'mj-v8.2', modality: 'image', protocol: 'evolink' }] },
  { id: 'tuzi', value: 'custom', label: 'Tuzi', kind: 'relay', modalities: ['image', 'video', 'llm'], homepageUrl: 'https://tu-zi.com', apiKeyUrl: 'https://api.tu-zi.com', defaultBaseUrl: 'https://api.tu-zi.com', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' }] },
  { id: 'openai-hk', value: 'custom', label: 'OpenAI-HK', kind: 'relay', modalities: ['image', 'video', 'llm'], homepageUrl: 'https://www.openai-hk.com', apiKeyUrl: 'https://www.openai-hk.com/v3/ai', defaultBaseUrl: 'https://api.openai-hk.com', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' }] },
  { id: 'custom', value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
  // 局域网里另一台开了「局域网共享」的 Atelier（ADR-0025）：模型由网关决定，连接后自动带回。
  { id: 'atelier', value: 'atelier', label: 'Remote Atelier', kind: 'team', modalities: ['image'], defaultBaseUrl: '', defaultModels: [] },
];
