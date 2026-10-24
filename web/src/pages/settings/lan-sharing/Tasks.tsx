import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGatewayTasks, gatewayOutputUrl, type GatewayTask } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { date } from './shared';

import { KindBadge } from '../usage/KindBadge';

export const isActive = (task: GatewayTask) => task.status === 'pending' || task.status === 'running';
export function mergeTask(rows: GatewayTask[], next: GatewayTask) {
  const old = rows.find(row => row.task_id === next.task_id);
  if (old && old.updated_at > next.updated_at) return rows;
  return [next, ...rows.filter(row => row.task_id !== next.task_id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
const PHASES: Record<string, string> = { queued: '排队', sent: '已提交', downloading: '下载中', pending: '排队', running: '生成中', done: '完成', failed: '失败', canceled: '已停止' };

export function Tasks({ onFinished }: { onFinished: () => void }) {
  const [active, setActive] = useState<GatewayTask[]>([]);
  const [recent, setRecent] = useState<GatewayTask[]>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const activeRef = useRef(active); activeRef.current = active;
  const finishedRef = useRef(onFinished); finishedRef.current = onFinished;
  const latest = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const version = epoch.current;
    try {
      const [running, finished] = await Promise.all([fetchGatewayTasks('active'), fetchGatewayTasks('recent')]);
      if (!mounted.current || version !== epoch.current) return;
      for (const row of [...running, ...finished]) latest.current.set(row.task_id, row.updated_at);
      if (activeRef.current.some(row => !running.some(next => next.task_id === row.task_id))) finishedRef.current();
      setActive(running); setRecent(finished); setError('');
    } catch (e) { if (mounted.current) setError(String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribeGatewayEvents({ onConnect: () => { void refresh(); }, onTask: task => {
    if ((latest.current.get(task.task_id) ?? '') > task.updated_at) return;
    latest.current.set(task.task_id, task.updated_at);
    epoch.current++;
    setActive(rows => mergeTask(rows, task).filter(isActive));
    if (!isActive(task)) { setRecent(rows => mergeTask(rows, task).slice(0, 200)); finishedRef.current(); }
  } }), [refresh]);
  const running = active.length > 0;
  useEffect(() => {
    if (!running) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void refresh(); }, 4000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [running, refresh]);
  function row(task: GatewayTask, preview = false) {
    return <li key={task.task_id} className="space-y-2 border-t border-border py-3 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <KindBadge kind={task.kind} /><span>{task.key_name}</span><span className="max-w-64 truncate" title={task.route_id}>{task.route_id}</span>
        <span>{task.member_trail.length ? task.member_trail.join(' → ') : task.member_alias ?? '—'}</span>
        <span className="text-muted-foreground">{PHASES[task.phase ?? task.status] ?? task.phase}</span>
        <span className={`tabular-nums ${preview ? 'text-muted-foreground' : 'text-primary'}`}>{preview ? date(task.updated_at) : `${Math.max(0, Math.floor((now - Date.parse(task.created_at)) / 1000))} 秒`}</span>
      </div>
      {task.kind !== 'text' && task.prompt && <details><summary className="cursor-pointer truncate text-muted-foreground">{task.prompt}</summary><p className="whitespace-pre-wrap break-words pt-2">{task.prompt}</p></details>}
      {task.error && <p className="break-words text-destructive">{task.error}</p>}
      {preview && task.outputs > 0 && <div className="flex flex-wrap gap-2">{task.output_types.map((mime, i) => {
        const src = gatewayOutputUrl(task.task_id, i);
        return mime.startsWith('video/') ? <video key={i} src={src} muted controls preload="metadata" className="h-24 max-w-full rounded-md" />
          : mime.startsWith('audio/') ? <audio key={i} src={src} controls preload="none" className="max-w-full" />
            : <a key={i} href={src} target="_blank" rel="noreferrer"><img src={src} alt={`${task.key_name} 的产物 ${i + 1}`} loading="lazy" className="size-24 rounded-md object-contain" /></a>;
      })}</div>}
    </li>;
  }
  return <section aria-label="网关任务" className="space-y-3">
    <h3 className="text-sm font-medium">运行中 {active.length > 0 && `· ${active.length}`}</h3>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <ul aria-label="运行中任务">{active.map(task => row(task))}</ul>
    {!active.length && <p className="text-xs text-muted-foreground">暂无运行中任务</p>}
    <details><summary className="cursor-pointer text-sm">最近 24 小时 · {recent.length}</summary><ul>{recent.map(task => row(task, true))}</ul></details>
  </section>;
}
