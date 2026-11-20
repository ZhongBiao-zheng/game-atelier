import type { ScopeEntry, ScopeProvider } from '@/api/gateway';

/** 网关密钥范围（第 7 批）：模型挂在供应商下面。null = 全部模型；条目 models 为 null = 该供应商全部（含以后新增）。 */
export type Scope = ScopeEntry[] | null;

export function entryOf(scope: ScopeEntry[], alias: string) {
  return scope.find(entry => entry.alias === alias);
}

/** 勾 / 取消整个供应商。 */
export function toggleProvider(scope: ScopeEntry[], alias: string): ScopeEntry[] {
  const entry = entryOf(scope, alias);
  if (entry?.models === null) return scope.filter(item => item.alias !== alias);
  return [...scope.filter(item => item.alias !== alias), { alias, models: null }];
}

/** 勾 / 取消供应商下的一个模型；最后一个模型取消时整组去掉。 */
export function toggleModel(scope: ScopeEntry[], alias: string, model: string): ScopeEntry[] {
  const current = entryOf(scope, alias)?.models ?? [];
  const models = current.includes(model) ? current.filter(id => id !== model) : [...current, model];
  const rest = scope.filter(item => item.alias !== alias);
  return models.length ? [...rest, { alias, models }] : rest;
}

/** 按钮上的「N 个模型」：某供应商全部时计入它当前的模型数。 */
export function scopeModelCount(scope: ScopeEntry[], providers: ScopeProvider[]) {
  return scope.reduce((sum, entry) => sum + (entry.models
    ?? providers.find(provider => provider.alias === entry.alias)?.models ?? []).length, 0);
}

const unknownModel = (id: string) => ({ id, name: id, modality: 'image' as const, route_id: null });

/** 弹层里的分组：主机给的供应商在前；范围里有、主机已不提供的供应商与模型也列出，方便取消。 */
export function scopeGroups(scope: Scope, providers: ScopeProvider[]): ScopeProvider[] {
  const groups = providers.map(provider => {
    const listed = entryOf(scope ?? [], provider.alias)?.models ?? [];
    const missing = listed.filter(id => !provider.models.some(model => model.id === id));
    return missing.length ? { ...provider, models: [...provider.models, ...missing.map(unknownModel)] } : provider;
  });
  const orphans = (scope ?? []).filter(entry => !providers.some(provider => provider.alias === entry.alias))
    .map(entry => ({ alias: entry.alias, provider: '', enabled: false, models: (entry.models ?? []).map(unknownModel) }));
  return [...groups, ...orphans];
}

export function sameScope(a: Scope, b: Scope) {
  const key = (scope: Scope) => scope === null ? 'all' : JSON.stringify(
    [...scope].sort((x, y) => x.alias.localeCompare(y.alias))
      .map(entry => [entry.alias, entry.models === null ? null : [...entry.models].sort()]));
  return key(a) === key(b);
}
