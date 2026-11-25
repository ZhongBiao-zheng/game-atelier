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
import { useTaskFilters } from './useTaskFilters';
import { QuotaCard } from './QuotaCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDelayedFlag } from './useDelayedFlag';
import { errorText } from '@/lib/errorText';

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
  const taskFilters = useTaskFilters();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dimmed = useDelayedFlag(loading && data !== null);
  useEffect(() => {
    let active = true;
    fetchGateway()
      .then((state) => {
        if (active) setEnabled(state.enabled);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
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
        if (active) setError(errorText(e));
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
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === 'scope') {
      next.delete('member');
      next.delete('source');
      next.delete('task_project');
      next.delete('task_alias');
    }
    navigate(`/settings/usage?${next}`);
  }
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 团队开关要等网关状态读回来才知道有没有：读的期间先占位（不可见），出现时不把时间范围挤到下一行。 */}
        {enabled !== false && <ToggleGroup type="single" variant="outline" sliding aria-label="用量范围" value={scope}
          className={enabled ? undefined : 'invisible'}
          onValueChange={value => { if (value) change('scope', value); }}>
          <ToggleGroupItem value="mine">我的</ToggleGroupItem>
          <ToggleGroupItem value="team">团队</ToggleGroupItem>
        </ToggleGroup>}
        <ToggleGroup type="single" variant="outline" sliding aria-label="时间范围" className="max-w-full overflow-x-auto" value={range}
          onValueChange={value => { if (value) change('range', value); }}>
          {ranges.map((item) => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      {scope === 'mine' && data?.sources.includes('lan') && (
        <ToggleGroup type="single" variant="outline" sliding aria-label="来源" value={source}
          onValueChange={value => { if (value) change('source', value); }}>
          {(
            [
              ['all', '全部'],
              ['local', '本机供应商'],
              ['lan', '团队网关'],
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
      {!data && loading && !error && <p className="text-sm text-muted-foreground">加载中…</p>}
      {data && (
        <div className="space-y-6">
          {/* 换范围时旧数据留在原地，请求慢于 150ms 才降透明度，新数据到达再淡回。任务表自管刷新，不在这一层叠暗。 */}
          <div aria-busy={loading} className={`space-y-6 transition-opacity duration-200 ${dimmed ? 'opacity-50' : ''}`}>
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
              </>
            )}
          </div>
          {data.totals.count > 0 && (
            <TaskTable scope={scope} range={range} source={source} member={member} {...taskFilters.fields}
              memberLabel={data.members.find(item => item.id === member)?.name} onFiltersChange={taskFilters.change} />
          )}
        </div>
      )}
    </div>
  );
}
