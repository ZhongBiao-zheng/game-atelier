import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
export function TrendChart({ data }: { data: UsageResponse }) {
  const max = Math.max(...data.trend.map((row) => row.cost_cny), 1);
  return (
    <section aria-label="花费趋势" className="space-y-4 rounded-lg border border-border p-5">
      <h2 className="text-sm font-medium">花费趋势</h2>
      <div className="overflow-x-auto">
        <div className="flex h-44 min-w-full items-end gap-2">
          {data.trend.map((row, index) => (
            <div key={row.start} className="flex h-full min-w-4 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 items-end">
                <div
                  role="img"
                  aria-label={`${row.start} ${formatGenerationCost(row.cost_cny)}`}
                  title={`${row.start} · ${formatGenerationCost(row.cost_cny)}`}
                  className={`w-full rounded-sm ${index === data.trend.length - 1 ? 'bg-primary' : 'bg-secondary'}`}
                  style={{ height: `${(row.cost_cny / max) * 100}%`, minHeight: 2 }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      {data.trend.length > 0 && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{data.trend[0].start.slice(5)}</span>
          <span>{data.trend[data.trend.length - 1].start.slice(5)}</span>
        </div>
      )}
    </section>
  );
}
