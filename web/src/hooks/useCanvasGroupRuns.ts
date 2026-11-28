import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listGroupRuns, type GroupRun } from '@/api/canvasGroupRuns';
import { MOTION_DURATION } from '@/lib/motion';

/** 跑完的一组在原位停留多久：勾停 1 秒再 fast 淡出，与 tokens.css 的 .group-run-finished 对齐。 */
const GROUP_RUN_FINISH_MS = 1000 + MOTION_DURATION.fast * 1000;

export function useCanvasGroupRuns(project: string, enabled: boolean) {
  const [runs, setRuns] = useState<GroupRun[]>([]);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++sequence.current;
    try {
      const rows = await listGroupRuns(project);
      if (id === sequence.current) setRuns(rows);
    } catch { /* Refresh again on reconnect or the next run event. */ }
  }, [project, enabled]);
  useEffect(() => {
    sequence.current++;
    setRuns([]);
    void refresh();
  }, [refresh]);
  const latest = useMemo(() => {
    const groups = new Map<string, GroupRun>();
    for (const run of runs) if (!groups.has(run.group_id)) groups.set(run.group_id, run);
    return groups;
  }, [runs]);
  // 本次会话里看着跑完的组：成员上的勾留到组的勾淡出之后再撤。
  const [finishing, setFinishing] = useState<ReadonlySet<string>>(() => new Set());
  const watched = useRef(new Set<string>());
  const finishTimers = useRef(new Set<number>());
  useEffect(() => () => { for (const timer of finishTimers.current) window.clearTimeout(timer); }, []);
  useEffect(() => {
    const ended: string[] = [];
    for (const run of latest.values()) {
      if (run.status === 'running') watched.current.add(run.run_id);
      else if (watched.current.delete(run.run_id) && run.status === 'done') ended.push(run.run_id);
    }
    if (!ended.length) return;
    setFinishing(current => new Set([...current, ...ended]));
    const timer = window.setTimeout(() => {
      finishTimers.current.delete(timer);
      setFinishing(current => new Set([...current].filter(id => !ended.includes(id))));
    }, GROUP_RUN_FINISH_MS);
    finishTimers.current.add(timer);
  }, [latest]);
  const running = [...latest.values()].some(run => run.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, [refresh, running]);
  const steps = useMemo(() => {
    const result = new Map<string, GroupRun['steps'][number]>();
    for (const run of latest.values()) {
      if (run.status === 'cancelled' || (run.status === 'done' && !finishing.has(run.run_id))) continue;
      for (const step of run.steps) if (!result.has(step.node_id)) result.set(step.node_id, step);
    }
    return result;
  }, [latest, finishing]);
  return {latest, steps, refresh};
}
