import { describe, expect, it } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { ModelRoute } from '@/api/models';
import { imageControlCaps } from './imageControlCaps';
import { AUTO_PROVIDER_ALIAS, resolveChannel, selectionImageCaps, withAutoProvider } from './modelRoutes';

const key = (alias: string, provider: string, baseUrl: string | null, models: string[]): KeyView => ({
  alias, provider, base_url: baseUrl, access_key: '', secret_key: null, capabilities: [], notes: '',
  created_at: '', models: models.map(id => ({ id, name: id, modality: 'image' })),
});

const keys = [
  key('Tuzi', 'custom', 'https://api.tu-zi.com/v1', ['gpt-image-2']),
  key('HK', 'custom', 'https://api.openai-hk.com/v1', ['gpt-image-2']),
  key('OpenRouter', 'openrouter', null, ['openai/gpt-image-2']),
];

const routes: ModelRoute[] = [{
  id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image',
  members: keys.map(item => ({
    alias: item.alias, provider: item.provider, base_url: item.base_url,
    model_id: item.models[0].id, name: item.models[0].name, protocol: null,
  })),
}];

describe('「自动」供应商', () => {
  it('preserves Tuzi billing groups when deriving automatic route controls', () => {
    const model = 'gpt-image-2.5-flare';
    const tuzi = { ...key('Tuzi', 'custom', 'https://api.tu-zi.com', [model]), billing_group: 'default' };
    const route: ModelRoute = { id: model, name: model, modality: 'image', members: [{
      alias: tuzi.alias, provider: tuzi.provider, base_url: tuzi.base_url, billing_group: tuzi.billing_group,
      model_id: model, name: model, protocol: null,
    }] };
    const auto = withAutoProvider([tuzi], [route])[0];
    expect(selectionImageCaps(auto, model)).toMatchObject({ resolutions: ['1K', '2K', '4K'], qualities: null });
    expect(selectionImageCaps(tuzi, model)).toEqual(selectionImageCaps(auto, model));
  });
  const providers = withAutoProvider(keys, routes);
  const auto = providers[0];

  it('放在厂商列表第一项，没有路由时不出现', () => {
    expect(auto.alias).toBe(AUTO_PROVIDER_ALIAS);
    expect(auto.models.map(model => model.id)).toEqual(['gpt-image-2']);
    expect(withAutoProvider(keys, [])).toEqual(keys);
  });

  it('实际渠道取组内第一个成员，指定厂商原样返回', () => {
    expect(resolveChannel(providers, auto, 'gpt-image-2')).toEqual({ key: keys[0], modelId: 'gpt-image-2' });
    expect(resolveChannel(providers, keys[2], 'openai/gpt-image-2')).toEqual({ key: keys[2], modelId: 'openai/gpt-image-2' });
  });

  it('能力取全部成员的交集', () => {
    const caps = selectionImageCaps(auto, 'gpt-image-2');
    const each = keys.map(item => imageControlCaps(item.models[0].id, item.provider, item.base_url));
    expect(caps.showCustomSize).toBe(each.every(item => item.showCustomSize));
    expect(caps.showResolution).toBe(false);
    expect(caps.ratios.every(ratio => each.every(item => item.ratios.includes(ratio)))).toBe(true);
    expect(caps.qualities).toEqual(['low', 'medium', 'high', 'auto']);
  });
});
