import { request, requestJson } from '@/api/http';

export interface SitePairing { pairing_code: string; origin: string; expires_at: string; instance_id: string }
export interface ConnectionSession {
  session_id: string;
  kind: 'local' | 'agent' | 'site';
  name: string;
  origin: string | null;
  expires_at: string;
}

/** 本机页面为一个精确 HTTPS 来源签发 5 分钟一次性配对码；码只显示这一次，服务端不再回传。 */
export function createSitePairing(origin: string) {
  return requestJson<SitePairing>('/api/connection/pairings', '生成配对码', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }),
  });
}
export function fetchConnectionSessions() {
  return requestJson<{ sessions: ConnectionSession[] }>('/api/connection/sessions', '读取连接列表');
}
export async function revokeConnectionSession(id: string) {
  await request(`/api/connection/sessions/${encodeURIComponent(id)}`, '断开连接', { method: 'DELETE' });
}
