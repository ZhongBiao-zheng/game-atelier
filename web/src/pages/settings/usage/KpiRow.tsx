import type { ReactNode } from 'react';
import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
const kinds: Record<string, string> = { image: '图片', video: '视频', text: '文本', audio: '音频' };
export function KpiRow({ data, children }: { data: UsageResponse; children?: ReactNode }) {
  const totals = data.totals;
  const previous = totals.previous_cost_cny;
  const change = previous ? ((totals.cost_cny - previous) / previous) * 100 : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="space-y-2 rounded-lg border border-border p-5">
        <p className="text-xs text-muted-foreground">{data.scope === 'team' ? '全员花费' : '花费'}</p>
        <p className="text-base font-medium tabular-nums">{formatGenerationCost(totals.cost_cny)}</p>
        {previous !== null && (
          <p className="text-xs text-muted-foreground">
            {change !== null ? `较上期 ${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '上期无花费'}
          </p>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-border p-5">
        <p className="text-xs text-muted-foreground">生成次数</p>
        <p className="text-base font-medium tabular-nums">{totals.count}</p>
        <p className="text-xs text-muted-foreground">
          {Object.entries(totals.by_kind)
            .map(([kind, count]) => `${kinds[kind] ?? kind} ${count}`)
            .join(' · ')}
        </p>
      </div>
      <div className="space-y-2 rounded-lg border border-border p-5">
        <p className="text-xs text-muted-foreground">失败率</p>
        <p className="text-base font-medium tabular-nums">
          {totals.count ? ((totals.failed / totals.count) * 100).toFixed(1) : '0'}%
        </p>
        <p className="text-xs text-muted-foreground">{totals.failed} 次失败</p>
      </div>
      {data.scope === 'team' ? (
        <div className="space-y-2 rounded-lg border border-border p-5">
          <p className="text-xs text-muted-foreground">活跃成员</p>
          <p className="text-base font-medium tabular-nums">
            {totals.active_members} / {totals.member_count}
          </p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
