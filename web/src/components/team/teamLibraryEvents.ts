import type { TeamLibraryChangeEvent } from '@/schema/teamLibrary';

/**
 * 团队库变更的页内广播：全壳只有一条 SSE（服务端每会话限 4 条），AppShell 把 `team-library-changed`
 * 交给分享提醒，提醒再转发到这里；开着的团队库面板订阅它，不另开连接。
 */
const listeners = new Set<(event: TeamLibraryChangeEvent) => void>();

export function publishTeamLibraryChange(event: TeamLibraryChangeEvent): void {
  for (const listener of listeners) listener(event);
}

export function subscribeTeamLibraryChange(listener: (event: TeamLibraryChangeEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
