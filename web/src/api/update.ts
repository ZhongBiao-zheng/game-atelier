import { requestJson } from './http';

export interface UpdateState {
  runtime_mode: 'source' | 'bundle' | 'legacy_bundle';
  current: string;
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'blocked' | 'error';
  to?: string;
  reason?: string;
  bytes?: number;
  maintenance: boolean;
  waiting: number;
  waiting_counts?: { jobs?: number; agents?: number; approvals?: number; gateway?: number };
  phase: 'idle' | 'waiting' | 'restarting';
  update_id?: string;
  restart_started_at?: number;
  service_mode: boolean;
  initializing?: boolean;
}
export interface UpdateResult {
  update_id: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  from: string;
  to: string;
  reason: string;
  finished_at: string;
}
export const fetchUpdateState = () => requestJson<UpdateState>('/api/update/state', '读取更新状态', { signal: AbortSignal.timeout(5000) });
export const checkUpdate = () => requestJson<UpdateState>('/api/update/check', '检查更新', { method: 'POST' });
export const applyUpdate = () => requestJson<{ update_id: string }>('/api/update/apply', '更新', { method: 'POST' });
export const cancelUpdate = () => requestJson<{ status: 'cancelled' }>('/api/update/cancel', '取消更新', { method: 'POST' });
export const fetchUpdateResult = (id: string) => requestJson<UpdateResult | null>(`/api/update/result?id=${encodeURIComponent(id)}`, '读取更新结果', { signal: AbortSignal.timeout(5000) });

/** Public identity probe must remain usable after the old session cookie expires. */
export async function probeUpdateInstance(): Promise<string> {
  const response = await fetch('/api/connection/status', {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('服务尚未恢复');
  const status = await response.json();
  if (status.service !== 'game-atelier' || typeof status.instance_id !== 'string') throw new Error('服务尚未恢复');
  return status.instance_id;
}
export const updateNavigation = { reload: () => window.location.reload() };

const STORAGE_KEY = 'atelier:pending-update';
export interface PendingUpdate { id: string; instance: string; to: string; restartAt: number | null; service: boolean }
export function readPendingUpdate(): PendingUpdate | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved && typeof saved.id === 'string' && typeof saved.instance === 'string'
      && typeof saved.to === 'string' && (saved.restartAt === null || typeof saved.restartAt === 'number')
      ? saved : null;
  } catch { return null; }
}
export function savePendingUpdate(value: PendingUpdate | null) {
  if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(STORAGE_KEY);
}
export function updateRecoveryExpired(value: PendingUpdate): boolean {
  return value.restartAt !== null && Date.now() - value.restartAt > (value.service ? 7 : 5) * 60_000;
}
