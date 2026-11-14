/**
 * 前端的插件注册表：一份全局的 `/api/plugins` 快照。
 *
 * 做成模块级 store 而不是 context：画布的连接策略（canvasEditorModel）是纯函数、到处被调用，
 * 它们要同步问一句「这个插件节点现在收不收输入」，拿不到 React context。
 */
import { useSyncExternalStore } from 'react';

import { fetchPlugins } from '@/api/plugins';
import type { PluginEntry, PluginNodeContribution, PluginPackageLock } from '@/schema/plugins';

const EMPTY: readonly PluginEntry[] = [];
let snapshot: readonly PluginEntry[] = EMPTY;
let requested = false;
const listeners = new Set<() => void>();

export function setPluginsSnapshot(plugins: readonly PluginEntry[]) {
  snapshot = plugins;
  requested = true;
  for (const listener of listeners) listener();
}

export async function refreshPlugins(): Promise<void> {
  requested = true;
  try {
    setPluginsSnapshot((await fetchPlugins()).plugins);
  } catch {
    // 读不到就当没有插件：画布照常能用，插件节点显示占位。
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!requested) void refreshPlugins();
  return () => { listeners.delete(listener); };
}

export function getPluginsSnapshot(): readonly PluginEntry[] {
  return snapshot;
}

export function usePlugins(): readonly PluginEntry[] {
  return useSyncExternalStore(subscribe, getPluginsSnapshot, getPluginsSnapshot);
}

export function enabledPlugins(plugins: readonly PluginEntry[] = snapshot): PluginPackageLock[] {
  return plugins.flatMap(plugin => plugin.enabled && plugin.manifest ? [plugin.manifest] : []);
}

/** 已启用插件声明的节点类型；插件未启用、不存在或没声明这个类型时返回 null。 */
export function enabledNodeContribution(
  pluginId: string, nodeType: string, plugins: readonly PluginEntry[] = snapshot,
): { plugin: PluginPackageLock; node: PluginNodeContribution } | null {
  const plugin = enabledPlugins(plugins).find(item => item.id === pluginId);
  const node = plugin?.contributes.nodes.find(item => item.type === nodeType);
  return plugin && node ? { plugin, node } : null;
}
