import { requestJson } from './http';
import type { KeyModel } from './keys';

/** 局域网共享（ADR-0025）：本机作为网关的设置、网关密钥与用量；接入端测试连接与同步模型。 */
export interface GatewayKey {
  id: string;
  name: string;
  /** null = 不限张数。 */
  daily_image_limit: number | null;
  created_at: string;
  revoked_at: string | null;
  used_today: number;
}

export interface GatewayState {
  enabled: boolean;
  port: number;
  name: string;
  default_name: string;
  keys: GatewayKey[];
  status: { running: boolean; port: number | null; error: string | null; addresses: string[] };
}

export interface GatewayUsageRow {
  time: string;
  key_id: string;
  key_name: string;
  route_id: string;
  member_alias: string | null;
  provider: string | null;
  base_url: string | null;
  model_id: string | null;
  n: number;
  size: string | null;
  quality: string | null;
  resolution: string | null;
  status: 'done' | 'failed' | 'canceled';
  actual_cost_cny: number | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function parseState(value: unknown): GatewayState {
  const state = value as Partial<GatewayState> | null;
  if (typeof state?.enabled !== 'boolean' || !Array.isArray(state.keys) || typeof state.status !== 'object') {
    throw new Error('读取局域网共享失败：返回格式不对，重启本机服务后再试');
  }
  return state as GatewayState;
}

export async function fetchGateway(): Promise<GatewayState> {
  return parseState(await requestJson<unknown>('/api/gateway', '读取局域网共享'));
}

export async function updateGateway(patch: { enabled?: boolean; port?: number; name?: string }) {
  return parseState(await requestJson<unknown>('/api/gateway', '保存局域网共享', {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(patch),
  }));
}

export async function createGatewayKey(name: string, dailyImageLimit: number | null) {
  return requestJson<{ key: GatewayKey; token: string }>('/api/gateway/keys', '新建网关密钥', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name, daily_image_limit: dailyImageLimit }),
  });
}

export async function setGatewayKeyLimit(id: string, dailyImageLimit: number | null) {
  return requestJson<GatewayKey>(`/api/gateway/keys/${encodeURIComponent(id)}`, '修改每日上限', {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ daily_image_limit: dailyImageLimit }),
  });
}

export async function revokeGatewayKey(id: string) {
  return requestJson<GatewayKey>(`/api/gateway/keys/${encodeURIComponent(id)}/revoke`, '撤销网关密钥', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
  });
}

export async function fetchGatewayUsage(month?: string): Promise<GatewayUsageRow[]> {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  const body = await requestJson<{ rows?: GatewayUsageRow[] }>(`/api/gateway/usage${query}`, '读取网关用量');
  if (!Array.isArray(body.rows)) throw new Error('读取网关用量失败：返回格式不对');
  return body.rows;
}

export interface GatewayCheckResult {
  info: { name: string; version: string; protocol: number };
  models: KeyModel[];
}

/** 接入端：测试连接并取回网关的模型（带 via）。编辑已存的网关供应商时不填密钥、传 alias。 */
export async function checkGateway(payload: { base_url: string; access_key?: string; alias?: string }) {
  return requestJson<GatewayCheckResult>('/api/gateway/check', '连接网关', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload),
  });
}

export async function syncGatewayProvider(alias: string) {
  return requestJson<{ models: KeyModel[] }>(`/api/gateway/providers/${encodeURIComponent(alias)}/sync`, '同步网关模型', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
  });
}
