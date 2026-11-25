import { formatGenerationCost } from '@/lib/generationCost';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeftIcon, HelpIcon } from '@/components/ui/icons';
import { fetchGatewayMembers, restoreGatewayMember, type GatewayMembers } from '@/api/gateway';
import { listModelRoutes, setModelRouteMode, setModelRouteOrder, type ModelRoute, type RouteMode } from '@/api/models';
import { date } from './lan-sharing/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Disclosure } from '@/components/ui/disclosure';
import { useRetained } from '@/components/ui/retained';
import { MOTION_SPRING } from '@/lib/motion';

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
  const shownError = useRetained(error);
  // 「提前」每条路由串行写入：同一时间只有一个请求在途，等待期间的换位只记最新目标顺序，回来后接着写。
  // 键在表里 = 这条路由有写入在途；值 = 排队等写的最新顺序（没有为 null）。
  const orderQueue = useRef(new Map<string, string[] | null>());
  // 有顺序写入在途的路由：这期间不切路由方式，「全部恢复」也等写完再刷新，免得旧快照盖住本地顺序。
  const [ordering, setOrdering] = useState<ReadonlySet<string>>(() => new Set());

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

  /** 「提前」先在本地换位（成员行带布局动画滑到新位置），再保存；不禁用按钮，可以连点。
   *  写入按路由串行：请求在途时再点只更新本地顺序并记成下一次要写的目标，请求回来后写最新目标，
   *  直到没有新目标才用服务端结果落位。失败报错并退回服务端当前顺序（期间又点了就接着写新目标）。 */
  async function moveEarlier(route: ModelRoute, index: number) {
    const key = routeKey(route);
    const aliases = route.members.map(member => member.alias);
    [aliases[index - 1], aliases[index]] = [aliases[index], aliases[index - 1]];
    const unavailable = new Set(status.members.filter(item => item.modality === route.modality).map(item => item.alias));
    const optimistic: ModelRoute = {
      ...route,
      members: aliases.map(alias => route.members.find(member => member.alias === alias)!),
      candidate_alias: route.mode === 'order' ? aliases.find(alias => !unavailable.has(alias)) ?? null : route.candidate_alias,
    };
    const apply = (next: ModelRoute) => setRoutes(current => current.map(item => routeKey(item) === key ? next : item));
    apply(optimistic);
    setError(null);
    const queue = orderQueue.current;
    if (queue.has(key)) {
      queue.set(key, aliases);
      return;
    }
    queue.set(key, null);
    setOrdering(current => new Set(current).add(key));
    const takeNext = () => {
      const next = queue.get(key) ?? null;
      queue.set(key, null);
      return next;
    };
    let target: string[] | null = aliases;
    while (target) {
      try {
        const saved = await setModelRouteOrder(route.modality, route.id, target);
        target = takeNext();
        if (!target) apply(saved);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        let fresh: ModelRoute | undefined;
        try { fresh = (await listModelRoutes()).find(item => routeKey(item) === key); }
        catch { /* 读不回来就保留当前顺序，报错已经显示 */ }
        target = takeNext();
        if (!target && fresh) apply(fresh);
      }
    }
    queue.delete(key);
    setOrdering(current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  return <section aria-label="智能路由" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">模型 /</span><h1 className="text-sm font-semibold">智能路由</h1>
        <Hint label={HINT}><Button variant="bare" type="button" aria-label={HINT} className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><HelpIcon size="sm" aria-hidden /></Button></Hint>
      </div>
      <Tabs value={modality} onValueChange={value => setModality(value as ModelRoute['modality'])}>
        <TabsList aria-label="模态" className="h-auto max-w-full flex-wrap">
          {(Object.keys(MODALITY_LABELS) as ModelRoute['modality'][]).filter(kind => kind !== 'audio' || routes.some(route => route.modality === kind)).map(kind =>
            <TabsTrigger key={kind} value={kind} className="flex-none px-3">
              {MODALITY_LABELS[kind]} <span className="text-xs text-muted-foreground">{routes.filter(route => route.modality === kind).length}</span>
            </TabsTrigger>)}
        </TabsList>
      </Tabs>
    </div>
    <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
    {overdue.length > 0 && <div role="status" className="flex flex-wrap items-center gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3.5 py-2.5 text-sm">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <span className="min-w-0 flex-1">{overdueAliases.join('、')} 欠费，已从 {affected} 条路由摘除</span>
      <Button variant="outline" size="sm" type="button" disabled={restoring || savingId !== null || ordering.size > 0} onClick={() => void restore(overdue)} className="shrink-0">全部恢复</Button>
    </div>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">加载中…</p> : <>
      {shared.length > 0 && <div aria-label="路由列表" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {shared.map(route => <div key={routeKey(route)} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5">
          <div className="w-52 min-w-0 max-w-full">
            <p className="break-words text-sm font-medium">{route.name}</p>
            <p className="text-xs text-muted-foreground">{route.members.length} 家供应商</p>
            {status.unavailable_routes.some(item => item.id === route.id && item.modality === route.modality) && <p className="text-xs text-destructive">全部成员欠费</p>}
          </div>
          <Select value={route.mode} disabled={savingId !== null || restoring || ordering.has(routeKey(route))}
            onValueChange={value => { const mode = value as RouteMode; void save(route, () => setModelRouteMode(route.modality, route.id, mode)); }}>
            <SelectTrigger size="sm" aria-label={`${route.name} 的路由方式`} className="w-auto"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="order">自定义顺序</SelectItem><SelectItem value="cheap">最便宜</SelectItem><SelectItem value="round_robin">轮流</SelectItem>
            </SelectContent>
          </Select>
          <ol aria-label={`${route.name} 的供应商顺序`} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 md:w-auto md:min-w-56 md:flex-1">
            {route.members.map((member, index) => {
              const unavailable = status.members.find(item => item.modality === route.modality && item.alias === member.alias);
              const first = route.mode !== 'round_robin' && member.alias === route.candidate_alias;
              return <motion.li layout="position" transition={MOTION_SPRING.snappy} key={member.alias} className="flex max-w-full items-center gap-1.5">
                {index > 0 && <span aria-hidden className="text-subtle-foreground">{route.mode === 'round_robin' ? '·' : '→'}</span>}
                <span className={`flex min-w-0 flex-wrap items-center gap-2 rounded-md border py-1 pl-1 pr-1.5 ${first ? 'border-primary/45 bg-primary/10' : 'border-border'} ${unavailable ? 'opacity-75' : ''}`}>
                  {route.mode === 'order' && <span className={`flex size-5 items-center justify-center rounded tabular-nums text-xs ${first ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{index + 1}</span>}
                  {route.mode === 'cheap' && <span className="pl-1 tabular-nums text-xs text-muted-foreground">{member.estimate_cny == null ? '未计价' : `≈${formatGenerationCost(member.estimate_cny)}`}</span>}
                  <span className="break-all text-sm">{member.alias}</span>
                  {unavailable && <span className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                    {unavailable.reason === 'unavailable' ? '暂时不可用' : `欠费已摘除 · ${date(unavailable.since)}`}
                    {unavailable.reason !== 'unavailable' && <Button variant="bare" type="button" disabled={restoring || savingId !== null || ordering.size > 0} onClick={() => void restore([unavailable])} className="rounded border border-border px-2 py-0.5 text-xs text-foreground disabled:opacity-50">恢复</Button>}
                  </span>}
                  {route.mode === 'order' && index > 0 && <Button variant="bare" type="button" aria-label={`把 ${member.alias} 提前`} disabled={savingId !== null || restoring}
                    onClick={() => void moveEarlier(route, index)} className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><ChevronLeftIcon size="sm" aria-hidden /></Button>}
                </span>
              </motion.li>;
            })}
          </ol>
          <span className="text-xs text-muted-foreground">{route.candidate_alias ? `${route.mode === 'round_robin' ? '下一次走' : '当前走'} ${route.candidate_alias}` : '全部不可用'}</span>
        </div>)}
      </div>}
      {single.length > 0 && <Disclosure summary={`只有一家供应商的模型 · ${single.length}`} className="rounded-lg border border-border px-4 py-3" triggerClassName="w-full text-sm">
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {single.map(route => <li key={routeKey(route)}><span>{route.name}</span><span className="ml-2 text-xs">{route.members[0].alias}</span></li>)}
        </ul>
      </Disclosure>}
      {visible.length === 0 && !error && <p className="text-sm text-muted-foreground">暂无{MODALITY_LABELS[modality]}模型</p>}
    </>}
  </section>;
}
