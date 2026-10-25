import type { ReactNode } from 'react';
import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
import { KindBadge } from './KindBadge';
export function KpiRow({ data, children }: { data: UsageResponse; children?: ReactNode }) {
  const totals = data.totals;
  const previous = totals.previous_cost_cny;
  const change = previous ? ((totals.cost_cny - previous) / previous) * 100 : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="space-y-2 rounded-xl border border-border bg-card p-5">
        <p className="text-xs text-muted-foreground">{data.scope === 'team' ? '全员花费' : '花费'}</p>
        <p className="text-base font-semibold tabular-nums">{formatGenerationCost(totals.cost_cny)}</p>
        {previous !== null && (
          <p className={`inline-flex rounded-full px-2 py-0.5 text-xs ${change !== null && change > 0 ? 'accent-pill' : 'bg-secondary text-muted-foreground'}`}>
            {change !== null ? `较上期 ${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '上期无花费'}
          </p>
        )}
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-card p-5">
        <p className="text-xs text-muted-foreground">生成次数</p>
        <p className="text-base font-semibold tabular-nums">{totals.count}</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(totals.by_kind).map(([kind, count]) => <KindBadge key={kind} kind={kind} count={count} />)}
        </div>
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-card p-5">
        <p className="text-xs text-muted-foreground">失败率</p>
        <p className="text-base font-semibold tabular-nums">
          {totals.count ? ((totals.failed / totals.count) * 100).toFixed(1) : '0'}%
        </p>
        <p className="inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{totals.failed} 次失败</p>
      </div>
      {totals.unpriced > 0 && <div className="space-y-2 rounded-xl border border-[color:var(--status-running)] bg-card p-5">
        <p className="text-xs text-muted-foreground">未计价</p>
        <p className="text-base font-semibold tabular-nums text-[color:var(--status-running)]">{totals.unpriced}<span className="ml-1 text-xs font-normal">次</span></p>
        <p className="text-xs text-muted-foreground">占 {totals.count ? (totals.unpriced / totals.count * 100).toFixed(1) : '0'}%</p>
      </div>}
      {data.scope === 'team' ? (
        <div className="space-y-2 rounded-xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">活跃成员</p>
          <p className="text-base font-semibold tabular-nums">
            {totals.active_members} / {totals.member_count}
          </p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
