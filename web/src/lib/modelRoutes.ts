/** 「自动」供应商：把路由组包装成一个虚拟 KeyView，放在厂商列表第一项。
 *
 * 选它时模型 id 就是路由 id，提交不带 alias，由服务端按组内顺序解析实际 KEY。
 * 能力面板取组内全部成员的交集，保证换到任何成员时参数都合法；尺寸归一、估价等
 * 「按实际渠道算」的逻辑用第一个成员（一期就是它出图）。
 */
import type { KeyModel, KeyView } from '@/api/keys';
import type { ModelRoute, ModelRouteMember } from '@/api/models';
import { imageControlCaps, type ImageControlCaps } from '@/lib/imageControlCaps';

export const AUTO_PROVIDER_ALIAS = '@auto';

export function isAutoProvider(key?: Pick<KeyView, 'alias'> | null): boolean {
  return key?.alias === AUTO_PROVIDER_ALIAS;
}

export function autoProviderView(routes: ModelRoute[]): KeyView | null {
  if (routes.length === 0) return null;
  return {
    alias: AUTO_PROVIDER_ALIAS,
    provider: 'auto',
    base_url: null,
    access_key: '',
    secret_key: null,
    capabilities: [],
    notes: '',
    created_at: '',
    models: routes.map((route): KeyModel => ({
      id: route.id,
      name: route.name,
      modality: route.modality,
      protocol: route.members[0]?.protocol ?? null,
      members: route.members,
    })),
  };
}

/** 有路由组时把「自动」放在第一项；没有可用模型就只有真实 KEY。 */
export function withAutoProvider(keys: KeyView[], routes: ModelRoute[]): KeyView[] {
  const auto = autoProviderView(routes);
  return auto ? [auto, ...keys] : keys;
}

/** 选择落到的实际渠道：「自动」取组内第一个成员对应的 KEY 与模型 id，其余原样返回。 */
export function resolveChannel(
  keys: KeyView[], key: KeyView | undefined, modelId: string,
): { key: KeyView | undefined; modelId: string } {
  if (!isAutoProvider(key)) return { key, modelId };
  const member = key?.models.find(model => model.id === modelId)?.members?.[0];
  if (!member) return { key: undefined, modelId };
  return { key: keys.find(item => item.alias === member.alias), modelId: member.model_id };
}

/** 「自动」时取全部成员能力的交集；其余就是该 KEY 自己的能力。 */
export function selectionImageCaps(key: KeyView | undefined, modelId: string): ImageControlCaps {
  const members = isAutoProvider(key) ? key?.models.find(model => model.id === modelId)?.members : undefined;
  if (!members?.length) return imageControlCaps(modelId, key?.provider, key?.base_url, key?.billing_group);
  return intersectImageCaps(members.map(member => imageControlCaps(member.model_id, member.provider, member.base_url, member.billing_group)));
}

export function intersectImageCaps(all: ImageControlCaps[]): ImageControlCaps {
  const [first, ...rest] = all;
  const keep = <T,>(values: T[], pick: (caps: ImageControlCaps) => T[]) =>
    values.filter(value => rest.every(caps => pick(caps).includes(value)));
  const resolutions = keep(first.resolutions, caps => caps.resolutions);
  const qualities = all.every(caps => caps.qualities)
    ? keep(first.qualities!, caps => caps.qualities!)
    : null;
  return {
    ...first,
    ratios: keep(first.ratios, caps => caps.ratios),
    resolutions,
    showResolution: all.every(caps => caps.showResolution) && resolutions.length > 0,
    showCustomSize: all.every(caps => caps.showCustomSize),
    showAutoSize: all.every(caps => caps.showAutoSize),
    qualities: qualities?.length ? qualities : null,
  };
}

/** 尺寸归一用的上下文：实际渠道（「自动」取第一个成员）+ 面板能力（「自动」取交集）。 */
export function sizeContext(providers: KeyView[], key: KeyView | undefined, modelId: string) {
  const channel = resolveChannel(providers, key, modelId);
  return {
    modelId: channel.modelId,
    provider: channel.key?.provider,
    baseUrl: channel.key?.base_url,
    caps: selectionImageCaps(key, modelId),
  };
}

/** 存进草稿 / 偏好的 alias：「自动」存 null（服务端按路由解析），其余存 KEY 别名。 */
export function storedAlias(key: Pick<KeyView, 'alias'>): string | null {
  return isAutoProvider(key) ? null : key.alias;
}

/** 按草稿 / 偏好里存的 alias 找厂商：null 即「自动」（没有路由时找不到，等同未选）。 */
export function providerForAlias<K extends Pick<KeyView, 'alias'>>(
  providers: readonly K[], alias: string | null | undefined,
): K | undefined {
  return providers.find(key => key.alias === (alias ?? AUTO_PROVIDER_ALIAS));
}

/** 一个选择实际落到的渠道：「自动」取组内第一个成员（只带 provider / base_url / 模型 id / 协议），其余原样。
 *  参数归一、能力判断按它算；不需要真实 KEY 列表。 */
export function routeChannel(key: KeyView, model: KeyModel): { key: KeyView; model: KeyModel } {
  const member = isAutoProvider(key) ? model.members?.[0] : undefined;
  if (!member) return { key, model };
  return memberChoice(key, model, member);
}

/** 「自动」模型的全部成员，各自包装成一个 KEY + 模型。 */
export function routeMemberChoices(key: KeyView, model: KeyModel): Array<{ key: KeyView; model: KeyModel }> {
  return (model.members ?? []).map(member => memberChoice(key, model, member));
}

function memberChoice(auto: KeyView, model: KeyModel, member: ModelRouteMember) {
  return {
    key: { ...auto, alias: member.alias, provider: member.provider, base_url: member.base_url, billing_group: member.billing_group, models: [] },
    model: { id: member.model_id, name: member.name, modality: model.modality, protocol: member.protocol },
  };
}
