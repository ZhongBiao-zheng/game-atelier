import { requestJson } from './http';
import type { KeyModel } from './keys';

/** 局域网共享（ADR-0025）：本机作为网关的设置、网关密钥与用量；接入端测试连接与同步模型。 */
export type LimitPeriod = 'day' | 'week' | 'month';
export interface GatewayLimit { period: LimitPeriod; cap_cny: number }
export interface LimitStatus extends GatewayLimit {
  used_cny: number;
  reserved_cny: number;
  left_cny: number;
  resets_at: string;
}
export interface GatewayKeyInput {
  name: string;
  limits: GatewayLimit[];
  allowed_models: string[] | null;
  allowed_aliases: string[] | null;
}
export interface GatewayKey extends GatewayKeyInput {
  id: string;
  created_at: string;
  revoked_at: string | null;
  limits_status: LimitStatus[];
  month_charged_cny: number;
  month_calls: number;
  last_used_at: string | null;
}
export interface GatewayMe {
  name: string;
  limits: LimitStatus[];
  month_charged_cny: number;
  month_calls: number;
}
export interface GatewayOptions {
  models: { id: string; name: string; modality: 'image' | 'video' | 'audio' | 'text' }[];
  aliases: { alias: string; provider: string; name: string }[];
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
  kind: 'image' | 'image_edit' | 'layer_split' | 'video' | 'audio' | 'text';
  estimated_cny: number | null;
  charged_cny: number;
  input_tokens: number | null;
  output_tokens: number | null;
  duration: number | null;
  member_trail: string[];
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

export async function createGatewayKey(payload: GatewayKeyInput) {
  return requestJson<{ key: GatewayKey; token: string }>('/api/gateway/keys', '新建网关密钥', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload),
  });
}

export async function updateGatewayKey(id: string, patch: Partial<GatewayKeyInput>) {
  return requestJson<GatewayKey>(`/api/gateway/keys/${encodeURIComponent(id)}`, '修改网关密钥', {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
}

export async function fetchGatewayOptions() {
  return requestJson<GatewayOptions>('/api/gateway/options', '读取网关模型与供应商');
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
