import { requestJson } from './http';
import type { UsageRange, UsageResponse, UsageScope, UsageSource } from '@/schema/usage';
export function fetchUsage(params: {
  scope: UsageScope; range: UsageRange; source: UsageSource; member: string;
}): Promise<UsageResponse> {
  return requestJson<UsageResponse>(`/api/usage?${new URLSearchParams(params)}`, '读取用量');
}
