import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { listKeys } from '@/api/keys';
import { adminBase, fetchGatewayProviderMe, type GatewayMembers } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { requestJson } from '@/api/http';
import { fetchUsage } from '@/api/usage';
import type { UsageRange, UsageResponse } from '@/schema/usage';
import { AuditLog } from './lan-sharing/AuditLog';
import { LanSharingSection } from './LanSharingSection';
import { button } from './lan-sharing/shared';
import { KpiRow } from './usage/KpiRow';
import { TrendChart } from './usage/TrendChart';
import { RankingCard } from './usage/RankingCard';
import { TaskTable } from './usage/TaskTable';
import { Select } from '@/components/ui/select';

export function useAdminGateways() {
  const [aliases, setAliases] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const data = await listKeys();
        const values = await Promise.all(data.keys.filter(key => key.provider === 'atelier' && key.enabled)
          .map(async key => (await fetchGatewayProviderMe(key.alias))?.role === 'admin' ? key.alias : null));
        if (active && current === sequence) setAliases(values.filter((alias): alias is string => alias !== null));
      } catch { if (active && current === sequence) setAliases([]); }
      finally { if (active && current === sequence) setLoaded(true); }
    };
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 30000);
    const unsubscribe = subscribeGatewayEvents({ onConnect: () => { void refresh(); }, onTask: () => {} });
    return () => { active = false; clearInterval(interval); unsubscribe(); };
  }, []);
  return { aliases, loaded };
}

function TeamUsage({ alias }: { alias: string }) {
  const [range, setRange] = useState<UsageRange>('30d');
  const [member, setMember] = useState(() => new URLSearchParams(window.location.search).get('member') ?? '');
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetchUsage({ scope: 'team', range, source: 'all', member }, alias)
      .then(next => { if (active) { setData(next); setError(''); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [alias, range, member]);
  return <section className="space-y-6" aria-label="中转团队用量">
    <div className="flex flex-wrap gap-3">
      <Select variant="bare" aria-label="用量时间范围" className={button} value={range} onChange={e => setRange(e.target.value as UsageRange)}>
        {([['today', '今天'], ['7d', '7 天'], ['30d', '30 天'], ['90d', '90 天'], ['all', '全部']] as const).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <Select variant="bare" aria-label="用量成员" className={button} value={member} onChange={e => setMember(e.target.value)}><option value="">全部成员</option>{data?.members.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</Select>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data && <><KpiRow data={data} /><TrendChart data={data} /><div className="grid gap-4 md:grid-cols-2">{data.rankings.map(ranking => <RankingCard key={ranking.by} ranking={ranking} />)}</div></>}
    <TaskTable gatewayAlias={alias} scope="team" range={range} source="all" member={member} />
  </section>;
}

type Route = { id: string; name: string; modality: string; aliases: string[] };
function Upstreams({ alias }: { alias: string }) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [status, setStatus] = useState<GatewayMembers | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([requestJson<{ models: Route[] }>(`${adminBase(alias)}/routes`, '读取中转路由'), requestJson<GatewayMembers>(`${adminBase(alias)}/members`, '读取上游状态')])
      .then(([next, members]) => { if (active) { setRoutes(next.models); setStatus(members); setError(''); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [alias, revision]);
  async function write(path: string, body: unknown, method = 'POST') {
    setBusy(true); setError('');
    try { await requestJson(`${adminBase(alias)}${path}`, '保存中转设置', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setRevision(value => value + 1); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label="中转上游与路由">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!routes.length && !error && <p className="text-sm text-muted-foreground">暂无上游路由</p>}
    {routes.map(route => <div key={`${route.modality}:${route.id}`} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium">{route.name} <span className="text-xs text-muted-foreground">{route.modality}</span></h3>
      <ol className="space-y-2">{route.aliases.map((upstream, index) => {
        const blocked = status?.members.find(row => row.alias === upstream && row.modality === route.modality);
        return <li key={upstream} className="flex flex-wrap items-center gap-3 text-xs">
          <span className="min-w-0 break-all">{index + 1}. {upstream}</span><span className="text-muted-foreground">{blocked ? blocked.reason === 'insufficient_balance' ? '余额不足' : '暂不可用' : '可用'}</span>
          {blocked && <button className={button} disabled={busy} onClick={() => void write(`/members/${encodeURIComponent(upstream)}/restore`, { modality: route.modality })}>恢复</button>}
          <button className={button} disabled={busy || index === 0} aria-label={`上移 ${upstream}`} onClick={() => {
            const aliases = [...route.aliases]; [aliases[index - 1], aliases[index]] = [aliases[index], aliases[index - 1]];
            void write('/routes/order', { modality: route.modality, id: route.id, aliases }, 'PUT');
          }}>上移</button>
        </li>;
      })}</ol>
    </div>)}
  </section>;
}

export function RelayAdminPage() {
  const { aliases, loaded } = useAdminGateways();
  const search = useSearch();
  const [, navigate] = useLocation();
  const query = new URLSearchParams(search);
  const selected = query.get('alias');
  const alias = selected && aliases.includes(selected) ? selected : aliases[0];
  const view = query.get('view') ?? 'members';
  function change(name: string, value: string) { const next = new URLSearchParams(search); next.set(name, value); navigate(`/settings/relay-admin?${next}`); }
  if (!alias) return <p className="text-sm text-muted-foreground">{loaded ? '没有可用的管理员中转连接' : '读取中转连接…'}</p>;
  return <div className="min-w-0 space-y-6">
    <div className="flex flex-wrap gap-3"><Select variant="bare" aria-label="管理的中转" className={button} value={alias} onChange={e => change('alias', e.target.value)}>{aliases.map(value => <option key={value}>{value}</option>)}</Select>
      {([['members', '成员'], ['usage', '团队用量'], ['upstreams', '上游与路由'], ['audit', '操作日志']] as const).map(([value, label]) => <button key={value} className={`${button} ${view === value ? 'bg-secondary' : ''}`} aria-pressed={view === value} onClick={() => change('view', value)}>{label}</button>)}
    </div>
    {view === 'audit' ? <AuditLog gatewayAlias={alias} /> : view === 'usage' ? <TeamUsage key={alias} alias={alias} /> : view === 'upstreams' ? <Upstreams key={alias} alias={alias} /> : <LanSharingSection key={alias} gatewayAlias={alias} />}
  </div>;
}
