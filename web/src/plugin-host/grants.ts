/** 项目对插件的批准（ADR-0012 的 grant）：按项目取、按项目存。 */
import { useCallback, useEffect, useState } from 'react';

import { requestJson } from '@/api/http';

export interface PluginGrant { capabilities: string[]; granted_at: string | null }
export type PluginGrants = Record<string, PluginGrant>;

function parse(value: unknown): PluginGrants {
  const grants = (value as { grants?: unknown } | null)?.grants;
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) {
    throw new Error('读取插件批准失败：返回格式不对，重启本机服务后再试');
  }
  const result: PluginGrants = {};
  for (const [id, entry] of Object.entries(grants as Record<string, Partial<PluginGrant> | null>)) {
    if (Array.isArray(entry?.capabilities) && entry.capabilities.every(item => typeof item === 'string')) {
      result[id] = { capabilities: entry.capabilities, granted_at: entry.granted_at ?? null };
    }
  }
  return result;
}

const base = (projectId: string) => `/api/canvas/projects/${encodeURIComponent(projectId)}/plugin-grants`;

export async function fetchPluginGrants(projectId: string): Promise<PluginGrants> {
  return parse(await requestJson<unknown>(base(projectId), '读取插件批准'));
}

export async function grantPlugin(projectId: string, pluginId: string): Promise<PluginGrants> {
  return parse(await requestJson<unknown>(`${base(projectId)}/${encodeURIComponent(pluginId)}`, '允许插件', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));
}

// 同一个项目里的多个插件节点共用一份批准状态：批准一次，全部节点一起解锁。
const cache = new Map<string, PluginGrants>();
const listeners = new Map<string, Set<() => void>>();
function publish(projectId: string, grants: PluginGrants) {
  cache.set(projectId, grants);
  for (const listener of listeners.get(projectId) ?? []) listener();
}

/** `grants` 为 null 表示还没读到。读取失败按「没有批准」处理，不会放大权限。 */
export function useProjectGrants(projectId: string, refreshKey: string) {
  const [grants, setGrants] = useState<PluginGrants | null>(() => cache.get(projectId) ?? null);
  useEffect(() => {
    let active = true;
    const sync = () => { if (active) setGrants(cache.get(projectId) ?? null); };
    const set = listeners.get(projectId) ?? new Set();
    set.add(sync);
    listeners.set(projectId, set);
    fetchPluginGrants(projectId).then(next => publish(projectId, next)).catch(() => publish(projectId, {}));
    return () => { active = false; set.delete(sync); };
  }, [projectId, refreshKey]);
  const grant = useCallback(async (pluginId: string) => {
    publish(projectId, await grantPlugin(projectId, pluginId));
  }, [projectId]);
  return { grants, grant };
}
