import { useCallback, useEffect, useRef, useState } from 'react';
import { adminBase, fetchGatewayTasks, gatewayOutputUrl, type GatewayTask } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { date } from './shared';

import { KindBadge } from '../usage/KindBadge';
import { Hint } from '@/components/ui/tooltip';
import { HelpIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Lightbox } from '@/components/Lightbox';

export const isActive = (task: GatewayTask) => task.status === 'pending' || task.status === 'running';
export function mergeTask(rows: GatewayTask[], next: GatewayTask) {
  const old = rows.find(row => row.task_id === next.task_id);
  if (old && old.updated_at > next.updated_at) return rows;
  return [next, ...rows.filter(row => row.task_id !== next.task_id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
const PLACEHOLDER_HINT = '成员停止时主机还没收到这次提交；之后到达的同一请求不会执行，不计费';
const PHASES: Record<string, string> = { queued: '排队', sent: '已提交', downloading: '下载中…', pending: '排队', running: '生成中…', done: '完成', failed: '失败', canceled: '已停止' };
/** 刚结束的任务在「运行中」里停留多久再收起：看得到它的结果，不是一闪就跳到「最近 24 小时」。 */
const LINGER_MS = 1000;
/** 收起动画（grid-rows 0fr，duration-300）播完再移除。 */
const LEAVE_MS = 300;
type Lingering = { task: GatewayTask; leaving: boolean };

export function Tasks({ onFinished, gatewayAlias }: { onFinished: () => void; gatewayAlias?: string }) {
  const [active, setActive] = useState<GatewayTask[]>([]);
  const [recent, setRecent] = useState<GatewayTask[]>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  // 页内大图：新标签页拿不到本机会话，桌面外壳里还会被转去系统浏览器。
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [lingering, setLingering] = useState<Lingering[]>([]);
  const lingerTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = lingerTimers.current;
    return () => { timers.forEach(clearTimeout); timers.clear(); };
  }, []);
  const later = useCallback((ms: number, run: () => void) => {
    const timer = setTimeout(() => { lingerTimers.current.delete(timer); run(); }, ms);
    lingerTimers.current.add(timer);
  }, []);
  // 刚结束的任务先留在「运行中」原位显示结果 1 秒，再收起（高度收成 0 并淡出）后移除。
  const linger = useCallback((finished: GatewayTask[]) => {
    if (!finished.length) return;
    const ids = new Set(finished.map(task => task.task_id));
    setLingering(rows => [...rows.filter(row => !ids.has(row.task.task_id)), ...finished.map(task => ({ task, leaving: false }))]);
    later(LINGER_MS, () => {
      setLingering(rows => rows.map(row => ids.has(row.task.task_id) ? { ...row, leaving: true } : row));
      later(LEAVE_MS, () => setLingering(rows => rows.filter(row => !ids.has(row.task.task_id) || !row.leaving)));
    });
  }, [later]);
  const activeRef = useRef(active); activeRef.current = active;
  const finishedRef = useRef(onFinished); finishedRef.current = onFinished;
  const latest = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const version = epoch.current;
    try {
      const [running, finished] = await Promise.all([fetchGatewayTasks('active', gatewayAlias), fetchGatewayTasks('recent', gatewayAlias)]);
      if (!mounted.current || version !== epoch.current) return;
      for (const row of [...running, ...finished]) latest.current.set(row.task_id, row.updated_at);
      const ended = activeRef.current.filter(row => !running.some(next => next.task_id === row.task_id));
      if (ended.length) finishedRef.current();
      linger(ended.map(row => finished.find(next => next.task_id === row.task_id) ?? row));
      setActive(running); setRecent(finished); setError('');
    } catch (e) { if (mounted.current) setError(String(e)); }
  }, [gatewayAlias, linger]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (gatewayAlias) {
      const events = new EventSource(`${adminBase(gatewayAlias)}/live`);
      events.onopen = () => { void refresh(); };
      events.addEventListener('task', () => { void refresh(); });
      return () => events.close();
    }
    return subscribeGatewayEvents({ onConnect: () => { void refresh(); }, onTask: task => {
    if ((latest.current.get(task.task_id) ?? '') > task.updated_at) return;
    latest.current.set(task.task_id, task.updated_at);
    epoch.current++;
    if (!isActive(task) && activeRef.current.some(row => row.task_id === task.task_id)) linger([task]);
    setActive(rows => mergeTask(rows, task).filter(isActive));
    if (!isActive(task)) { setRecent(rows => mergeTask(rows, task).slice(0, 200)); finishedRef.current(); }
  } }); }, [refresh, gatewayAlias, linger]);
  const running = active.length > 0;
  useEffect(() => {
    if (!running && !gatewayAlias) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void refresh(); }, 4000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [running, refresh, gatewayAlias]);
  function row(task: GatewayTask, preview = false, leaving = false) {
    if (task.placeholder) return <li key={task.task_id} className="border-t border-border py-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{task.key_name}</span><span className="text-muted-foreground">已取消的提交</span>
        <Hint label={PLACEHOLDER_HINT}><span tabIndex={0} aria-label="已取消的提交说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
        <span className="tabular-nums text-muted-foreground">{date(task.updated_at)}</span>
      </div>
    </li>;
    // 收起走 grid-rows 1fr → 0fr（只动这一行的高度，下面的行跟着上移），同时淡出。
    return <li key={task.task_id} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${leaving ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]'}`}>
      <div className="min-h-0 overflow-hidden"><div className="space-y-2 border-t border-border py-3 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <KindBadge kind={task.kind} /><span>{task.key_name}</span><Hint label={task.route_id}><span className="max-w-64 truncate">{task.workflow_name ?? task.route_id}</span></Hint>
        <span>{task.member_trail.length ? task.member_trail.join(' → ') : task.member_alias ?? '—'}</span>
        <span className="text-muted-foreground">{task.phase?.startsWith('queued:') ? `排队第 ${task.phase.slice(7)} 位` : PHASES[task.phase ?? task.status] ?? task.phase}</span>
        <span className={`tabular-nums ${preview ? 'text-muted-foreground' : 'text-primary'}`}>{preview ? date(task.updated_at) : `${Math.max(0, Math.floor((now - Date.parse(task.created_at)) / 1000))} 秒`}</span>
      </div>
      {task.kind !== 'text' && task.prompt && <Disclosure summary={<span className="truncate">{task.prompt}</span>} triggerClassName="w-full"><p className="whitespace-pre-wrap break-words pt-2">{task.prompt}</p></Disclosure>}
      {task.error && <p className="break-words text-destructive">{task.error}</p>}
      {preview && !gatewayAlias && task.outputs > 0 && <div className="flex flex-wrap gap-2">{task.output_types.map((mime, i) => {
        const src = gatewayOutputUrl(task.task_id, i);
        return mime.startsWith('video/') ? <video key={i} src={src} muted controls preload="metadata" className="h-24 max-w-full rounded-md" />
          : mime.startsWith('audio/') ? <audio key={i} src={src} controls preload="none" className="max-w-full" />
            : <Button key={i} variant="ghost" type="button" aria-label={`查看 ${task.key_name} 的产物 ${i + 1}`} onClick={() => setZoomed(src)} className="h-auto cursor-zoom-in p-0"><img src={src} alt={`${task.key_name} 的产物 ${i + 1}`} loading="lazy" className="size-24 rounded-md object-contain" /></Button>;
      })}</div>}
      </div></div>
    </li>;
  }
  const runningRows = [
    ...active.map(task => ({ task, leaving: false })),
    ...lingering.filter(row => !active.some(task => task.task_id === row.task.task_id)),
  ];
  return <section aria-label="网关任务" className="space-y-3">
    <h3 className="text-sm font-medium">运行中 {active.length > 0 && `· ${active.length}`}</h3>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <ul aria-label="运行中任务">{runningRows.map(item => row(item.task, false, item.leaving))}</ul>
    {!runningRows.length && <p className="text-xs text-muted-foreground">暂无运行中任务</p>}
    {/* 占位任务（已取消的提交）列出但不计数：统计里一律不含它们（第 6 批 6-2b）。 */}
    <Disclosure summary={`最近 24 小时 · ${recent.filter(task => !task.placeholder).length}`} triggerClassName="text-sm text-foreground"><ul>{recent.map(task => row(task, true))}</ul></Disclosure>
    {zoomed && <Lightbox src={zoomed} onClose={() => setZoomed(null)} />}
  </section>;
}
