import { formatGenerationCost } from '@/lib/generationCost';
import { useEffect, useState } from 'react';
import { ChevronLeft, HelpCircle } from 'lucide-react';
import { fetchGatewayMembers, restoreGatewayMember, type GatewayMembers } from '@/api/gateway';
import { listModelRoutes, setModelRouteMode, setModelRouteOrder, type ModelRoute, type RouteMode } from '@/api/models';
import { date } from './lan-sharing/shared';

const MODALITY_LABELS: Record<ModelRoute['modality'], string> = {
  image: '图片', video: '视频', text: '文本', audio: '音频',
};
const HINT = '同一模型可按自定义顺序、估价或轮流选择供应商；欠费成员自动摘除。估价随提交参数变化。';
const routeKey = (route: ModelRoute) => `${route.modality}:${route.id}`;

export function ModelRoutesSection({ reloadToken }: { reloadToken: number }) {
  const [status, setStatus] = useState<GatewayMembers>({ members: [], unavailable_routes: [] });
  const [restoring, setRestoring] = useState(false);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [modality, setModality] = useState<ModelRoute['modality']>('image');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listModelRoutes(), fetchGatewayMembers()])
      .then(([rows, members]) => { if (!cancelled) { setRoutes(rows); setStatus(members); } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const visible = routes.filter(route => route.modality === modality);
  const shared = visible.filter(route => route.members.length > 1);
  const single = visible.filter(route => route.members.length === 1);
  const overdue = status.members.filter(member => member.reason !== 'unavailable');
  const overdueAliases = [...new Set(overdue.map(member => member.alias))];
  const affected = new Set(overdue.flatMap(member => member.route_ids.map(id => `${member.modality}:${id}`))).size;

  async function restore(members: GatewayMembers['members']) {
    setRestoring(true);
    setError(null);
    try {
      for (const member of members) setStatus(await restoreGatewayMember(member.modality, member.alias));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      try { setRoutes(await listModelRoutes()); }
      catch (e) { setError(current => current ?? (e instanceof Error ? e.message : String(e))); }
      setRestoring(false);
    }
  }

  async function save(route: ModelRoute, operation: () => Promise<ModelRoute>) {
    setSavingId(routeKey(route));
    setError(null);
    try {
      const saved = await operation();
      setRoutes(current => current.map(item => routeKey(item) === routeKey(saved) ? saved : item));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingId(null); }
  }

  function moveEarlier(route: ModelRoute, index: number) {
    const aliases = route.members.map(member => member.alias);
    [aliases[index - 1], aliases[index]] = [aliases[index], aliases[index - 1]];
    void save(route, () => setModelRouteOrder(route.modality, route.id, aliases));
  }

  return <section aria-label="模型路由" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">模型 /</span><h1 className="text-sm font-semibold">路由</h1>
        <button type="button" title={HINT} aria-label={HINT} className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><HelpCircle className="size-3.5" aria-hidden /></button>
      </div>
      <div role="tablist" aria-label="模态" className="flex max-w-full flex-wrap rounded-md border border-border bg-background p-0.5">
        {(Object.keys(MODALITY_LABELS) as ModelRoute['modality'][]).filter(kind => kind !== 'audio' || routes.some(route => route.modality === kind)).map(kind =>
          <button key={kind} type="button" role="tab" aria-selected={modality === kind}
            onClick={() => setModality(kind)}
            className={`rounded px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${modality === kind ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}>
            {MODALITY_LABELS[kind]} <span className="text-xs text-muted-foreground">{routes.filter(route => route.modality === kind).length}</span>
          </button>)}
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {overdue.length > 0 && <div role="status" className="flex flex-wrap items-center gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3.5 py-2.5 text-sm">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <span className="min-w-0 flex-1">{overdueAliases.join('、')} 欠费，已从 {affected} 条路由摘除</span>
      <button type="button" disabled={restoring || savingId !== null} onClick={() => void restore(overdue)} className="shrink-0 rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50">全部恢复</button>
    </div>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">加载中…</p> : <>
      {shared.length > 0 && <div aria-label="路由列表" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {shared.map(route => <div key={routeKey(route)} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5">
          <div className="w-52 min-w-0 max-w-full">
            <p className="break-words text-sm font-medium">{route.name}</p>
            <p className="text-xs text-muted-foreground">{route.members.length} 家供应商</p>
            {status.unavailable_routes.some(item => item.id === route.id && item.modality === route.modality) && <p className="text-xs text-destructive">全部成员欠费</p>}
          </div>
          <select aria-label={`${route.name} 的路由方式`} value={route.mode} disabled={savingId !== null || restoring}
            onChange={e => { const mode = e.target.value as RouteMode; void save(route, () => setModelRouteMode(route.modality, route.id, mode)); }}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
            <option value="order">自定义顺序</option><option value="cheap">最便宜</option><option value="round_robin">轮流</option>
          </select>
          <ol aria-label={`${route.name} 的供应商顺序`} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 md:w-auto md:min-w-56 md:flex-1">
            {route.members.map((member, index) => {
              const unavailable = status.members.find(item => item.modality === route.modality && item.alias === member.alias);
              const first = route.mode !== 'round_robin' && member.alias === route.candidate_alias;
              return <li key={member.alias} className="flex max-w-full items-center gap-1.5">
                {index > 0 && <span aria-hidden className="text-subtle-foreground">{route.mode === 'round_robin' ? '·' : '→'}</span>}
                <span className={`flex min-w-0 flex-wrap items-center gap-2 rounded-md border py-1 pl-1 pr-1.5 ${first ? 'border-primary/45 bg-primary/10' : 'border-border'} ${unavailable ? 'opacity-75' : ''}`}>
                  {route.mode === 'order' && <span className={`flex size-5 items-center justify-center rounded tabular-nums text-xs ${first ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{index + 1}</span>}
                  {route.mode === 'cheap' && <span className="pl-1 tabular-nums text-xs text-muted-foreground">{member.estimate_cny == null ? '未计价' : `≈${formatGenerationCost(member.estimate_cny)}`}</span>}
                  <span className="break-all text-sm">{member.alias}</span>
                  {unavailable && <span className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                    {unavailable.reason === 'unavailable' ? '暂时不可用' : `欠费已摘除 · ${date(unavailable.since)}`}
                    {unavailable.reason !== 'unavailable' && <button type="button" disabled={restoring || savingId !== null} onClick={() => void restore([unavailable])} className="rounded border border-border px-2 py-0.5 text-xs text-foreground disabled:opacity-50">恢复</button>}
                  </span>}
                  {route.mode === 'order' && index > 0 && <button type="button" aria-label={`把 ${member.alias} 提前`} disabled={savingId !== null || restoring}
                    onClick={() => moveEarlier(route, index)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><ChevronLeft className="size-3.5" aria-hidden /></button>}
                </span>
              </li>;
            })}
          </ol>
          <span className="text-xs text-muted-foreground">{route.candidate_alias ? `${route.mode === 'round_robin' ? '下一次走' : '当前走'} ${route.candidate_alias}` : '全部不可用'}</span>
        </div>)}
      </div>}
      {single.length > 0 && <details className="rounded-lg border border-border px-4 py-3">
        <summary className="cursor-pointer text-sm text-muted-foreground">只有一家供应商的模型 · {single.length}</summary>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {single.map(route => <li key={routeKey(route)}><span>{route.name}</span><span className="ml-2 text-xs">{route.members[0].alias}</span></li>)}
        </ul>
      </details>}
      {visible.length === 0 && !error && <p className="text-sm text-muted-foreground">暂无{MODALITY_LABELS[modality]}模型</p>}
    </>}
  </section>;
}
