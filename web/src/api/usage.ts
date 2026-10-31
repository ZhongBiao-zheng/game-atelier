import { adminBase } from './gateway';
import { requestJson } from './http';
import type { UsageRange, UsageResponse, UsageScope, UsageSource, UsageTaskFilter, UsageTaskFields, UsageTasksResponse } from '@/schema/usage';
import { setTokenDancePrices, type TokenDancePricing } from '@/lib/generationCost';
export function fetchUsage(params: {
  scope: UsageScope; range: UsageRange; source: UsageSource; member: string;
}, gatewayAlias?: string): Promise<UsageResponse> {
  return requestJson<UsageResponse>(`${gatewayAlias ? adminBase(gatewayAlias) + '/usage' : '/api/usage'}?${new URLSearchParams(params)}`, '读取用量');
}
export function fetchKeyLastUsed(): Promise<Record<string, string>> {
  return requestJson<Record<string, string>>('/api/usage/key-last-used', '读取最近使用');
}
export function fetchUsageTasks(params: {
  scope: UsageScope; range: UsageRange; source: UsageSource; member: string;
  status: UsageTaskFilter; offset: number;
} & UsageTaskFields, gatewayAlias?: string): Promise<UsageTasksResponse> {
  const query = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return requestJson<UsageTasksResponse>(`${gatewayAlias ? adminBase(gatewayAlias) + '/usage/tasks' : '/api/usage/tasks'}?${query}`, '读取任务');
}
/** 读 TokenDance 价格快照供界面估价；拿不到时保持未计价，不打断页面加载。 */
export function loadTokenDancePrices(): Promise<void> {
  return requestJson<{ models?: Record<string, TokenDancePricing> }>('/api/pricing/tokendance', '读取 TokenDance 价格')
    .then(snapshot => setTokenDancePrices(snapshot.models ?? {}))
    .catch(() => undefined);
}
