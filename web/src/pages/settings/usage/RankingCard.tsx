import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
import { Hint } from '@/components/ui/tooltip';
const labels = { model: '按模型', project: '按项目', member: '按成员' };
export const chartColors = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];
export function RankingCard({ ranking }: { ranking: UsageResponse['rankings'][number] }) {
  const max = Math.max(...ranking.rows.map(row => row.cost_cny), 1);
  return <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5">
    <h2 className="text-sm font-medium">{labels[ranking.by]}</h2>
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_max-content] gap-x-3 gap-y-4">
      {ranking.rows.map((row, index) => <Hint key={row.key} label={`${row.label} · ${row.count} 次`}><div
        className="col-span-3 grid grid-cols-subgrid items-center text-sm">
        <span className="flex min-w-0 items-center gap-2"><span aria-hidden className={`size-2 shrink-0 rounded-full ${chartColors[index % 5]}`} /><span className="min-w-0 truncate">{row.label}</span></span>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full ${chartColors[index % 5]}`} style={{ width: `${row.cost_cny / max * 100}%` }} /></div>
        <Hint label={row.unpriced ? `${row.unpriced} 次未计价，未计入金额` : undefined}><span className="whitespace-nowrap text-right tabular-nums">
          {formatGenerationCost(row.cost_cny)}{row.unpriced > 0 && <span className="text-muted-foreground"> +未计价</span>}
        </span></Hint>
      </div></Hint>)}
    </div>
  </section>;
}
