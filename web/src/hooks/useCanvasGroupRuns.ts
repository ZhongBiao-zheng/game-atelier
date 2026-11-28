import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listGroupRuns, type GroupRun } from '@/api/canvasGroupRuns';

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
  const running = [...latest.values()].some(run => run.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, [refresh, running]);
  const steps = useMemo(() => {
    const result = new Map<string, GroupRun['steps'][number]>();
    for (const run of latest.values()) {
      if (run.status === 'cancelled' || run.status === 'done') continue;
      for (const step of run.steps) if (!result.has(step.node_id)) result.set(step.node_id, step);
    }
    return result;
  }, [latest]);
  return {latest, steps, refresh};
}
