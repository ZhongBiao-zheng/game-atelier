import { useEffect, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLocation, useSearch } from 'wouter';
import { fetchUsage } from '@/api/usage';
import { fetchGateway } from '@/api/gateway';
import type { UsageRange, UsageResponse, UsageScope, UsageSource } from '@/schema/usage';
import { KpiRow } from './KpiRow';
import { TrendChart } from './TrendChart';
import { RankingCard } from './RankingCard';
import { TaskTable } from './TaskTable';
import { QuotaCard } from './QuotaCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Select 不接受空字符串选项值，「全部成员」用这个占位。 */
const ALL_MEMBERS = '__all__';
const ranges: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
  { value: 'all', label: '全部' },
];
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
        {enabled && <ToggleGroup type="single" variant="outline" aria-label="用量范围" value={scope}
          onValueChange={value => { if (value) change('scope', value); }}>
          <ToggleGroupItem value="mine">我的</ToggleGroupItem>
          <ToggleGroupItem value="team">团队</ToggleGroupItem>
        </ToggleGroup>}
        <ToggleGroup type="single" variant="outline" aria-label="时间范围" className="max-w-full overflow-x-auto" value={range}
          onValueChange={value => { if (value) change('range', value); }}>
          {ranges.map((item) => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      {scope === 'mine' && data?.sources.includes('lan') && (
        <ToggleGroup type="single" variant="outline" aria-label="来源" value={source}
          onValueChange={value => { if (value) change('source', value); }}>
          {(
            [
              ['all', '全部'],
              ['local', '本机 KEY'],
              ['lan', '局域网'],
            ] as const
          ).map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
        </ToggleGroup>
      )}
      {scope === 'team' && (
        <Select value={member || ALL_MEMBERS} onValueChange={(value) => change('member', value === ALL_MEMBERS ? '' : value)}>
          <SelectTrigger aria-label="成员" className="w-auto max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MEMBERS}>全部成员</SelectItem>
            {data?.members.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
              <TaskTable key={`${scope}:${range}:${source}:${member}`} scope={scope} range={range} source={source} member={member} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
