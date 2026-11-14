import { requestJson } from '@/api/http';
import type { PluginEntry, PluginListing } from '@/schema/plugins';

// 服务端没重启、还是旧接口时会拿到别的形状：在这里报清楚，不让设置页崩成黑屏。
function parse(value: unknown): PluginListing {
  const listing = value as Partial<PluginListing> | null;
  const entry = (item: unknown) => {
    const candidate = item as Partial<PluginEntry> | null;
    return typeof candidate?.id === 'string' && typeof candidate.enabled === 'boolean'
      && ['ok', 'incompatible', 'invalid'].includes(candidate.availability ?? '')
      && (candidate.manifest === null || typeof candidate.manifest === 'object')
      && (candidate.availability === 'invalid' || candidate.manifest !== null);
  };
  if (typeof listing?.app_version !== 'string' || !Array.isArray(listing.plugins) || !listing.plugins.every(entry)) {
    throw new Error('读取插件失败：返回格式不对，重启本机服务后再试');
  }
  return listing as PluginListing;
}

export async function fetchPlugins(): Promise<PluginListing> {
  return parse(await requestJson<unknown>('/api/plugins', '读取插件'));
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<PluginListing> {
  const action = enabled ? 'enable' : 'disable';
  return parse(await requestJson<unknown>(`/api/plugins/${encodeURIComponent(id)}/${action}`,
    enabled ? '启用插件' : '停用插件', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
}
