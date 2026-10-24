import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { fetchUsage } from '@/api/usage';
import { fetchGateway } from '@/api/gateway';
import type { UsageRange, UsageResponse, UsageScope, UsageSource } from '@/schema/usage';
import { KpiRow } from './KpiRow';
import { TrendChart } from './TrendChart';
import { RankingCard } from './RankingCard';
import { TopTasks } from './TopTasks';
import { QuotaCard } from './QuotaCard';
const ranges: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
  { value: 'all', label: '全部' },
];
const chip = 'whitespace-nowrap rounded-md px-3 py-1.5 text-sm hover:bg-secondary';
export function UsagePage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const query = new URLSearchParams(search);
  const scope: UsageScope = query.get('scope') === 'team' ? 'team' : 'mine';
  const range = ranges.find((item) => item.value === query.get('range'))?.value ?? '30d';
  const source: UsageSource =
    query.get('source') === 'lan' ? 'lan' : query.get('source') === 'local' ? 'local' : 'all';
  const member = query.get('member') ?? '';
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetchGateway()
      .then((state) => {
        if (active) setEnabled(state.enabled);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (scope === 'team' && enabled === false) {
      const next = new URLSearchParams(search);
      next.set('scope', 'mine');
      next.delete('member');
      navigate(`/settings/usage?${next}`, { replace: true });
    }
  }, [enabled, scope, search, navigate]);
  useEffect(() => {
    if (scope === 'team' && enabled !== true) return;
    let active = true;
    setLoading(true);
    setError('');
    fetchUsage({ scope, range, source, member })
      .then((next) => {
        if (active) setData(next);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope, range, source, member, enabled]);
  function change(name: string, value: string) {
    const next = new URLSearchParams(search);
    next.set(name, value);
    if (name === 'scope') {
      next.delete('member');
      next.delete('source');
    }
    navigate(`/settings/usage?${next}`);
  }
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-border p-1" aria-label="用量范围">
          <button
            className={`${chip} ${scope === 'mine' ? 'bg-secondary' : ''}`}
            aria-pressed={scope === 'mine'}
            onClick={() => change('scope', 'mine')}
          >
            我的
          </button>
          {enabled && (
            <button
              className={`${chip} ${scope === 'team' ? 'bg-secondary' : ''}`}
              aria-pressed={scope === 'team'}
              onClick={() => change('scope', 'team')}
            >
              团队
            </button>
          )}
        </div>
        <div
          className="flex max-w-full overflow-x-auto rounded-lg border border-border p-1"
          aria-label="时间范围"
        >
          {ranges.map((item) => (
            <button
              key={item.value}
              aria-pressed={range === item.value}
              className={`${chip} ${range === item.value ? 'bg-secondary' : ''}`}
              onClick={() => change('range', item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {scope === 'mine' && data?.sources.includes('lan') && (
        <div className="flex gap-1" aria-label="来源">
          {(
            [
              ['all', '全部'],
              ['local', '本机 KEY'],
              ['lan', '局域网'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={source === value}
              className={`${chip} ${source === value ? 'bg-secondary' : ''}`}
              onClick={() => change('source', value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {scope === 'team' && (
        <select
          aria-label="成员"
          value={member}
          onChange={(e) => change('member', e.target.value)}
          className="h-9 max-w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">全部成员</option>
          {data?.members.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!data && loading && !error && <p className="text-sm text-muted-foreground">读取中…</p>}
      {data && (
        <div aria-busy={loading} className={`space-y-6 ${loading ? 'opacity-50' : ''}`}>
          <KpiRow data={data}>
            <QuotaCard />
          </KpiRow>
          {data.totals.count === 0 ? (
            <p className="text-sm text-muted-foreground">暂无用量记录</p>
          ) : (
            <>
              <TrendChart data={data} />
              <div className="grid gap-4 md:grid-cols-2">
                {data.rankings.map((ranking) => (
                  <RankingCard key={ranking.by} ranking={ranking} />
                ))}
              </div>
              <TopTasks tasks={data.top} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
