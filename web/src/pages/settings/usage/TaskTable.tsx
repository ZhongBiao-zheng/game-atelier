import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Link, useLocation, useSearch } from 'wouter';
import { fetchUsageTasks } from '@/api/usage';
import type { UsageRange, UsageScope, UsageSource, UsageTask, UsageTaskFilter, UsageTaskFields, UsageTasksResponse } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
import { KindBadge } from './KindBadge';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { SwapLabel } from '@/components/ui/swap-label';
import type { TaskFilterChanges, TaskFilterName } from './useTaskFilters';
import { useDelayedFlag } from './useDelayedFlag';
import { errorText } from '@/lib/errorText';

type Filters = UsageTaskFields & {
  gatewayAlias?: string; scope: UsageScope; range: UsageRange; source: UsageSource; member: string;
  memberLabel?: string; onFiltersChange?: (changes: TaskFilterChanges) => void;
};
const kindLabels: Record<string, string> = { image: '图片', video: '视频', text: '文本', audio: '音频' };
const fieldLabels = { project: '项目', model: '模型', alias: '供应商', kind: '类型', member: '成员' };
const statuses: { value: UsageTaskFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'done', label: '成功' },
  { value: 'failed', label: '失败' }, { value: 'unpriced', label: '未计价' },
];
const statusLabels: Record<string, string> = { done: '成功', failed: '失败', pending: '进行中', running: '进行中', canceled: '已取消' };
const statusColors: Record<string, string> = { done: 'bg-[color:var(--status-done)]', failed: 'bg-destructive', pending: 'bg-[color:var(--status-running)]', running: 'bg-[color:var(--status-running)]' };
const CHARGED_AFTER_STOP = '停止前上游已经开始执行并扣费，金额为实际扣费';
const chargedAfterStop = (task: UsageTask) => task.status === 'canceled' && (task.cost_cny ?? 0) > 0;
const cell = 'px-4 py-3';
const warning = 'text-[color:var(--status-running)]';
function duration(seconds: number | null) {
  if (seconds === null) return '—';
  const value = Math.max(0, Math.round(seconds));
  return value < 60 ? `${value}s` : `${Math.floor(value / 60)}m ${value % 60}s`;
}
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

const isStatus = (value: string | null): value is UsageTaskFilter => statuses.some(item => item.value === value);

export function TaskTable(filters: Filters) {
  // 用量卡片「未计价」点进来时带 task_status=unpriced，直接筛到未计价的任务。
  const urlStatus = new URLSearchParams(useSearch()).get('task_status');
  const [status, setStatus] = useState<UsageTaskFilter>(isStatus(urlStatus) ? urlStatus : 'all');
  useEffect(() => { if (isStatus(urlStatus)) setStatus(urlStatus); }, [urlStatus]);
  const [data, setData] = useState<UsageTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // 换筛选时旧行留在原地，请求慢于 150ms 才降透明度，新数据到达再淡回；「加载更多」不算刷新。
  const [refreshing, setRefreshing] = useState(false);
  const dimmed = useDelayedFlag(refreshing && data !== null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const [, navigate] = useLocation();
  const { scope, range, source, member, gatewayAlias, project, model, alias, kind, onFiltersChange } = filters;
  const fields: UsageTaskFields = useMemo(() => ({
    ...(project ? { project } : {}), ...(model ? { model } : {}),
    ...(alias ? { alias } : {}), ...(kind ? { kind } : {}),
  }), [project, model, alias, kind]);
  useEffect(() => {
    const current = ++request.current;
    setLoading(true);
    setRefreshing(true);
    setError('');
    fetchUsageTasks({ scope, range, source, member, status, offset: 0, ...fields }, ...(gatewayAlias ? [gatewayAlias] as const : []))
      .then(next => { if (request.current === current) setData(next); })
      .catch(e => { if (request.current === current) setError(errorText(e)); })
      .finally(() => { if (request.current === current) { setLoading(false); setRefreshing(false); } });
    return () => { request.current = current + 1; };
  }, [scope, range, source, member, status, gatewayAlias, fields]);

  async function more() {
    if (loading || data?.next_offset == null) return;
    const current = request.current;
    setLoading(true);
    setError('');
    try {
      const next = await fetchUsageTasks({ scope, range, source, member, status, offset: data.next_offset, ...fields }, ...(gatewayAlias ? [gatewayAlias] as const : []));
      if (current === request.current) setData(previous => ({ ...next, rows: [...(previous?.rows ?? []), ...next.rows] }));
    } catch (e) { if (current === request.current) setError(errorText(e)); }
    finally { if (current === request.current) setLoading(false); }
  }

  function tag(name: TaskFilterName, value: string | null, label: string | null, content?: ReactNode) {
    if (!value || !label) return '—';
    const selected = filters[name] === value;
    return <Hint label={label}><Button type="button" variant="ghost" size="sm" aria-pressed={selected}
      className={`max-w-full rounded-full px-2 font-normal ${selected ? 'bg-secondary' : ''}`}
      onClick={event => { event.stopPropagation(); onFiltersChange?.({ [name]: selected ? '' : value }); }}>
      {content ?? <span className="truncate">{label}</span>}
    </Button></Hint>;
  }
  const active: TaskFilterChanges = { ...fields, ...(scope === 'team' && member ? { member } : {}) };
  function filterLabel(name: TaskFilterName, value: string) {
    if (name === 'project') return data?.rows.find(row => row.project_key === value)?.project_label ?? value;
    if (name === 'member') return filters.memberLabel ?? data?.rows.find(row => row.member_key === value)?.member_label ?? value;
    if (name === 'kind') return kindLabels[value] ?? value;
    return value;
  }

  function statusCell(task: UsageTask) {
    const label = <span className={`flex items-center gap-1.5 ${task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${statusColors[task.status] ?? 'bg-muted-foreground'}`} />{statusLabels[task.status] ?? task.status}
      {chargedAfterStop(task) && ' · 已扣费'}
    </span>;
    // 已停止的任务一般不计；停止前上游已经扣了费的（含网关主机跑完后回写的）按实际扣费计入，这里说明来由。
    return chargedAfterStop(task) ? <Hint label={CHARGED_AFTER_STOP}><span tabIndex={0} className="inline-flex">{label}</span></Hint> : label;
  }

  function row(task: UsageTask) {
    const slow = ['image', 'image_edit', 'layer_split'].includes(task.kind) && task.duration_s !== null && task.duration_s > 60;
    return <tr key={task.id} onClick={e => {
      if (task.href && !(e.target as HTMLElement).closest('a')) navigate(task.href);
    }} className={`border-t border-border ${task.href ? 'cursor-pointer hover:bg-secondary/40' : ''}`}>
      <td className={`${cell} whitespace-nowrap tabular-nums text-muted-foreground`}>
        {task.href ? <Link href={task.href} aria-label={`查看任务 ${task.id}`} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{time(task.at)}</Link> : time(task.at)}
      </td>
      <td className={`${cell} max-w-48`}>{scope === 'team' ? '—' : tag('project', task.project_key, task.project_label)}</td>
      <td className={`${cell} max-w-64 font-mono text-xs`}>{tag('model', task.model, task.model)}</td>
      <td className={`${cell} max-w-40`}>{scope === 'team' ? tag('member', task.member_key, task.member_label) : tag('alias', task.alias, task.alias)}</td>
      <td className={`${cell} whitespace-nowrap`}>{tag('kind', ['image_edit', 'layer_split'].includes(task.kind) ? 'image' : task.kind,
        kindLabels[['image_edit', 'layer_split'].includes(task.kind) ? 'image' : task.kind] ?? task.kind, <KindBadge kind={task.kind} />)}</td>
      <td className={`${cell} whitespace-nowrap text-right tabular-nums ${slow ? warning : 'text-muted-foreground'}`}>{duration(task.duration_s)}</td>
      <td className={`${cell} whitespace-nowrap text-right tabular-nums ${task.cost_cny === null ? warning : ''}`}>{task.cost_cny === null
        ? (scope !== 'team' && !gatewayAlias && task.alias && task.model
          // 本机供应商的未计价任务：直接打开那个供应商的表单，展开到该模型的单价框。
          ? <Hint label="去补单价"><Link href={`/settings/providers?edit=${encodeURIComponent(task.alias)}&price=${encodeURIComponent(task.model)}`}
            onClick={event => event.stopPropagation()} className={`${warning} underline decoration-dotted underline-offset-4`}>未计价</Link></Hint>
          : '未计价')
        : formatGenerationCost(task.cost_cny)}</td>
      <td className={`${cell} whitespace-nowrap`}>{statusCell(task)}</td>
    </tr>;
  }

  return <section aria-label="任务" aria-busy={loading} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <h2 className="text-sm font-semibold">任务 {data && <span className="font-normal tabular-nums text-muted-foreground">{data.total}</span>}</h2>
      <ToggleGroup type="single" variant="outline" sliding aria-label="状态筛选" value={status}
        onValueChange={value => { if (!value || value === status) return; request.current++; setStatus(value as typeof status); }}>
        {statuses.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
      </ToggleGroup>
    </div>
    {Object.keys(active).length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label="任务筛选条件">
      {Object.entries(active).map(([name, value]) => <Button key={name} type="button" variant="outline" size="sm"
        className="max-w-full rounded-full" aria-label={`移除${fieldLabels[name as TaskFilterName]}筛选`}
        onClick={() => onFiltersChange?.({ [name]: '' })}>
        <span className="truncate">{fieldLabels[name as TaskFilterName]}：{filterLabel(name as TaskFilterName, value)}</span><span aria-hidden>×</span>
      </Button>)}
      {Object.keys(active).length >= 2 && <Button type="button" variant="ghost" size="sm"
        onClick={() => onFiltersChange?.(Object.fromEntries(Object.keys(active).map(name => [name, ''])))}>清除筛选</Button>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data && loading && <p role="status" className="text-sm text-muted-foreground">加载中…</p>}
    {data && <div className={`space-y-3 transition-opacity duration-200 ${dimmed ? 'opacity-50' : ''}`}>
      {data.rows.length > 0 ? <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground">
            {['时间', '项目', '模型', scope === 'team' ? '成员' : '供应商', '类型', '耗时', '费用', '状态'].map(label =>
              <th key={label} scope="col" className={`${cell} font-normal ${['耗时', '费用'].includes(label) ? 'text-right' : ''}`}>{label}</th>)}
          </tr></thead>
          <tbody>{data.rows.map(row)}</tbody>
        </table>
      </div> : <p className="text-sm text-muted-foreground">暂无匹配的任务</p>}
      {data.next_offset !== null && <div className="text-center"><Button variant="outline" size="sm" type="button" disabled={loading} onClick={() => void more()}
       ><SwapLabel active={loading && !refreshing} on="加载中…" off="加载更多" /></Button></div>}
    </div>}
  </section>;
}
