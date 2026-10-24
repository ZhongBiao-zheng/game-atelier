export type UsageScope = 'mine' | 'team';
export type UsageRange = 'today' | '7d' | '30d' | '90d' | 'all';
export type UsageSource = 'all' | 'local' | 'lan';
export interface UsageTask {
  id: string; cost_cny: number; at: string; kind: string; model: string; label: string;
  source: 'local' | 'lan'; prompt?: string | null; thumb_url: string | null; href: string | null;
}
export interface UsageRankingRow { key: string; label: string; cost_cny: number; count: number }
export interface UsageResponse {
  scope: UsageScope; range: UsageRange; bucket: 'day' | 'week';
  totals: {
    cost_cny: number; previous_cost_cny: number | null; count: number; by_kind: Record<string, number>;
    failed: number; active_members: number | null; member_count: number | null;
  };
  trend: { start: string; cost_cny: number }[];
  rankings: { by: 'model' | 'project' | 'member'; rows: UsageRankingRow[] }[];
  top: UsageTask[]; sources: ('local' | 'lan')[]; members: { id: string; name: string }[];
}
