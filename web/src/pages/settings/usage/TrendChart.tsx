import type { UsageResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
export function TrendChart({ data }: { data: UsageResponse }) {
  const max = Math.max(...data.trend.map((row) => row.cost_cny), 1);
  return (
    <section aria-label="花费趋势" className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium">花费趋势</h2>
      <div className="overflow-x-auto">
        <div className="relative isolate flex h-44 min-w-full items-end gap-2">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 flex flex-col justify-between pb-px">
            {[0, 1, 2].map(line => <div key={line} className="border-t border-dashed border-border" />)}
          </div>
          {data.trend.map((row) => (
            <div key={row.start} className="flex h-full min-w-4 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 items-end">
                <div
                  role="img"
                  aria-label={`${row.start} ${formatGenerationCost(row.cost_cny)}`}
                  title={`${row.start} · ${formatGenerationCost(row.cost_cny)}`}
                  className={`w-full rounded-sm ${isCurrentBucket(row.start, data.bucket) ? 'bg-primary' : row.cost_cny === 0 ? 'bg-border' : 'trend-history'}`}
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

function isCurrentBucket(start: string, bucket: UsageResponse['bucket']) {
  const from = new Date(`${start}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + (bucket === 'week' ? 7 : 1));
  const now = Date.now();
  return from.getTime() <= now && now < to.getTime();
}
