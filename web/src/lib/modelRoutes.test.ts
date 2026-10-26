import { describe, expect, it } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { ModelRoute } from '@/api/models';
import { imageControlCaps } from './imageControlCaps';
import { AUTO_PROVIDER_ALIAS, resolveChannel, routeMemberChoices, selectionImageCaps, withAutoProvider } from './modelRoutes';

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
  id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', mode: 'order', candidate_alias: 'Tuzi',
  members: keys.map(item => ({
    alias: item.alias, provider: item.provider, base_url: item.base_url,
    model_id: item.models[0].id, name: item.models[0].name, protocol: null,
  })),
}];

describe('「自动」供应商', () => {
  it('preserves Tuzi billing groups when deriving automatic route controls', () => {
    const model = 'gpt-image-2.5-flare';
    const tuzi = { ...key('Tuzi', 'custom', 'https://api.tu-zi.com', [model]), billing_group: 'default' };
    const route: ModelRoute = { id: model, name: model, modality: 'image', mode: 'order', candidate_alias: 'Tuzi', members: [{
      alias: tuzi.alias, provider: tuzi.provider, base_url: tuzi.base_url, billing_group: tuzi.billing_group,
      model_id: model, name: model, protocol: null,
    }] };
    const auto = withAutoProvider([tuzi], [route])[0];
    expect(selectionImageCaps(auto, model)).toMatchObject({ resolutions: [], qualities: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(selectionImageCaps(tuzi, model)).toEqual(selectionImageCaps(auto, model));
  });
  const providers = withAutoProvider(keys, routes);
  const auto = providers[0];

  it('放在厂商列表第一项，没有路由时不出现', () => {
    expect(auto.alias).toBe(AUTO_PROVIDER_ALIAS);
    expect(auto.models.map(model => model.id)).toEqual(['gpt-image-2']);
    expect(withAutoProvider(keys, [])).toEqual(keys);
  });

  it('停用供应商退出手动选择和自动成员，空路由消失', () => {
    const available = withAutoProvider([{ ...keys[0], enabled: false }, keys[1]], [
      { ...routes[0], members: routes[0].members.slice(0, 2) },
      { ...routes[0], id: 'disabled-only', members: [routes[0].members[0]] },
    ]);
    expect(available.map(item => item.alias)).toEqual([AUTO_PROVIDER_ALIAS, 'HK']);
    expect(available[0].models.map(model => model.id)).toEqual(['gpt-image-2']);
    expect(available[0].models[0].members?.map(member => member.alias)).toEqual(['HK']);
    expect(withAutoProvider([{ ...keys[0], enabled: false }], [])).toEqual([]);
  });

  it('路由刷新失败时，旧快照不能重新引入已从可用密钥列表移除的成员', () => {
    const available = withAutoProvider([keys[1]], routes);
    expect(available[0].models[0].members?.map(member => member.alias)).toEqual(['HK']);
    expect(withAutoProvider([], routes)).toEqual([]);
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

describe('局域网 Atelier 供应商', () => {
  const via = routes[0].members;
  const hub: KeyView = {
    alias: 'Hub', provider: 'atelier', base_url: 'http://192.0.2.1:5180', access_key: '', secret_key: null,
    capabilities: [], notes: '', created_at: '',
    models: [{ id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', via }],
  };

  it('能力取网关成员交集，渠道取网关第一个成员', () => {
    expect(selectionImageCaps(hub, 'gpt-image-2')).toEqual(selectionImageCaps(withAutoProvider(keys, routes)[0], 'gpt-image-2'));
    const channel = resolveChannel([hub], hub, 'gpt-image-2');
    expect([channel.key?.provider, channel.key?.base_url, channel.modelId]).toEqual(['custom', 'https://api.tu-zi.com/v1', 'gpt-image-2']);
    expect(channel.key?.alias).toBe('Hub');
  });

  it('「自动」组的第一个成员是网关时，渠道继续展开到网关那边', () => {
    const autoRoutes: ModelRoute[] = [{
      ...routes[0],
      members: [{ alias: 'Hub', provider: 'atelier', base_url: hub.base_url, model_id: 'gpt-image-2', name: 'gpt-image-2', protocol: null, via: [via[2]] }, via[0]],
    }];
    const auto = withAutoProvider([hub, keys[0]], autoRoutes)[0];
    const channel = resolveChannel([hub, keys[0]], auto, 'gpt-image-2');
    expect([channel.key?.provider, channel.modelId]).toEqual(['openrouter', 'openai/gpt-image-2']);
    expect(routeMemberChoices(auto, auto.models[0]).map(item => item.key.alias)).toEqual(['OpenRouter', 'Tuzi']);
  });
});
