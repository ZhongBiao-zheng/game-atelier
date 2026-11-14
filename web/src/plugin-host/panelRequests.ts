/**
 * 「打开某个插件节点的编辑面板」的请求：工具栏动作建完节点后发出。
 * 请求一直保留到面板关闭——节点可能还没挂载、还没批准，或中途重新挂载，都不该把它弄丢。
 */
import { useSyncExternalStore } from 'react';

const pending = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function requestPluginPanel(nodeId: string) {
  pending.add(nodeId);
  notify();
}

export function clearPluginPanelRequest(nodeId: string) {
  if (pending.delete(nodeId)) notify();
}

export function usePluginPanelRequested(nodeId: string): boolean {
  return useSyncExternalStore(subscribe, () => pending.has(nodeId), () => false);
}
