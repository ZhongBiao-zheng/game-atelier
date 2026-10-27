/** 「自动」供应商：把路由组包装成一个虚拟 KeyView，放在厂商列表第一项。
 *
 * 选它时模型 id 就是路由 id，提交不带 alias，由服务端按路由方式解析实际 KEY。
 * 能力面板取组内全部成员的交集，保证换到任何成员时参数都合法；尺寸归一、估价等
 * 「按渠道算」的预览用当前排序的第一个成员；最终选择取决于本次提交参数与可用状态。
 */
import type { KeyModel, KeyView } from '@/api/keys';
import type { ModelRoute, ModelRouteMember } from '@/api/models';
import { imageControlCaps, type ImageControlCaps } from '@/lib/imageControlCaps';

export const AUTO_PROVIDER_ALIAS = '@auto';
/** 局域网 Atelier（ADR-0025）：模型带网关那边的成员快照 `via`，能力与估价按它算。 */
export const GATEWAY_PROVIDER = 'atelier';

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
  const available = keys.filter(key => key.enabled !== false);
  const aliases = new Set(available.map(key => key.alias));
  const auto = autoProviderView(routes.map(route => ({
    ...route, members: route.members.filter(member => aliases.has(member.alias)),
  })).filter(route => route.members.length > 0));
  return auto ? [auto, ...available] : available;
}

/** 选择背后的成员：「自动」是路由组成员；局域网 Atelier 是它自己（带网关成员快照）；其余没有。 */
export function selectionMembers(key: KeyView | undefined, model: KeyModel | undefined): ModelRouteMember[] | undefined {
  if (!key || !model) return undefined;
  if (isAutoProvider(key)) return model.members;
  if (key.provider === GATEWAY_PROVIDER && model.via?.length) {
    return [{
      alias: key.alias, provider: key.provider, base_url: key.base_url, model_id: model.id,
      name: model.name, protocol: model.protocol ?? null, via: model.via,
    }];
  }
  return undefined;
}

/** 成员实际出图的渠道：局域网 Atelier 取网关那边第一个成员。 */
function memberChannel(member: ModelRouteMember): ModelRouteMember {
  return member.provider === GATEWAY_PROVIDER && member.via?.length ? member.via[0] : member;
}

/** 成员的能力：局域网 Atelier 取网关那边全部成员的交集。 */
function memberCaps(member: ModelRouteMember): ImageControlCaps {
  if (member.provider === GATEWAY_PROVIDER && member.via?.length) {
    return intersectImageCaps(member.via.map(item => imageControlCaps(item.model_id, item.provider, item.base_url, item.billing_group)));
  }
  return imageControlCaps(member.model_id, member.provider, member.base_url, member.billing_group);
}

/** 选择落到的实际渠道：「自动」取组内第一个成员；局域网 Atelier 再取网关那边第一个成员；其余原样返回。
 *  只用于能力、尺寸、估价判断，提交仍用原来的别名与模型 id。 */
export function resolveChannel(
  keys: KeyView[], key: KeyView | undefined, modelId: string,
): { key: KeyView | undefined; modelId: string } {
  const members = selectionMembers(key, key?.models.find(model => model.id === modelId));
  if (!members) return { key, modelId };
  const first = members[0];
  const real = first && (keys.find(item => item.alias === first.alias) ?? (first.alias === key?.alias ? key : undefined));
  if (!first || !real) return { key: undefined, modelId };
  const channel = memberChannel(first);
  if (channel === first) return { key: real, modelId: first.model_id };
  return {
    key: {
      ...real, provider: channel.provider, base_url: channel.base_url, billing_group: channel.billing_group,
      models: [{ id: channel.model_id, name: channel.name, modality: 'image', protocol: channel.protocol }],
    },
    modelId: channel.model_id,
  };
}

/** 有成员时取全部成员能力的交集（「自动」、局域网 Atelier）；其余就是该 KEY 自己的能力。 */
export function selectionImageCaps(key: KeyView | undefined, modelId: string): ImageControlCaps {
  const members = selectionMembers(key, key?.models.find(model => model.id === modelId));
  if (!members?.length) return imageControlCaps(modelId, key?.provider, key?.base_url, key?.billing_group);
  return intersectImageCaps(members.map(memberCaps));
}

/** 这个选择的能力需要按成员算（「自动」或局域网 Atelier）。 */
export function hasChannelMembers(key: KeyView | undefined, modelId: string): boolean {
  return Boolean(selectionMembers(key, key?.models.find(model => model.id === modelId))?.length);
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
    ...(all.some(caps => caps.maxCount != null) ? { maxCount: Math.min(...all.map(caps => caps.maxCount ?? 4)) } : {}),
    ...(all.some(caps => caps.maxRefImages != null) ? { maxRefImages: Math.min(...all.map(caps => caps.maxRefImages ?? Infinity)) } : {}),
    sizeKind: all.some(caps => caps.sizeKind === 'none') ? 'none' : first.sizeKind,
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
  const member = selectionMembers(key, model)?.[0];
  if (!member) return { key, model };
  return memberChoice(key, model, memberChannel(member));
}

/** 「自动」或局域网 Atelier 模型背后的全部实际渠道（网关成员展开成网关那边的成员），各自包装成一个 KEY + 模型。 */
export function routeMemberChoices(key: KeyView, model: KeyModel): Array<{ key: KeyView; model: KeyModel }> {
  return (selectionMembers(key, model) ?? []).flatMap(member => (
    member.provider === GATEWAY_PROVIDER && member.via?.length ? member.via : [member]
  )).map(member => memberChoice(key, model, member));
}

function memberChoice(auto: KeyView, model: KeyModel, member: ModelRouteMember) {
  return {
    key: { ...auto, alias: member.alias, provider: member.provider, base_url: member.base_url, billing_group: member.billing_group, models: [] },
    model: { id: member.model_id, name: member.name, modality: model.modality, protocol: member.protocol },
  };
}
