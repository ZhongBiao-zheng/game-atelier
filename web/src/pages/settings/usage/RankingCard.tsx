import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
const labels = { model: '按模型', project: '按项目', member: '按成员' };
export function RankingCard({ ranking }: { ranking: UsageResponse['rankings'][number] }) {
  const max = Math.max(...ranking.rows.map((row) => row.cost_cny), 1);
  return (
    <section className="min-w-0 space-y-4 rounded-lg border border-border p-5">
      <h2 className="text-sm font-medium">{labels[ranking.by]}</h2>
      {ranking.rows.map((row) => (
        <div key={row.key} className="space-y-2">
          <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
            <span className="truncate" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 tabular-nums">{formatGenerationCost(row.cost_cny)}</span>
          </div>
          <div className="h-1 rounded-full bg-card">
            <div
              className="h-full rounded-full bg-secondary"
              style={{ width: `${(row.cost_cny / max) * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{row.count} 次</p>
        </div>
      ))}
    </section>
  );
}
